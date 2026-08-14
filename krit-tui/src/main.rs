//! krit in the terminal — a second client for the same server, so a review
//! can happen in the pane beside the agent. Design: docs/design/tui.md.
//!
//! This is phase 0: a read-only viewer. It adopts a running krit server via
//! the state file (or starts one), renders its diff, and follows the same
//! event stream the browser UI does. Commenting is phase 1.

mod app;
mod client;
mod comments;
mod compose;
mod highlight;
mod patch;
mod rows;
mod term;
mod text;
mod ui;

use app::{Action, App, Status, action_for};
use client::{Fetch, Incoming, ServerEvent, Write};
use compose::{Composer, Intent, Target};
use ratatui::crossterm::event::{self, Event};
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};

const HELP: &str = "\
krit-tui - review a krit session in the terminal

Usage: krit-tui [options] [-- <git diff args>]

Options:
  -h, --help     Show this help message
  -v, --version  Show version number

Attaches to the krit server for the current worktree and branch — the same
one `krit state` reports — and starts one if none is running, so this is the
only command you need. Anything after `--` is passed to that server as its
git diff range, exactly as `krit` takes it:

  krit-tui                                   the working tree
  krit-tui -- --staged                       only staged changes
  krit-tui -- HEAD~3                         the last 3 commits
  krit-tui -- \"$(git merge-base origin/main HEAD)\"   this branch

A server it starts is given a 5s idle timeout, so it stops on its own shortly
after the last client leaves. A server that was already running is adopted,
and keeps its own range and its own timeout.

Honors NO_COLOR.";

/// How long the diff has to stay quiet before refetching.
///
/// `/api/events` is the human stream: it carries the fs-watcher's batched
/// output and every direct edit, unfiltered, which is right for a UI and
/// means a single `cargo build` can produce a burst of them. The server
/// deliberately doesn't debounce for us.
const QUIET: Duration = Duration::from_millis(120);

/// The longest a burst may postpone a refetch. A trailing-edge debounce alone
/// can be starved forever by a change stream that never goes quiet, and the
/// failure is invisible — the diff simply stops updating while the footer
/// still says everything is fine.
const MAX_REFETCH_WAIT: Duration = Duration::from_secs(1);

/// Long enough that an idle viewer isn't spinning, short enough that a key
/// feels immediate.
const TICK: Duration = Duration::from_millis(100);

/// Redraw at least this often even when nothing said it was needed.
///
/// The loop otherwise draws only when something changed, which is the whole
/// point — three of the aggregates it computes scale with the review, not the
/// window. This is the backstop: if some future path forgets to mark the
/// screen dirty, the cost is a stale frame for a second, not a viewer that
/// never repaints again.
const FORCED_REDRAW: Duration = Duration::from_secs(1);

/// What the loop still owes the server, and when it may ask.
///
/// Two things can want refetching and they arrive on the same stream, so one
/// window covers both — a "post queued" that flips six comments broadcasts six
/// frames, and a rebuild touching forty files is one diff.
#[derive(Debug, Default, PartialEq, Eq)]
struct Refetch {
    diff: bool,
    comments: bool,
    viewed: bool,
    due: Option<Instant>,
    /// When the current burst started. A trailing-edge debounce alone can be
    /// starved forever by a stream that never goes quiet, and the failure is
    /// invisible — the diff simply stops updating while the footer still says
    /// everything is fine.
    since: Option<Instant>,
}

impl Refetch {
    fn want(&mut self, kind: Fetch, now: Instant) {
        match kind {
            Fetch::Diff => self.diff = true,
            Fetch::Comments => self.comments = true,
            Fetch::Viewed => self.viewed = true,
        }
        self.due = Some(now + QUIET);
        self.since.get_or_insert(now);
    }

    /// The kinds to ask for now, if the window has closed or been starved.
    fn take(&mut self, now: Instant) -> Vec<Fetch> {
        // Destructured rather than folded into a negated `is_some_and`: this
        // predicate is the whole debounce policy, and getting the de Morgan
        // wrong in either direction is either a viewer that hammers the server
        // or one that silently stops updating.
        let Some(due) = self.due else {
            return Vec::new();
        };
        let starved = self
            .since
            .is_some_and(|s| now.duration_since(s) >= MAX_REFETCH_WAIT);
        if now < due && !starved {
            return Vec::new();
        }
        let mut kinds = Vec::new();
        if std::mem::take(&mut self.diff) {
            kinds.push(Fetch::Diff);
        }
        if std::mem::take(&mut self.comments) {
            kinds.push(Fetch::Comments);
        }
        if std::mem::take(&mut self.viewed) {
            kinds.push(Fetch::Viewed);
        }
        self.due = None;
        self.since = None;
        kinds
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Args {
    Help,
    Version,
    /// The git-diff range to hand a server we start; empty means the default.
    Diff(Vec<String>),
}

/// Our own flags, and everything meant for git.
///
/// After `--`, nothing is ours — including things that look exactly like our
/// flags (`-- --staged`), which is the whole reason the separator exists.
/// Returns rather than prints so the split is testable without capturing
/// stdout.
fn parse_args(args: &[String]) -> Result<Args, String> {
    let (ours, theirs) = match args.iter().position(|a| a == "--") {
        Some(i) => (&args[..i], args[i + 1..].to_vec()),
        None => (args, Vec::new()),
    };
    if ours.iter().any(|a| a == "-h" || a == "--help") {
        return Ok(Args::Help);
    }
    if ours.iter().any(|a| a == "-v" || a == "--version") {
        return Ok(Args::Version);
    }
    if let Some(unknown) = ours.first() {
        // The likeliest mistake by a mile is a git argument without the
        // separator, so say that rather than only listing what is legal.
        return Err(format!(
            "krit-tui: unknown argument {unknown}\n\nDid you mean `-- {unknown}`? Anything for git goes after `--`.\n\n{HELP}"
        ));
    }
    Ok(Args::Diff(theirs))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let diff_args = match parse_args(&args) {
        Ok(Args::Diff(diff_args)) => diff_args,
        Ok(Args::Help) => {
            println!("{HELP}");
            return;
        }
        Ok(Args::Version) => {
            // Bare, and exit 1 below on a usage error: both match `krit`, so a
            // script wrapping the pair gets one format and one meaning per
            // code. `krit` got there first and its codes are already
            // documented (2 means "disconnected before submit" there).
            println!("{}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };

    if let Err(message) = run(&diff_args) {
        // Printed after the session guard has restored the terminal, so it
        // lands on the user's shell rather than on a screen about to vanish.
        eprintln!("{message}");
        std::process::exit(1);
    }
}

/// Everything an action might need that isn't the app's own state.
struct Wiring<'a> {
    session: &'a mut term::Session,
    terminal: &'a mut term::Tui,
    refetch: &'a mut Refetch,
    server: &'a str,
    tx: &'a Sender<Incoming>,
}

/// Apply one action.
///
/// A few never reach `App` at all: the ones that need the terminal (`Suspend`),
/// the socket (`Refetch`, and every verb that writes), or both (`ToggleMouse`
/// — the flag is the app's, the escape sequence is the terminal's). `app.rs`
/// marks the same set. Routing every source of actions through here is what
/// keeps a key and a click from drifting apart in what they do.
///
/// Returns whether anything happened that the screen should be redrawn for.
fn act(app: &mut App, action: Action, viewport: usize, w: &mut Wiring) -> Result<bool, String> {
    if action == Action::None {
        return Ok(false);
    }
    // Any action the reviewer takes clears a stale message: leaving it up
    // would keep reporting a failure that has since been retried. The end of
    // the review outlives the message, so that one stays. This runs for every
    // action, including the ones handled below — pressing `m` with an error
    // strip up should clear it like anything else.
    if !matches!(app.status, Status::Ended(_)) {
        app.status = Status::Idle;
    }
    match action {
        // `r` refreshes the whole review, not only the diff: a comment list
        // that fell behind looks exactly like one that is up to date.
        Action::Refetch => {
            let now = Instant::now();
            w.refetch.want(Fetch::Diff, now);
            w.refetch.want(Fetch::Comments, now);
            // Asked for by hand, so it goes out on the next pass rather than
            // waiting out a quiet window nobody is in.
            w.refetch.due = Some(now);
        }
        Action::Suspend => w
            .session
            .suspend(w.terminal)
            .map_err(|e| format!("suspend failed: {e}"))?,
        Action::ToggleMouse => {
            app.apply(action, viewport);
            w.session
                .set_mouse(app.mouse)
                .map_err(|e| format!("could not hand the mouse over: {e}"))?;
        }
        Action::Comment => match app.comment_anchor() {
            Some(anchor) => {
                app.compose = Some(Composer::new(Target::Comment(Box::new(anchor)), ""))
            }
            None => {
                app.status = Status::Note(
                    "Put the cursor on a line of code, or select one, then press c.".into(),
                )
            }
        },
        Action::Reply => match app.comment_under_cursor() {
            Some(comment) => {
                let target = Target::Reply {
                    id: comment.id.clone(),
                    on: first_line(&comment.body),
                };
                app.compose = Some(Composer::new(target, ""));
            }
            None => {
                app.status =
                    Status::Note("Put the cursor on a comment to reply to it (} jumps).".into())
            }
        },
        Action::ToggleResolved => match app.comment_under_cursor() {
            Some(comment) => {
                // A queued comment has nothing to resolve: it has not been
                // said yet. Posting it is `P`.
                let status = match comment.status.as_str() {
                    "queued" => {
                        app.status = Status::Note(
                            "That comment is still queued — P posts every queued comment.".into(),
                        );
                        return Ok(true);
                    }
                    "resolved" => "open",
                    _ => "resolved",
                };
                client::spawn_write(
                    w.server.to_string(),
                    Write::Status {
                        id: comment.id.clone(),
                        status,
                    },
                    None,
                    w.tx.clone(),
                );
            }
            None => {
                app.status =
                    Status::Note("Put the cursor on a comment to resolve it (} jumps).".into())
            }
        },
        Action::PostQueued => {
            let queued = app.comments.iter().filter(|c| c.status == "queued").count();
            if queued == 0 {
                app.status = Status::Note("Nothing queued.".into());
            } else {
                client::spawn_write(w.server.to_string(), Write::PostQueued, None, w.tx.clone());
            }
        }
        Action::ToggleViewed => match app.current_file() {
            Some(index) => {
                let path = app.files[index].path.clone();
                let viewed = !app.viewed.contains(&path);
                client::spawn_write(
                    w.server.to_string(),
                    Write::Viewed { path, viewed },
                    None,
                    w.tx.clone(),
                );
            }
            None => app.status = Status::Note("Put the cursor on a file to tick it off.".into()),
        },
        Action::Submit => {
            // The same gate the browser's button has, for the same reason: a
            // `submitted` nobody is subscribed to is a review handed to no one.
            if app.listeners == 0 {
                app.status = Status::Note(
                    "No watcher — nothing is listening for this review. Attach an agent first."
                        .into(),
                );
            } else {
                app.compose = Some(Composer::new(Target::Summary, ""));
            }
        }
        other => app.apply(other, viewport),
    }
    Ok(true)
}

/// How much of a comment's first line fits in a form's title, in **characters**
/// — not cells. A title is elided rather than laid out, so this bounds how much
/// is quoted, and the pane truncates whatever that comes to on screen.
/// `ui::selection_label` has its own budget in its own unit; the two are
/// separate numbers that happen to be near each other.
const TITLE_CHARS: usize = 40;

/// A comment's first line, short enough to name it in a title.
fn first_line(body: &str) -> String {
    let line = body.lines().next().unwrap_or("").trim();
    match line.char_indices().nth(TITLE_CHARS) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

/// Whether a finished write came from the form that is open right now.
///
/// Not "did some form send it": the reviewer can Esc out of an in-flight post
/// and open another before the answer lands, and closing whatever happens to be
/// up would take that second form's text with it — text which, until it is
/// posted, exists nowhere else.
fn from_open_form(app: &App, composer: Option<u64>) -> bool {
    matches!((composer, &app.compose), (Some(id), Some(open)) if open.id == id)
}

/// Apply one keystroke to the open composer.
///
/// Returns whether to redraw. Nothing here blocks: a post goes out on its own
/// thread and the answer arrives as an `Incoming::Done`. The form stays up
/// until then, with `sending` set — see the comment on that write below.
fn act_compose(app: &mut App, intent: Intent, server: &str, tx: &Sender<Incoming>) -> bool {
    let Some(composer) = &mut app.compose else {
        return false;
    };
    match intent {
        Intent::None => false,
        Intent::Edited => {
            // Typing answers the discard question by itself: the reviewer went
            // back to writing.
            composer.confirm_discard = false;
            true
        }
        Intent::KeepEditing => {
            composer.confirm_discard = false;
            true
        }
        // Every exit from a form with unsaved work goes through here, so a new
        // exit path cannot skip the question — the same shape `CommentForm`
        // arrived at after one was found that did.
        Intent::Cancel => {
            if composer.confirm_discard || composer.editor.is_blank() {
                app.compose = None;
            } else {
                composer.confirm_discard = true;
            }
            true
        }
        Intent::Post | Intent::Queue => {
            // A second Enter while the first is on its way would post the
            // comment twice, and nothing afterwards can tell the copies apart.
            if composer.sending {
                return false;
            }
            let queued = intent == Intent::Queue;
            let body = composer.editor.text().trim().to_string();
            // A summary is optional — finishing with nothing to add is a
            // normal ending. A comment or a reply with no text is not.
            if body.is_empty() && !matches!(composer.target, Target::Summary) {
                app.status = Status::Note("Nothing written yet.".into());
                return true;
            }
            let write = match &composer.target {
                Target::Comment(anchor) => Write::Comment {
                    anchor: anchor.clone(),
                    body,
                    queued,
                },
                Target::Reply { id, .. } => Write::Reply {
                    id: id.clone(),
                    body,
                },
                Target::Summary => Write::Submit {
                    summary: (!body.is_empty()).then_some(body),
                },
            };
            // The form stays up until the server answers. Closing it first
            // would throw the reviewer's text away on any failure, and at that
            // point it exists nowhere else — the same reason the browser's
            // queued-comment editor keeps its text on a refused save.
            composer.sending = true;
            client::spawn_write(server.to_string(), write, Some(composer.id), tx.clone());
            true
        }
    }
}

fn run(diff_args: &[String]) -> Result<(), String> {
    let attached = client::attach(diff_args)?;
    let server = attached.base().to_string();
    let settings = attached.settings();
    // Fetched before taking the screen: with no diff there is nothing to
    // show, and an error is more readable in the shell than in a viewport
    // that is about to be torn down.
    let payload = client::fetch_diff(&server, settings)?;

    let mut app = App {
        // The reviewer's tab width, not ours — the browser expands tabs with
        // it too, and the two clients showing the same file at different
        // indents on the same review is the kind of disagreement nobody
        // diagnoses. Set before `load`, which measures expanded lines.
        tab_size: settings.tab_size,
        split_pref: settings.split,
        ..App::default()
    };
    app.load(&payload, 1);
    // Not fatal, unlike the diff: a review with no comments and a review whose
    // comments could not be read look identical, so the failure has to be said
    // out loud — but it is still a readable review.
    match client::fetch_comments(&server) {
        Ok(comments) => app.set_comments(comments, 1),
        Err(message) => app.status = Status::Error(message),
    }
    // Same trade: a reviewer who ticked files off in the browser should not
    // find them all back, and a list that could not be read is still a
    // readable review.
    match client::fetch_viewed(&server) {
        Ok(paths) => app.set_viewed(paths.into_iter().collect()),
        Err(message) => app.status = Status::Error(message),
    }
    // A range only means something to the server that was started with it.
    // Silently ignoring the one on the command line would leave the reviewer
    // reading a diff they did not ask for and no way to tell.
    if attached.adopted() && !diff_args.is_empty() {
        app.status = Status::Note(
            "Attached to a krit server that was already running — it keeps its own range."
                .to_string(),
        );
    }

    let (tx, rx) = mpsc::channel();
    client::spawn_events(&server, tx.clone());
    // Diff fetches run on their own thread. In the draw loop they froze
    // everything for as long as git took: no redraw, no key read, and — since
    // raw mode clears ISIG — no Ctrl+C either.
    let fetch_tx = client::spawn_fetcher(server.clone(), settings, tx.clone());

    let theme = ui::Theme::detect();
    let signals = term::Signals::register().map_err(|e| format!("cannot watch signals: {e}"))?;
    let (mut session, mut terminal) =
        term::Session::start(app.mouse).map_err(|e| format!("cannot take the terminal: {e}"))?;
    // Whether this terminal can tell `Ctrl+Enter` from `Enter`. Not a
    // capability the composer needs — `Ctrl+S` always works — but the footer
    // has to say which bindings are live, and guessing from the developer's
    // own terminal is how a design doc's warning becomes a bug report.
    let enhanced = session.keyboard_enhanced();
    // The loop waits on this rather than inside `event::poll`; `term::Tty` says
    // why. `None` means no controlling terminal, where there is nothing to
    // watch for and crossterm's own wait is as good as it gets.
    let tty = term::Tty::open();

    let mut viewport = 1usize;
    let mut refetch = Refetch::default();
    let mut pending_g = false;
    let mut dirty = true;
    let mut last_draw = Instant::now();

    let result = (|| -> Result<(), String> {
        while !app.should_quit {
            if dirty || last_draw.elapsed() >= FORCED_REDRAW {
                let mut panes = app.panes;
                terminal
                    .draw(|frame| panes = ui::draw(frame, &app, &theme, enhanced))
                    .map_err(|e| format!("draw failed: {e}"))?;
                // The diff pane's own height, not the terminal's: the header,
                // the footer and — when it is open — the composer all take
                // rows that no page-sized movement should count.
                viewport = (panes.diff.height as usize).max(1);
                // Hit-testing reads what the last frame drew, and so does the
                // focus reconciliation: the file pane can be absent because
                // the reviewer hid it *or* because the terminal is too narrow,
                // and only the frame knows which. It can also *invalidate* the
                // frame — comment bodies wrap to the pane's width, so a resize
                // changes the rows and not just the picture.
                dirty = app.set_panes(panes);
                last_draw = Instant::now();
            }

            // A signal we asked for rather than one that kills us: without
            // this, a SIGTERM from a wedged-looking session skips the panic
            // hook and the Drop guard and leaves the terminal in raw mode.
            if signals.quit_requested() {
                app.should_quit = true;
                continue;
            }
            if signals.suspend_requested() {
                session
                    .suspend(&mut terminal)
                    .map_err(|e| format!("suspend failed: {e}"))?;
                dirty = true;
                continue;
            }

            // The wait for input, and the one place the terminal's death is
            // noticed. Quitting on `Gone` is not tidiness: the loop is where
            // every signal is answered, so a viewer that keeps waiting on a
            // dead terminal answers none of them and has to be `SIGKILL`ed.
            let ready = match &tty {
                Some(tty) => match tty.wait(TICK) {
                    // Bytes are waiting, which is not the same as an event:
                    // an escape sequence can arrive split across reads. Only
                    // crossterm knows whether it has a whole one, and asking
                    // with a zero timeout is what keeps `read` — which blocks
                    // until a sequence completes — out of the draw loop.
                    term::Input::Ready => {
                        event::poll(Duration::ZERO).map_err(|e| format!("input failed: {e}"))?
                    }
                    term::Input::Idle => false,
                    term::Input::Gone => {
                        app.should_quit = true;
                        continue;
                    }
                },
                None => event::poll(TICK).map_err(|e| format!("input failed: {e}"))?,
            };
            if ready {
                let mut wiring = Wiring {
                    session: &mut session,
                    terminal: &mut terminal,
                    refetch: &mut refetch,
                    server: &server,
                    tx: &tx,
                };
                match event::read().map_err(|e| format!("input failed: {e}"))? {
                    // An open composer owns the keyboard — but not the screen:
                    // the diff is still drawn, the wheel still scrolls it, and
                    // the loop is still reading. That is the whole difference
                    // between a form and a modal dialog.
                    Event::Key(key) if app.compose.is_some() => {
                        // The composer sits under the diff and shares its
                        // width, less its border. Up and down are movements on
                        // the screen, so they need the same width the pane drew
                        // with — hence `ui`'s own helper rather than a second
                        // copy of the arithmetic.
                        let width = ui::compose_text_width(app.panes.diff);
                        let intent = compose::key(app.compose.as_mut().unwrap(), key, width);
                        dirty |= act_compose(&mut app, intent, &server, &tx);
                    }
                    Event::Key(key) => {
                        let (action, next_g) = action_for(key, pending_g);
                        pending_g = next_g;
                        dirty |= act(&mut app, action, viewport, &mut wiring)?;
                    }
                    // Bracketed paste: the whole thing arrives as one event.
                    // Without it a three-line comment pasted into the composer
                    // is three Enters, and the design doc calls this the single
                    // most likely "obviously broken on day one" bug there is.
                    Event::Paste(text) => {
                        if let Some(composer) = &mut app.compose {
                            composer.editor.insert(&text);
                            composer.confirm_discard = false;
                            dirty = true;
                        }
                    }
                    Event::Mouse(mouse) => {
                        let action = app.mouse_action(mouse);
                        dirty |= act(&mut app, action, viewport, &mut wiring)?;
                    }
                    Event::Resize(_, _) => dirty = true,
                    _ => {}
                }
            }

            for incoming in rx.try_iter() {
                dirty = true;
                match incoming {
                    // Restart the quiet window rather than queueing a fetch
                    // per event.
                    Incoming::Event(ServerEvent::Changed) => {
                        refetch.want(Fetch::Diff, Instant::now())
                    }
                    Incoming::Event(ServerEvent::CommentsChanged) => {
                        refetch.want(Fetch::Comments, Instant::now())
                    }
                    Incoming::Event(ServerEvent::Listeners { count }) => app.listeners = count,
                    Incoming::Event(ServerEvent::Submitted { summary }) => {
                        app.status = Status::Note(match summary {
                            Some(s) if !s.is_empty() => format!("Review submitted — {s}"),
                            _ => "Review submitted.".to_string(),
                        })
                    }
                    Incoming::Event(ServerEvent::Ended { reason }) => {
                        // The goodbye names the ending, and one of them is not
                        // an ending at all from here: `signal` means somebody
                        // killed the server out from under a review that was
                        // still going. Saying "review ended" to that would file
                        // it alongside the reviewer finishing.
                        app.status = Status::Ended(match reason.as_str() {
                            "signal" => "krit was terminated. q to close.".to_string(),
                            "idle" => "krit shut down — left idle. q to close.".to_string(),
                            other => format!("Review ended ({other}). q to close."),
                        });
                    }
                    Incoming::Event(ServerEvent::Disconnected) => {
                        app.status = Status::Ended(
                            "Lost the connection to krit — it crashed or was killed. q to close."
                                .to_string(),
                        );
                    }
                    Incoming::Diff(result) => match *result {
                        Ok(payload) => {
                            app.load(&payload, viewport);
                            if !matches!(app.status, Status::Ended(_)) {
                                app.status = Status::Idle;
                            }
                        }
                        // A failed refetch leaves the last good diff on
                        // screen: it is stale, but it is what the reviewer was
                        // reading, and an empty pane says less than a stale
                        // one plus a strip. The Ended guard is the same one
                        // the success path uses — after the review is over,
                        // "cannot reach krit" is the less useful of the two
                        // things we could be saying.
                        Err(message) => {
                            if !matches!(app.status, Status::Ended(_)) {
                                app.status = Status::Error(message);
                            }
                        }
                    },
                    Incoming::Viewed(result) => match *result {
                        Ok(paths) => app.set_viewed(paths.into_iter().collect()),
                        // The list on screen is stale rather than gone, same as
                        // the diff and the comments: say so and keep drawing.
                        Err(message) => {
                            if !matches!(app.status, Status::Ended(_)) {
                                app.status = Status::Error(message);
                            }
                        }
                    },
                    Incoming::Comments(result) => match *result {
                        Ok(comments) => app.set_comments(comments, viewport),
                        // Same trade as the diff: the list on screen is stale
                        // rather than gone, and the strip says so.
                        Err(message) => {
                            if !matches!(app.status, Status::Ended(_)) {
                                app.status = Status::Error(message);
                            }
                        }
                    },
                    Incoming::Done { result, composer } => match *result {
                        Ok(note) => {
                            if !matches!(app.status, Status::Ended(_)) {
                                app.status = Status::Note(note);
                            }
                            if from_open_form(&app, composer) {
                                app.compose = None;
                                app.selection = None;
                            }
                            // Ask, rather than waiting to be told. A queued
                            // comment is suppressed from every broadcast until
                            // it is posted, so listening alone would show
                            // queueing as a key that does nothing.
                            refetch.want(Fetch::Comments, Instant::now());
                            // And the viewed list, for the same reason: `PUT
                            // /api/viewed` broadcasts nothing either, so a tick
                            // would be a key that appears to do nothing.
                            refetch.want(Fetch::Viewed, Instant::now());
                        }
                        // The form stays up with the text in it: at this point
                        // it exists nowhere else, and a strip the reviewer can
                        // read while retrying beats a message about work that
                        // has already been thrown away.
                        Err(message) => {
                            app.status = Status::Error(message);
                            if from_open_form(&app, composer)
                                && let Some(open) = &mut app.compose
                            {
                                open.sending = false;
                            }
                            // A refusal is the best evidence available that the
                            // list is wrong. `DELETE /api/comments/{id}`
                            // broadcasts nothing at all, so a comment deleted in
                            // the browser stays on screen here and every `R` or
                            // `X` on it 404s — identically, forever, since
                            // nothing else would refresh it.
                            refetch.want(Fetch::Comments, Instant::now());
                        }
                    },
                }
            }

            // Asking is all the loop does; the answers arrive as `Incoming`
            // like any other event.
            for kind in refetch.take(Instant::now()) {
                let _ = fetch_tx.send(kind);
            }
        }
        Ok(())
    })();

    // Both errors matter, and the loop's is almost always the interesting one
    // — "draw failed" says more than "could not restore the terminal". Report
    // that first and keep the restore failure for when it is the only one.
    let restored = session.finish();
    result?;
    // Failing to hand back a terminal that no longer exists is not a failure.
    // Reporting it would be wrong twice over: the viewer did exactly the right
    // thing, and the complaint goes to the terminal that just went away, so
    // nobody reads it — while the exit status lies to whatever *is* watching,
    // recording every closed window as an error.
    //
    // Keyed off the error rather than off which arm quit, because there are two
    // ways in and only one of them knows: closing a terminal usually delivers
    // SIGHUP first, so the loop quits through the signal handler without ever
    // consulting the descriptor, and `Input::Gone` never fires. Two ways in,
    // one rule out.
    match restored {
        Err(e) if terminal_is_gone(&e) => Ok(()),
        other => other.map_err(|e| format!("could not restore the terminal: {e}")),
    }
}

/// Did this write fail because the terminal is no longer there?
///
/// `EIO` is what a pty whose far end has closed answers, and `ENXIO` is a
/// terminal that was revoked outright; `BrokenPipe` covers a `krit-tui` whose
/// stdout was a pipe that closed. Anything else is a real failure to restore —
/// which must still be reported, since that is the case that leaves a shell in
/// raw mode.
fn terminal_is_gone(err: &std::io::Error) -> bool {
    matches!(err.kind(), std::io::ErrorKind::BrokenPipe)
        || matches!(err.raw_os_error(), Some(libc::EIO) | Some(libc::ENXIO))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_arguments_means_the_default_range() {
        assert_eq!(parse_args(&[]), Ok(Args::Diff(Vec::new())));
    }

    #[test]
    fn everything_after_the_separator_belongs_to_git() {
        // `--staged` is git's, not a krit-tui flag that happens to be unknown.
        assert_eq!(
            parse_args(&args(&["--", "--staged"])),
            Ok(Args::Diff(args(&["--staged"])))
        );
        assert_eq!(
            parse_args(&args(&["--", "HEAD~3", "--", "src/"])),
            Ok(Args::Diff(args(&["HEAD~3", "--", "src/"]))),
            "a second -- is git's too"
        );
    }

    #[test]
    fn our_flags_are_only_ours_before_the_separator() {
        assert_eq!(parse_args(&args(&["--help"])), Ok(Args::Help));
        assert_eq!(parse_args(&args(&["-v"])), Ok(Args::Version));
        // After it, `--help` is a rev name as far as we are concerned.
        assert_eq!(
            parse_args(&args(&["--", "--help"])),
            Ok(Args::Diff(args(&["--help"])))
        );
    }

    #[test]
    fn a_burst_becomes_one_fetch_of_each_kind_once_it_goes_quiet() {
        let start = Instant::now();
        let mut refetch = Refetch::default();
        for step in 0..5 {
            refetch.want(Fetch::Diff, start + Duration::from_millis(step * 10));
        }
        refetch.want(Fetch::Comments, start + Duration::from_millis(40));
        assert!(
            refetch.take(start + Duration::from_millis(100)).is_empty(),
            "the window is still open"
        );
        assert_eq!(
            refetch.take(start + Duration::from_millis(200)),
            vec![Fetch::Diff, Fetch::Comments]
        );
        assert!(refetch.take(start + Duration::from_secs(9)).is_empty());
    }

    #[test]
    fn a_stream_that_never_goes_quiet_still_gets_a_fetch_out() {
        // A trailing-edge debounce alone can be starved forever, and the
        // failure is invisible: the diff stops updating while the footer still
        // says everything is fine.
        let start = Instant::now();
        let mut refetch = Refetch::default();
        for step in 0..100 {
            let now = start + Duration::from_millis(step * 50);
            refetch.want(Fetch::Diff, now);
            if !refetch.take(now).is_empty() {
                assert!(
                    now.duration_since(start) <= MAX_REFETCH_WAIT + QUIET,
                    "waited {:?}",
                    now.duration_since(start)
                );
                return;
            }
        }
        panic!("a continuous stream of changes never produced a fetch");
    }

    #[test]
    fn only_the_kinds_that_were_asked_for_go_out() {
        // A burst of file writes must not re-read the comment list, and a
        // burst of comment traffic must not re-run `git diff`.
        let now = Instant::now();
        let mut refetch = Refetch::default();
        refetch.want(Fetch::Comments, now);
        assert_eq!(
            refetch.take(now + QUIET + Duration::from_millis(1)),
            vec![Fetch::Comments]
        );
    }

    #[test]
    fn a_git_argument_without_the_separator_is_told_what_it_is_missing() {
        let err = parse_args(&args(&["HEAD~3"])).unwrap_err();
        assert!(err.contains("unknown argument HEAD~3"), "{err}");
        assert!(err.contains("Did you mean `-- HEAD~3`?"), "{err}");
    }

    /// The terminal analogue of the web UI's `nativeDialogs.test.tsx`.
    ///
    /// The rule that matters is not "no `confirm()`" but "the program never
    /// stops redrawing while it waits for an answer" — an agent driving this
    /// deadlocks on a prompt exactly as it would on a browser dialog. In a TUI
    /// that means input is read in one place, in the loop, with a timeout;
    /// anything that reads a key or a line somewhere else is a modal question
    /// by another name. The design doc says to put this guard in before phase
    /// 1 adds the composer, because retrofitting it is how the web UI ended up
    /// needing one.
    #[test]
    fn nothing_outside_the_draw_loop_waits_for_input() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("src is readable") {
            let path = entry.expect("readable entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let whole = std::fs::read_to_string(&path).expect("source is readable");
            // Only the viewer is bound by this. Test modules block on purpose,
            // and this test's own patterns live in one — scanning them makes
            // the guard fail on itself.
            let source = match whole.find("#[cfg(test)]") {
                Some(at) => &whole[..at],
                None => &whole[..],
            };
            for (n, line) in source.lines().enumerate() {
                let code = line.trim_start();
                if code.starts_with("//") || code.starts_with("///") {
                    continue;
                }
                // Reading stdin directly is always wrong: it bypasses the
                // terminal session entirely and blocks with the screen frozen.
                let blocking = code.contains("stdin()")
                    // `event::read` blocks until a key arrives. main.rs calls
                    // it once, guarded by a `poll` that times out. Matched
                    // unqualified as well, since `use ...event::read` makes the
                    // call site a bare `read(` — a spelling the qualified
                    // pattern alone would wave straight through.
                    || ((code.contains("event::read") || code.contains("read()"))
                        && name != "main.rs")
                    // A blocking channel receive in the viewer would park the
                    // loop on a thread that may never answer. Worker threads
                    // own their own `recv` and all of them live in client.rs,
                    // which is why that file is exempt — wholesale, so a `recv`
                    // added there outside a spawned closure would pass. Nothing
                    // short of tracking scope closes that, and this guard is
                    // worth more simple than exhaustive.
                    || (code.contains(".recv()") && name != "client.rs");
                if blocking {
                    offenders.push(format!("{name}:{}: {}", n + 1, code.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "these block the viewer while it waits for input; route the question \
             through a Status strip instead:\n{}",
            offenders.join("\n")
        );
    }

    /// The other half of the rule above: the loop must not only avoid blocking
    /// on input, it must notice when input can never arrive again.
    ///
    /// `event::poll` does not return once the terminal dies — a pty slave whose
    /// master closed is readable forever and yields nothing — so a loop waiting
    /// only on crossterm spins a core and, far worse, stops answering signals,
    /// since the loop is where every signal is answered. Such a viewer survives
    /// SIGTERM and SIGHUP alike and needs SIGKILL. One escaped that way from a
    /// closed tmux session and pegged a core for two days.
    ///
    /// A source check because there is nothing else to check: the failure needs
    /// a real pty to reproduce, leaves no error, and looks from the inside
    /// exactly like a terminal nobody is typing at.
    #[test]
    fn the_draw_loop_notices_a_terminal_that_has_gone_away() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("main.rs");
        let whole = std::fs::read_to_string(path).expect("main.rs is readable");
        let source = match whole.find("#[cfg(test)]") {
            Some(at) => &whole[..at],
            None => &whole[..],
        };
        let at = source.find("Input::Gone").unwrap_or_else(|| {
            panic!(
                "the draw loop no longer handles term::Input::Gone, so a terminal \
                 that goes away leaves this process spinning and deaf to signals"
            )
        });
        // The arm has to *quit*, not merely exist. Matching the name alone
        // passes for `Input::Gone => false`, which is the same wedge with the
        // handling filed off — and that is the likelier regression, since
        // deleting a match arm does not compile while emptying one does.
        assert!(
            source[at..]
                .lines()
                .take(4)
                .any(|l| l.contains("should_quit")),
            "the term::Input::Gone arm no longer quits; a terminal that goes \
             away leaves this process spinning and deaf to signals"
        );
    }
}
