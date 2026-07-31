//! Talking to a running krit server: find it, fetch the diff, listen for
//! changes.
//!
//! Blocking I/O on purpose, on threads of its own. The server is async because
//! it fans out to many clients; a client has one connection and one screen, so
//! a thread parked on a socket is simpler than a runtime. Both the event
//! stream and the diff fetch live on their own threads for the same reason:
//! the draw loop must never be the thing waiting on the network, because a
//! loop that is waiting is a loop that is not redrawing and not reading keys.

use crate::comments::CommentAnchor;
use krit_core::state::{KritState, StateError, client_base_url, default_state_path, read_state_at};
use krit_core::types::ReviewComment;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

/// The state-file contract this client understands. `KritState.v` exists to
/// make a skewed pair diagnosable; a client that never reads it turns version
/// skew into a wrong-looking diff instead of a message.
const SUPPORTED_STATE_V: u8 = 2;

/// Enough for a loopback request that is only waiting on git, not enough to
/// hide a server that has stopped answering. Every request except the event
/// stream carries it — an untimed request on the fetch path used to be able to
/// park the whole viewer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// What `GET /api/diff` gives us. Phase 0 reads the patch and the two labels;
/// `fileContents` (hunk expansion) and `binaryFiles` are deliberately not
/// modelled yet — they belong to phase 2, and an unused field here would read
/// as support that isn't there.
///
/// `patch` deliberately has no `#[serde(default)]`. Tolerating fields we don't
/// model is right; defaulting the one field this client exists to read is not
/// — a renamed field would deserialize to an empty patch and render as a clean
/// review, which is exactly the "no changes" lie `/api/diff` returns 500 to
/// avoid telling.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub patch: String,
    #[serde(default)]
    pub repo_name: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub custom_mode: bool,
    #[serde(default)]
    pub untracked_files: Vec<String>,
}

/// The reviewer's settings, as both clients read them.
///
/// The defaults here are the server's shipped defaults, not the defaults
/// `/api/diff` applies to a request that omits the query parameters — those
/// are `false`, which no client ever wanted. Falling back to the shipped
/// values is what keeps a settings fetch failure from silently narrowing the
/// review.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub staged: bool,
    pub untracked: bool,
    pub tab_size: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            staged: true,
            untracked: true,
            tab_size: 4,
        }
    }
}

impl Settings {
    /// Read what we understand out of the settings object, leaving anything
    /// missing or malformed at the shipped default.
    pub fn from_json(value: &Value) -> Self {
        let fallback = Settings::default();
        Settings {
            staged: value["staged"].as_bool().unwrap_or(fallback.staged),
            untracked: value["untracked"].as_bool().unwrap_or(fallback.untracked),
            tab_size: value["defaultTabSize"]
                .as_u64()
                .map(|n| n.clamp(1, 16) as usize)
                .unwrap_or(fallback.tab_size),
        }
    }
}

/// Everything the draw loop reacts to, already stripped of the parts of the
/// wire it does not care about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerEvent {
    /// The diff may have changed. Deliberately not "which file": the TUI
    /// refetches the whole diff, so several of these collapse into one
    /// request — see `Refetch` in `main.rs`, which owns the quiet window, and
    /// `MAX_REFETCH_WAIT`, which is what stops a stream that never goes quiet
    /// from postponing the refetch forever.
    Changed,
    /// A comment was added, edited, resolved, re-anchored, or replied to. Like
    /// `Changed`, it names no id: the viewer refetches the list, which is one
    /// request either way and cannot drift from what the server holds.
    CommentsChanged,
    /// Who else is on this review. The count is what gates Done reviewing —
    /// finishing with nobody listening posts a `submitted` nothing receives.
    Listeners {
        count: usize,
    },
    Submitted {
        summary: Option<String>,
    },
    Ended {
        reason: String,
    },
    /// The stream closed for good — krit crashed or was killed, which is a
    /// different thing to say than "the review is over". Only sent once
    /// reconnecting has failed.
    Disconnected,
}

/// Anything a background thread hands the draw loop. One channel for all of
/// them, so the loop has a single place to drain and no ordering surprises.
#[derive(Clone, Debug)]
pub enum Incoming {
    Event(ServerEvent),
    /// A refetch the loop asked for, finished. `Err` keeps the last good diff
    /// on screen and puts the message in the strip.
    Diff(Box<Result<DiffPayload, String>>),
    Comments(Box<Result<Vec<ReviewComment>, String>>),
    /// A write the reviewer asked for, finished — posting a comment, a reply,
    /// a status change. `Ok` carries what to say about it; the refetch that
    /// makes it visible is driven by the server's own broadcast, not by this.
    Done {
        result: Box<Result<String, String>>,
        /// Which composer sent this, if one did — so a failure can leave that
        /// form up with the reviewer's text still in it, and an answer meant
        /// for a form the reviewer has already left cannot close the one they
        /// are typing in now. `None` for a write with no form behind it
        /// (resolve, post-queued).
        composer: Option<u64>,
    },
}

/// What the worker thread can be asked for. Requests of the same kind
/// coalesce; a write never does, because two of them are two different things
/// the reviewer asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fetch {
    Diff,
    Comments,
}

/// How we got a server, because it changes what the reviewer should be told:
/// a server that was already running keeps its own diff range, so a `--` range
/// on our command line was ignored and saying so is the only way they'd know.
/// Neither variant means anything at quit — a server we started is left to its
/// own idle timeout on purpose (`docs/design/tui.md`), because killing it
/// would be wrong whenever a browser tab is attached too.
pub enum Attached {
    Adopted { base: String, settings: Settings },
    Started { base: String, settings: Settings },
}

impl Attached {
    pub fn base(&self) -> &str {
        match self {
            Attached::Adopted { base, .. } | Attached::Started { base, .. } => base,
        }
    }

    pub fn settings(&self) -> Settings {
        match self {
            Attached::Adopted { settings, .. } | Attached::Started { settings, .. } => *settings,
        }
    }

    pub fn adopted(&self) -> bool {
        matches!(self, Attached::Adopted { .. })
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
}

/// Ask a server at `base` for its settings. `Some` means something answered
/// with a settings object we could read; that is the liveness check as well as
/// the settings fetch, so the adopt path pays for one request rather than two.
///
/// It is not an identity check: nothing in the response says "krit". Requiring
/// the object to parse and to carry a key we know rules out a wrong-port
/// answer from most things, but a state file naming a port some other krit has
/// since taken would still pass — which is why `attach` also checks the
/// recorded pid.
fn probe(base: &str) -> Option<Settings> {
    let value: Value = agent(PROBE_TIMEOUT)
        .get(&format!("{base}/api/settings"))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    value.get("defaultTabSize")?;
    Some(Settings::from_json(&value))
}

/// Is the process that wrote this state file still around?
///
/// Signal 0 performs the permission and existence checks without delivering
/// anything. A pid can be recycled, so this is only ever used to refuse to act
/// — never to conclude that a server is healthy.
fn pid_is_alive(pid: u32) -> bool {
    // SAFETY: `kill` with signal 0 sends nothing; it is the documented way to
    // ask whether a pid exists, and cannot affect the target either way.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Find a server for this review, or start one.
///
/// This is what makes `krit-tui` a single command in a single shell: the
/// common case is that no server is running, and requiring the reviewer to
/// start one in another pane first is most of the friction of using it at all.
/// A server that was already running is adopted rather than duplicated — state
/// is keyed by worktree and branch, and two servers would share one comment
/// store, where each save rewrites the whole file and silently drops the
/// other's comments.
pub fn attach(diff_args: &[String]) -> Result<Attached, String> {
    let state_path = default_state_path();
    match read_state_at(&state_path) {
        Ok(state) => {
            let base = client_base_url(&state);
            if let Some(settings) = probe(&base) {
                warn_on_version_skew(&state);
                return Ok(Attached::Adopted { base, settings });
            }
            // A state file outlives a server that crashed — nothing cleans it
            // up but the server's own shutdown — so an unanswered probe
            // usually means "start one". But if the pid it names is still
            // alive, something is there and simply not answering, and starting
            // a second server on the same comment store is the one outcome
            // worse than reporting it.
            if pid_is_alive(state.pid) {
                return Err(format!(
                    "A krit server for this review (pid {}) is running but not answering at {}.\n\
                     Stop it and try again, or delete {} if the pid has been reused.",
                    state.pid,
                    base,
                    state_path.display()
                ));
            }
        }
        Err(StateError::Missing(_)) => {}
        // Unreadable or malformed is a configuration problem, not an absence:
        // starting a second server on top of one that may well be running is
        // the wrong guess to make on the reviewer's behalf.
        Err(other) => return Err(other.lines().join("\n")),
    }

    // Only one of us may start a server for this review. The pid check above
    // catches a server that already exists; this catches the other half —
    // two viewers launched together, both seeing no state file, both
    // spawning. The loser's `write_state` would then depose the winner's, and
    // two servers on one comment store each rewrite the whole file from their
    // own memory, so whichever saves last silently drops the other's comments.
    match StartLock::acquire(&state_path) {
        Some(lock) => {
            let started = start_server(diff_args, &state_path);
            drop(lock);
            started
        }
        None => adopt_the_server_someone_else_is_starting(&state_path),
    }
}

/// A lock nobody has to clean up by hand: `create_new` refuses if it exists,
/// `Drop` removes it, and one left behind by a killed process is ignored once
/// it is old enough to be certainly dead.
struct StartLock(PathBuf);

const STALE_LOCK_AFTER: Duration = Duration::from_secs(60);

impl StartLock {
    fn acquire(state_path: &Path) -> Option<Self> {
        let path = state_path.with_extension("start-lock");
        for _ in 0..2 {
            match std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
            {
                Ok(_) => return Some(StartLock(path)),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .map(|t| t.elapsed().unwrap_or_default() > STALE_LOCK_AFTER)
                        .unwrap_or(false);
                    if !stale {
                        return None;
                    }
                    let _ = std::fs::remove_file(&path);
                }
                // Can't lock (read-only dir, say). Starting unlocked is worse
                // than not starting, so treat it as held.
                Err(_) => return None,
            }
        }
        None
    }
}

impl Drop for StartLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Wait out the viewer that holds the start lock, then use its server.
fn adopt_the_server_someone_else_is_starting(state_path: &Path) -> Result<Attached, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(state) = read_state_at(state_path) {
            let base = client_base_url(&state);
            if let Some(settings) = probe(&base) {
                warn_on_version_skew(&state);
                return Ok(Attached::Adopted { base, settings });
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "Another krit-tui is starting a server for this review but it never came up.\n\
         If nothing else is running, delete {}.",
        state_path.with_extension("start-lock").display()
    ))
}

/// A skewed pair fails as a wrong-looking diff rather than as an error — the
/// tolerant reader absorbs a renamed field, and `classify`'s default arm
/// absorbs a renamed event. `v` is the one signal that can say so out loud.
/// A warning rather than a refusal: the shapes are mostly compatible, and
/// refusing to open a review over a version byte would be worse than showing
/// one with a caveat.
fn warn_on_version_skew(state: &KritState) {
    if state.v > SUPPORTED_STATE_V {
        eprintln!(
            "krit-tui: this krit server speaks state contract v{} and this client knows v{}. \
             Some of the review may not render correctly; upgrade krit-tui.",
            state.v, SUPPORTED_STATE_V
        );
    }
}

/// The `krit` next to this binary, falling back to `PATH`.
///
/// Sibling first so a build run out of `target/debug` spawns *its* server
/// rather than whatever happens to be installed — otherwise a change to the
/// wire looks like it works while the two halves are different versions.
fn krit_binary() -> PathBuf {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("krit");
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from("krit")
}

/// A file only this invocation can be writing.
///
/// `create_new` is `O_CREAT|O_EXCL`, which refuses to follow a symlink and
/// refuses an existing file — so a predictable name in a shared `/tmp` cannot
/// be aimed at something the invoking user owns. The name still carries the
/// pid, for anyone reading it over our shoulder while the server starts.
fn create_log(dir: &Path, pid: u32) -> std::io::Result<(PathBuf, std::fs::File)> {
    for attempt in 0..64 {
        let path = dir.join(if attempt == 0 {
            format!("krit-tui-{pid}.log")
        } else {
            format!("krit-tui-{pid}-{attempt}.log")
        });
        match std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::other("no free log filename"))
}

/// Reap a child we are done supervising.
///
/// Dropping a `Child` does not wait for it on Unix, and the viewer deliberately
/// outlives the review — so a server that exits first (idle shutdown, a submit,
/// a crash) would sit as `<defunct>` for as long as the reviewer keeps reading.
fn reap(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

fn start_server(diff_args: &[String], state_path: &Path) -> Result<Attached, String> {
    let exe = krit_binary();
    let log_dir = std::env::var_os("CLAUDE_TMPDIR")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(std::env::temp_dir);

    // The server's own stdout would land on top of the viewer, so it goes to
    // a file — which is also the only thing we can quote back if it dies
    // before writing a state file ("not a git repository", a typo'd rev).
    let (log_path, log) = create_log(&log_dir, std::process::id())
        .map_err(|e| format!("cannot open a log for the server: {e}"))?;
    let errors = log
        .try_clone()
        .map_err(|e| format!("cannot open a log for the server: {e}"))?;

    let mut cmd = Command::new(&exe);
    cmd.arg("--no-open");
    // Named rather than left to krit's default, because `KRIT_IDLE_TIMEOUT_MS`
    // in the reviewer's environment would otherwise silently override it —
    // and this client's help text promises the server it starts goes away on
    // its own. A lifetime we promise is a lifetime we should set. 5s is krit's
    // own default: long enough to survive restarting the viewer, short enough
    // that a forgotten server isn't still holding the port an hour later.
    cmd.args(["--idle-timeout", "5000"]);
    if !diff_args.is_empty() {
        cmd.arg("--");
        cmd.args(diff_args);
    }
    cmd.stdin(Stdio::null()).stdout(log).stderr(errors);

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "cannot start {}: {e}\nInstall it alongside krit-tui, or start `krit` yourself first.",
            exe.display()
        )
    })?;
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(15);

    loop {
        match read_state_at(state_path) {
            // Matched on pid, not merely on the file existing: a stale state
            // file from a crashed server is one of the cases that got us here,
            // and adopting it would hand us the dead port we just rejected.
            Ok(state) if state.pid == pid => {
                let base = client_base_url(&state);
                let settings = probe(&base).unwrap_or_default();
                warn_on_version_skew(&state);
                // Only now: while the server was starting, the log was the
                // only record of why it might not.
                let _ = std::fs::remove_file(&log_path);
                reap(child);
                return Ok(Attached::Started { base, settings });
            }
            // Someone else's state file, or our own not written yet. `Invalid`
            // is deliberately not fatal here: `write_state` is a plain
            // `fs::write`, so a poll can catch it mid-write, and `attach` has
            // already screened a genuinely malformed pre-existing file.
            Ok(_) | Err(_) => {}
        }
        if let Ok(Some(status)) = child.try_wait() {
            let output = std::fs::read_to_string(&log_path).unwrap_or_default();
            let detail = output.trim().to_string();
            let _ = std::fs::remove_file(&log_path);
            return Err(if detail.is_empty() {
                format!("krit exited ({status}) without saying why")
            } else {
                format!("krit could not start:\n{detail}")
            });
        }
        if Instant::now() > deadline {
            // SIGTERM first: the server removes its state file and closes its
            // streams on the way out, and SIGKILL would leave both behind for
            // the next client to trip over.
            terminate(&mut child);
            reap(child);
            return Err(format!(
                "krit started but wrote no state file within 15s — see {}",
                log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn terminate(child: &mut Child) {
    // SAFETY: SIGTERM to a pid we own and have not yet reaped.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

pub fn fetch_diff(base: &str, settings: Settings) -> Result<DiffPayload, String> {
    // The parameters are not optional in practice: `/api/diff` reads a missing
    // `staged`/`untracked` as **false**, which is a view no client ever chose
    // — the browser sends the reviewer's settings and the shipped defaults are
    // both true. Omitting them hides staged work and every untracked file,
    // silently, and the two clients then disagree about what the review is.
    let url = format!(
        "{base}/api/diff?staged={}&untracked={}",
        settings.staged, settings.untracked
    );
    match agent(REQUEST_TIMEOUT).get(&url).call() {
        Ok(res) => res
            .into_json::<DiffPayload>()
            .map_err(|e| format!("krit sent a diff this client can't read: {e}")),
        Err(ureq::Error::Status(code, res)) => {
            // The diff route 500s with a JSON `error` when git itself failed
            // (a typo'd ref, an unreadable object). That message is the useful
            // one — the status alone would send someone looking at the server.
            let body = res.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_string))
                .unwrap_or(body);
            Err(format!("krit returned {code}: {detail}"))
        }
        Err(err) => Err(format!("cannot reach krit at {url}: {err}")),
    }
}

/// Every comment on the review, the reviewer's own queued ones included.
///
/// `includeQueued=true` for the same reason the browser sends it: a queued
/// comment is the reviewer's unposted work, and this is a reviewer's client.
/// The parameter exists to keep *agent-facing* listings from leaking it.
pub fn fetch_comments(base: &str) -> Result<Vec<ReviewComment>, String> {
    let url = format!("{base}/api/comments?includeQueued=true");
    match agent(REQUEST_TIMEOUT).get(&url).call() {
        Ok(res) => res
            .into_json::<Vec<ReviewComment>>()
            .map_err(|e| format!("krit sent comments this client can't read: {e}")),
        Err(err) => Err(format!("cannot read comments: {err}")),
    }
}

/// Run fetches on a thread, so the draw loop only ever asks and listens.
///
/// Returns the handle to ask on. Requests of one kind coalesce: whatever
/// arrived while a fetch was in flight becomes one more fetch, not a queue of
/// them. The two kinds are tracked separately — a burst of file writes must
/// not turn into a comment refetch, and a burst of comment traffic must not
/// re-run `git diff`.
pub fn spawn_fetcher(base: String, settings: Settings, tx: Sender<Incoming>) -> Sender<Fetch> {
    let (request_tx, request_rx): (Sender<Fetch>, Receiver<Fetch>) = channel();
    std::thread::spawn(move || {
        while let Ok(first) = request_rx.recv() {
            let mut diff = first == Fetch::Diff;
            let mut comments = first == Fetch::Comments;
            // Collapse anything that piled up behind this one.
            while let Ok(more) = request_rx.try_recv() {
                diff |= more == Fetch::Diff;
                comments |= more == Fetch::Comments;
            }
            if diff {
                let result = fetch_diff(&base, settings);
                if tx.send(Incoming::Diff(Box::new(result))).is_err() {
                    return; // the viewer is gone
                }
            }
            if comments {
                let result = fetch_comments(&base);
                if tx.send(Incoming::Comments(Box::new(result))).is_err() {
                    return;
                }
            }
        }
    });
    request_tx
}

/// A change the reviewer asked for.
///
/// Every one of these is a request the browser makes too, on the same route
/// with the same shape — the server is the whole review model and neither
/// client has state of its own to keep in step. What comes back is a sentence
/// for the strip; what makes the change *visible* is the server's own
/// broadcast, which arrives as a `CommentsChanged` like anyone else's.
#[derive(Clone, Debug)]
pub enum Write {
    Comment {
        anchor: Box<CommentAnchor>,
        body: String,
        queued: bool,
    },
    Reply {
        id: String,
        body: String,
    },
    Status {
        id: String,
        status: &'static str,
    },
    PostQueued,
    Submit {
        summary: Option<String>,
    },
}

impl Write {
    fn request(&self, base: &str) -> (String, Value) {
        match self {
            Write::Comment {
                anchor,
                body,
                queued,
            } => {
                let mut payload = json!({
                    "filePath": anchor.file_path,
                    "side": anchor.side,
                    "lineNumber": anchor.start_line,
                    "endLine": anchor.end_line,
                    "lineContent": anchor.line_content,
                    "body": body,
                    "status": if *queued { "queued" } else { "open" },
                });
                // All three or none: the server reads a partial character
                // anchor as no anchor at all, which would silently widen the
                // comment to the whole line.
                if let Some((start, end, text)) = &anchor.columns {
                    payload["startColumn"] = json!(start);
                    payload["endColumn"] = json!(end);
                    payload["selectedText"] = json!(text);
                }
                (format!("{base}/api/comments"), payload)
            }
            // `source=ui` is what marks this a human's reply: the server
            // labels it `author: "user"`, broadcasts it to the agent, and
            // reopens the comment if it had been resolved. Without it a
            // reviewer's reply is filed as the agent's own and never reaches
            // it — the parameter is not a formality.
            Write::Reply { id, body } => (
                format!("{base}/api/comments/{id}/replies?source=ui"),
                json!({ "body": body }),
            ),
            Write::Status { id, status } => (
                format!("{base}/api/comments/{id}"),
                json!({ "status": status }),
            ),
            Write::PostQueued => (format!("{base}/api/queued/post"), json!({})),
            Write::Submit { summary } => {
                (format!("{base}/api/submit"), json!({ "summary": summary }))
            }
        }
    }

    /// What to say in the strip when it worked.
    fn note(&self, response: &Value) -> String {
        match self {
            Write::Comment { queued: true, .. } => "Comment queued.".to_string(),
            Write::Comment { .. } => "Comment posted.".to_string(),
            Write::Reply { .. } => "Reply posted.".to_string(),
            Write::Status {
                status: "resolved", ..
            } => "Resolved.".to_string(),
            Write::Status { .. } => "Reopened.".to_string(),
            Write::PostQueued => match response["posted"].as_u64().unwrap_or(0) {
                1 => "1 queued comment posted.".to_string(),
                n => format!("{n} queued comments posted."),
            },
            Write::Submit { .. } => "Review submitted.".to_string(),
        }
    }
}

/// Send one write, on a thread of its own.
///
/// A thread each rather than a queue: writes are rare — a keystroke does not
/// write — and putting them behind the fetcher would make posting a comment
/// wait out whatever `git diff` was doing. Two writes racing is two things the
/// reviewer asked for, and the server orders them.
pub fn spawn_write(base: String, write: Write, composer: Option<u64>, tx: Sender<Incoming>) {
    std::thread::spawn(move || {
        let _ = tx.send(Incoming::Done {
            result: Box::new(send(&base, &write)),
            composer,
        });
    });
}

fn send(base: &str, write: &Write) -> Result<String, String> {
    let (url, payload) = write.request(base);
    // The verb is decided here rather than by amending a request already built
    // as a POST: the status route is a PUT, and two of these are not
    // interchangeable.
    let request = match write {
        Write::Status { .. } => agent(REQUEST_TIMEOUT).put(&url),
        _ => agent(REQUEST_TIMEOUT).post(&url),
    };
    let response = request.send_json(payload);
    match response {
        Ok(res) => {
            let value: Value = res.into_json().unwrap_or(Value::Null);
            Ok(write.note(&value))
        }
        // The server's own message, not the status code: it says which field
        // was rejected, and 400 alone sends someone reading server source.
        Err(ureq::Error::Status(code, res)) => {
            let body = res.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_string))
                .unwrap_or(body);
            Err(format!("krit refused this ({code}): {detail}"))
        }
        Err(err) => Err(format!("cannot reach krit: {err}")),
    }
}

/// Pull every complete SSE frame out of `buf` and classify it. Split out from
/// the socket loop because the framing is the part that can be wrong: a frame
/// spans as many reads as the kernel feels like, and a keep-alive comment
/// looks exactly like a frame with nothing in it.
pub fn drain_frames(buf: &mut Vec<u8>) -> Vec<ServerEvent> {
    let mut out = Vec::new();
    while let Some(idx) = buf.windows(2).position(|w| w == b"\n\n") {
        let frame = String::from_utf8_lossy(&buf[..idx]).into_owned();
        buf.drain(..idx + 2);
        let data: String = frame
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue; // keep-alive
        }
        if let Ok(value) = serde_json::from_str::<Value>(&data)
            && let Some(event) = classify(&value)
        {
            out.push(event);
        }
    }
    out
}

/// One event frame to what the viewer does about it.
///
/// This stream is the UI's, not the agent's: `/api/events` carries everything,
/// including the fs-watcher's batched `files-changed` and the reanchor
/// fallout that `/api/events-ws` filters out. That is correct for a human's
/// client and it is why the debouncing is the client's job.
///
/// The tags are `krit_core::types::Event`'s, and `event_tags_match_the_wire`
/// below runs the real enum through serde to prove these strings still match —
/// a renamed variant would otherwise land in the default arm and stop live
/// refresh with nothing to see.
fn classify(value: &Value) -> Option<ServerEvent> {
    match value["type"].as_str()? {
        // `krit refresh` has no event of its own — it broadcasts
        // `file-written` with a null path, which is exactly what it means.
        "files-changed" | "file-changed" | "file-written" => Some(ServerEvent::Changed),
        // Comment traffic, including the re-anchor fallout `/api/events-ws`
        // filters out of the agent's stream. A comment whose line moved under
        // an edit has to move on screen too, so the noisy stream is the right
        // one for a human's client.
        "comment-added" | "comment-updated" | "reply-added" => Some(ServerEvent::CommentsChanged),
        // Watchers, not browsers: `clients` counts UI subscriptions (and this
        // viewer is one of them), while `state` separates them from agents.
        // Done reviewing needs *someone listening on the agent side*, which
        // only `state` can answer.
        "state" => Some(ServerEvent::Listeners {
            count: (value["watcherCount"].as_u64().unwrap_or(0)
                + value["agentCount"].as_u64().unwrap_or(0)) as usize,
        }),
        "submitted" => Some(ServerEvent::Submitted {
            summary: value["summary"].as_str().map(str::to_string),
        }),
        "review-ended" => Some(ServerEvent::Ended {
            reason: value["reason"].as_str().unwrap_or("unknown").to_string(),
        }),
        // clients / user-edit: nothing the viewer does about them. Both edit
        // routes broadcast `file-changed` immediately before `user-edit`, so
        // the refetch is already covered and reacting to both would double it.
        _ => None,
    }
}

/// How long to wait before trying the event stream again, and how many times.
///
/// A dropped stream is not the same as a dead server, and treating it that way
/// is worse here than in the browser: the TUI subscribes as `role=ui`, so
/// losing it arms the server's 5s idle shutdown — which would make our own
/// "krit crashed" message come true a moment after we printed it. `EventSource`
/// reconnects for the web UI and the idle window is sized for that; this is
/// the same behavior, spelled out.
const RECONNECT_DELAYS: [Duration; 4] = [
    Duration::from_millis(200),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

/// Subscribe to the event stream on a thread of its own, forwarding to `tx`
/// until the review ends or reconnecting gives up. Sends exactly one terminal
/// event (`Ended` or `Disconnected`) so the draw loop always learns why it
/// stopped.
///
/// `role=ui` rather than `cli`: this is a human's client, so it must hold the
/// server open the way a browser tab does. A `cli` subscription would let the
/// idle timeout fire with the review still on screen.
pub fn spawn_events(base: &str, tx: Sender<Incoming>) {
    let url = format!("{base}/api/events?role=ui");
    std::thread::spawn(move || {
        let mut attempt = 0usize;
        loop {
            match stream_once(&url, &tx) {
                StreamOutcome::Ended | StreamOutcome::ViewerGone => return,
                StreamOutcome::Dropped { delivered } => {
                    // Any frame at all means the connection worked, so the
                    // next drop starts its own backoff rather than inheriting
                    // the last one's.
                    if delivered {
                        attempt = 0;
                    }
                    match RECONNECT_DELAYS.get(attempt) {
                        Some(delay) => {
                            attempt += 1;
                            std::thread::sleep(*delay);
                        }
                        None => {
                            let _ = tx.send(Incoming::Event(ServerEvent::Disconnected));
                            return;
                        }
                    }
                }
            }
        }
    });
}

enum StreamOutcome {
    /// A `review-ended` frame: the review is over, nothing to reconnect to.
    Ended,
    /// The connection failed or closed. `delivered` is whether this attempt
    /// ever got a frame.
    Dropped {
        delivered: bool,
    },
    ViewerGone,
}

fn stream_once(url: &str, tx: &Sender<Incoming>) -> StreamOutcome {
    // No overall timeout: the stream is meant to stay open for the life of the
    // review. The connect timeout still applies, so an unreachable server
    // fails fast instead of hanging the retry loop.
    let request = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .build()
        .get(url)
        .set("Accept", "text/event-stream");
    let res = match request.call() {
        Ok(res) => res,
        Err(_) => return StreamOutcome::Dropped { delivered: false },
    };
    let mut reader = res.into_reader();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut delivered = false;

    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return StreamOutcome::Dropped { delivered },
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                for event in drain_frames(&mut buf) {
                    delivered = true;
                    let terminal = matches!(event, ServerEvent::Ended { .. });
                    if tx.send(Incoming::Event(event)).is_err() {
                        return StreamOutcome::ViewerGone;
                    }
                    if terminal {
                        return StreamOutcome::Ended;
                    }
                }
            }
            // A signal can interrupt a blocking read; that is not the stream
            // ending, and treating it as one would drop live refresh on the
            // first Ctrl+Z.
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return StreamOutcome::Dropped { delivered },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use krit_core::types::{CommentReply, Event, ReviewComment};

    fn frames(s: &str) -> Vec<ServerEvent> {
        let mut buf = s.as_bytes().to_vec();
        drain_frames(&mut buf)
    }

    #[test]
    fn a_frame_split_across_reads_is_held_until_it_is_whole() {
        // The socket hands over whatever arrived, not whole frames. Parsing a
        // half frame would drop the event entirely.
        let mut buf = Vec::new();
        buf.extend_from_slice(b"data: {\"type\":\"files-cha");
        assert!(drain_frames(&mut buf).is_empty());
        buf.extend_from_slice(b"nged\",\"paths\":[\"a.rs\"]}\n\n");
        assert_eq!(drain_frames(&mut buf), vec![ServerEvent::Changed]);
        assert!(buf.is_empty(), "a consumed frame leaves nothing behind");
    }

    #[test]
    fn several_frames_in_one_read_all_come_out_in_order() {
        let events = frames(
            "data: {\"type\":\"file-written\",\"path\":\"a.rs\"}\n\n\
             data: {\"type\":\"submitted\",\"timestamp\":7,\"summary\":\"ship it\"}\n\n\
             data: {\"type\":\"review-ended\",\"reason\":\"idle\"}\n\n",
        );
        assert_eq!(
            events,
            vec![
                ServerEvent::Changed,
                ServerEvent::Submitted {
                    summary: Some("ship it".to_string())
                },
                ServerEvent::Ended {
                    reason: "idle".to_string()
                },
            ]
        );
    }

    #[test]
    fn a_keep_alive_is_not_an_event() {
        // axum sends these to hold the connection open; treating one as a
        // change would refetch the whole diff every keep-alive interval.
        assert!(frames(": ping\n\n").is_empty());
        assert!(frames("\n\n").is_empty());
    }

    #[test]
    fn a_submit_with_no_notes_is_distinguishable_from_empty_notes() {
        // `summary` is optional and its absence is meaningful — finishing with
        // nothing to add is a normal ending.
        assert_eq!(
            frames("data: {\"type\":\"submitted\",\"timestamp\":1}\n\n"),
            vec![ServerEvent::Submitted { summary: None }]
        );
        assert_eq!(
            frames("data: {\"type\":\"submitted\",\"timestamp\":1,\"summary\":\"\"}\n\n"),
            vec![ServerEvent::Submitted {
                summary: Some(String::new())
            }]
        );
    }

    #[test]
    fn presence_traffic_is_never_mistaken_for_a_reason_to_refetch() {
        // `state` and `clients` arrive constantly. `state` is presence — it
        // must move the watcher count and nothing else; `clients` counts UI
        // subscriptions, which includes this viewer, and answers no question
        // the TUI asks.
        assert_eq!(
            frames(
                "data: {\"type\":\"state\",\"watcherCount\":1,\"uiCount\":3,\"agentCount\":2}\n\n"
            ),
            vec![ServerEvent::Listeners { count: 3 }],
            "watchers plus agents, and never the UI count — this client is one"
        );
        assert!(frames("data: {\"type\":\"clients\",\"browsers\":2}\n\n").is_empty());
    }

    #[test]
    fn comment_traffic_refetches_the_list_rather_than_naming_an_id() {
        // Including `comment-updated`, which is re-anchor fallout the agent's
        // stream filters out: a comment whose line moved under an edit has to
        // move on screen too.
        assert_eq!(
            frames(
                "data: {\"type\":\"comment-added\",\"comment\":{}}\n\n\
                 data: {\"type\":\"comment-updated\",\"comment\":{}}\n\n\
                 data: {\"type\":\"reply-added\",\"commentId\":\"i\"}\n\n"
            ),
            vec![
                ServerEvent::CommentsChanged,
                ServerEvent::CommentsChanged,
                ServerEvent::CommentsChanged
            ]
        );
    }

    #[test]
    fn a_frame_that_is_not_json_does_not_take_the_stream_down_with_it() {
        let events =
            frames("data: not json\n\ndata: {\"type\":\"file-changed\",\"path\":\"a\"}\n\n");
        assert_eq!(events, vec![ServerEvent::Changed]);
    }

    fn comment() -> ReviewComment {
        ReviewComment {
            id: "i".into(),
            file_path: "f".into(),
            side: "additions".into(),
            line_number: 1,
            end_line: None,
            line_content: String::new(),
            body: String::new(),
            status: "open".into(),
            created_at: 0,
            replies: Vec::new(),
            outdated: None,
            suggestion: None,
            start_column: None,
            end_column: None,
            selected_text: None,
        }
    }

    /// The tags `classify` matches are generated by an enum this crate links,
    /// so a rename can be caught here rather than discovered as live refresh
    /// quietly not working. Every variant is listed on purpose: a new one
    /// fails to compile until someone decides what the viewer does about it.
    #[test]
    fn event_tags_match_the_wire() {
        let cases: Vec<(Event, Option<ServerEvent>)> = vec![
            (
                Event::FilesChanged {
                    paths: vec!["a.rs".into()],
                },
                Some(ServerEvent::Changed),
            ),
            (
                Event::FileChanged {
                    path: "a.rs".into(),
                },
                Some(ServerEvent::Changed),
            ),
            (
                Event::FileWritten { path: None },
                Some(ServerEvent::Changed),
            ),
            (
                Event::Submitted {
                    timestamp: 1,
                    summary: Some("done".into()),
                },
                Some(ServerEvent::Submitted {
                    summary: Some("done".into()),
                }),
            ),
            (
                Event::ReviewEnded {
                    reason: krit_core::types::EndReason::Idle,
                },
                Some(ServerEvent::Ended {
                    reason: "idle".into(),
                }),
            ),
            (
                Event::State {
                    watcher_count: 1,
                    ui_count: 1,
                    agent_count: 1,
                },
                Some(ServerEvent::Listeners { count: 2 }),
            ),
            (Event::Clients { browsers: 1 }, None),
            (
                Event::CommentAdded { comment: comment() },
                Some(ServerEvent::CommentsChanged),
            ),
            (
                Event::CommentUpdated { comment: comment() },
                Some(ServerEvent::CommentsChanged),
            ),
            (
                Event::ReplyAdded {
                    comment_id: "i".into(),
                    reply: CommentReply {
                        id: "r".into(),
                        body: String::new(),
                        created_at: 0,
                        author: None,
                    },
                    comment_status: "open".into(),
                },
                Some(ServerEvent::CommentsChanged),
            ),
            (
                Event::UserEdit {
                    action: "delete".into(),
                    file_path: "a.rs".into(),
                    range: None,
                    deleted_text: None,
                    inserted_text: None,
                },
                None,
            ),
        ];

        for (event, expected) in cases {
            let value = serde_json::to_value(&event).expect("events serialize");
            assert_eq!(
                classify(&value),
                expected,
                "tag {:?} classified wrongly",
                value["type"]
            );
        }
    }

    #[test]
    fn a_diff_payload_tolerates_fields_this_client_does_not_model() {
        // The server sends fileContents and binaryFiles too; phase 0 ignores
        // them, and must not fail to parse because of them.
        let payload: DiffPayload = serde_json::from_str(
            r#"{"patch":"p","repoName":"krit","branch":"main","customMode":false,
                "untrackedFiles":["new.txt"],"binaryFiles":[],"fileContents":{"a":{"old":{},"new":{}}}}"#,
        )
        .expect("parses");
        assert_eq!(payload.patch, "p");
        assert_eq!(payload.branch, "main");
        assert_eq!(payload.untracked_files, vec!["new.txt"]);
    }

    #[test]
    fn a_payload_with_no_patch_is_an_error_not_an_empty_review() {
        // An empty diff and a diff we failed to read look identical on screen,
        // which is why the server 500s rather than serving an empty patch. The
        // client has to hold up the same end.
        let err = serde_json::from_str::<DiffPayload>(r#"{"repoName":"krit"}"#)
            .expect_err("a missing patch is not a default");
        assert!(err.to_string().contains("patch"), "{err}");
    }

    #[test]
    fn settings_fall_back_to_the_servers_shipped_defaults_not_to_the_routes() {
        // `/api/diff` reads a missing staged/untracked as false. If a settings
        // fetch fails we must not inherit *that* — the shipped defaults are
        // both true, and they are what the browser sends.
        let fallback = Settings::from_json(&serde_json::json!({}));
        assert_eq!(
            fallback,
            Settings {
                staged: true,
                untracked: true,
                tab_size: 4
            }
        );

        let set = Settings::from_json(&serde_json::json!({
            "staged": false, "untracked": false, "defaultTabSize": 2
        }));
        assert_eq!(
            set,
            Settings {
                staged: false,
                untracked: false,
                tab_size: 2
            }
        );
    }

    #[test]
    fn an_absurd_tab_size_is_clamped_rather_than_trusted() {
        // The setting is reviewer-editable JSON; a huge one would make every
        // expanded line unreadably wide.
        assert_eq!(
            Settings::from_json(&serde_json::json!({"defaultTabSize": 4000})).tab_size,
            16
        );
        assert_eq!(
            Settings::from_json(&serde_json::json!({"defaultTabSize": 0})).tab_size,
            1
        );
    }
}
