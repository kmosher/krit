//! Talking to a running krit server: find it, fetch the diff, listen for
//! changes.
//!
//! Blocking I/O on purpose. The server is async because it fans out to many
//! clients; a client has one connection and one screen, so a thread parked on
//! a socket is simpler than a runtime, and the event stream lives on its own
//! thread precisely so the draw loop never waits on the network.

use krit_core::state::{StateError, default_state_path, read_state_at};
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

/// What `GET /api/diff` gives us. Phase 0 reads the patch and the two labels;
/// `fileContents` (hunk expansion) and `binaryFiles` are deliberately not
/// modelled yet — they belong to phase 2, and an unused field here would read
/// as support that isn't there.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    #[serde(default)]
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

/// Everything the draw loop reacts to, already stripped of the parts of the
/// wire it does not care about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerEvent {
    /// The diff may have changed. Deliberately not "which file": the TUI
    /// refetches the whole diff, so several of these collapse into one
    /// request (see the debounce in `app`).
    Changed,
    Submitted {
        summary: Option<String>,
    },
    Ended {
        reason: String,
    },
    /// The stream closed without a `review-ended` — krit crashed or was
    /// killed, which is a different thing to say than "the review is over".
    Disconnected,
}

/// 127.0.0.1 → localhost, for the same reason the CLI verbs do it: sandbox
/// host allowlists accept only the name.
fn localhost(url: &str) -> String {
    url.replace("://127.0.0.1", "://localhost")
}

/// How we got a server, because it changes what the reviewer should be told —
/// and, for a server we started, what happens when they quit.
pub enum Attached {
    Adopted(String),
    Started(String),
}

impl Attached {
    pub fn base(&self) -> &str {
        match self {
            Attached::Adopted(base) | Attached::Started(base) => base,
        }
    }
}

/// Find a server for this review, or start one.
///
/// This is what makes `krit-tui` a single command in a single shell: the
/// common case is that no server is running, and requiring the reviewer to
/// start one in another pane first is most of the friction of using it at
/// all. A server that was already running is adopted rather than duplicated —
/// state is keyed by worktree and branch, so a second one would fight the
/// first over the same files.
pub fn attach(diff_args: &[String]) -> Result<Attached, String> {
    match read_state_at(&default_state_path()) {
        Ok(state) => {
            let base = localhost(&state.url);
            // A state file outlives a server that crashed — nothing cleans it
            // up but the server's own shutdown. Believing it means a viewer
            // that reports "cannot reach krit" when the honest answer is that
            // there is nothing there and we should start one.
            if reachable(&base) {
                return Ok(Attached::Adopted(base));
            }
        }
        Err(StateError::Missing(_)) => {}
        // Unreadable or malformed is a configuration problem, not an absence:
        // starting a second server on top of one that may well be running is
        // the wrong guess to make on the reviewer's behalf.
        Err(other) => return Err(other.lines().join("\n")),
    }
    start_server(diff_args).map(Attached::Started)
}

/// A cheap route that touches no git — enough to answer "is anything
/// listening and is it krit".
fn reachable(base: &str) -> bool {
    ureq::get(&format!("{base}/api/settings"))
        .timeout(Duration::from_millis(1500))
        .call()
        .is_ok()
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

fn start_server(diff_args: &[String]) -> Result<String, String> {
    let exe = krit_binary();
    // The server's own stdout would land on top of the viewer, so it goes to
    // a file — which is also the only thing we can quote back if it dies
    // before writing a state file ("not a git repository", a typo'd rev).
    let log_path = std::env::temp_dir().join(format!("krit-tui-{}.log", std::process::id()));
    let log = std::fs::File::create(&log_path)
        .map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;
    let errors = log
        .try_clone()
        .map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;

    let mut cmd = Command::new(&exe);
    cmd.arg("--no-open");
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
    let state_path = default_state_path();
    let deadline = Instant::now() + Duration::from_secs(15);

    loop {
        // Matched on pid, not merely on the file existing: a stale state file
        // from a crashed server is exactly the case that got us here, and
        // adopting it would hand us the dead port we just rejected.
        if let Ok(state) = read_state_at(&state_path)
            && state.pid == pid
        {
            return Ok(localhost(&state.url));
        }
        if let Ok(Some(status)) = child.try_wait() {
            let output = std::fs::read_to_string(&log_path).unwrap_or_default();
            let detail = output.trim();
            return Err(if detail.is_empty() {
                format!("krit exited ({status}) without saying why")
            } else {
                format!("krit could not start:\n{detail}")
            });
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err(format!(
                "krit started but wrote no state file within 15s — see {}",
                log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn fetch_diff(base: &str) -> Result<DiffPayload, String> {
    let url = format!("{base}/api/diff");
    match ureq::get(&url).call() {
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
fn classify(value: &Value) -> Option<ServerEvent> {
    match value["type"].as_str()? {
        // `krit refresh` has no event of its own — it broadcasts
        // `file-written` with a null path, which is exactly what it means.
        "files-changed" | "file-changed" | "file-written" => Some(ServerEvent::Changed),
        "submitted" => Some(ServerEvent::Submitted {
            summary: value["summary"].as_str().map(str::to_string),
        }),
        "review-ended" => Some(ServerEvent::Ended {
            reason: value["reason"].as_str().unwrap_or("unknown").to_string(),
        }),
        // state / clients / comment traffic: nothing for a read-only viewer to
        // do. Phase 1 grows this list rather than removing the default.
        _ => None,
    }
}

/// Subscribe to the event stream on a thread of its own, forwarding to `tx`
/// until the connection ends. Sends exactly one terminal event (`Ended` or
/// `Disconnected`) so the draw loop always learns why it stopped.
///
/// `role=ui` rather than `cli`: this is a human's client, so it must hold the
/// server open the way a browser tab does. A `cli` subscription would let the
/// idle timeout fire with the review still on screen.
pub fn spawn_events(base: &str, tx: Sender<ServerEvent>) {
    let url = format!("{base}/api/events?role=ui");
    std::thread::spawn(move || {
        let res = match ureq::get(&url).set("Accept", "text/event-stream").call() {
            Ok(res) => res,
            Err(_) => {
                let _ = tx.send(ServerEvent::Disconnected);
                return;
            }
        };
        let mut reader = res.into_reader();
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut ended = false;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    for event in drain_frames(&mut buf) {
                        let terminal = matches!(event, ServerEvent::Ended { .. });
                        if tx.send(event).is_err() {
                            return; // the viewer is gone
                        }
                        if terminal {
                            ended = true;
                            break;
                        }
                    }
                    if ended {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if !ended {
            let _ = tx.send(ServerEvent::Disconnected);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn events_a_read_only_viewer_has_no_use_for_are_dropped_not_misread() {
        // `state` and `clients` arrive constantly; each must not read as a
        // reason to refetch.
        assert!(
            frames(
                "data: {\"type\":\"state\",\"watcherCount\":1,\"uiCount\":1,\"agentCount\":0}\n\n"
            )
            .is_empty()
        );
        assert!(frames("data: {\"type\":\"clients\",\"browsers\":2}\n\n").is_empty());
        assert!(frames("data: {\"type\":\"comment-added\",\"comment\":{}}\n\n").is_empty());
    }

    #[test]
    fn a_frame_that_is_not_json_does_not_take_the_stream_down_with_it() {
        let events =
            frames("data: not json\n\ndata: {\"type\":\"file-changed\",\"path\":\"a\"}\n\n");
        assert_eq!(events, vec![ServerEvent::Changed]);
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
}
