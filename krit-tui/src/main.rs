//! krit in the terminal — a second client for the same server, so a review
//! can happen in the pane beside the agent. Design: docs/design/tui.md.
//!
//! This is phase 0: a read-only viewer. It adopts a running krit server via
//! the state file (or starts one), renders its diff, and follows the same
//! event stream the browser UI does. Commenting is phase 1.

mod app;
mod client;
mod patch;
mod rows;
mod term;
mod text;
mod ui;

use app::{Action, App, Status, action_for};
use client::{Incoming, ServerEvent};
use ratatui::crossterm::event::{self, Event};
use std::sync::mpsc;
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

/// Apply one action.
///
/// Two of them never reach `App` at all — `Refetch` and `Suspend` need the
/// socket or the terminal, and `app.rs` marks the same pair. `ToggleMouse`
/// needs both: the flag is the app's, the escape sequence is the terminal's.
/// Everything else is the app's alone. Routing every source of actions through
/// here is what keeps a key and a click from drifting apart in what they do.
///
/// Returns whether anything happened that the screen should be redrawn for.
fn act(
    app: &mut App,
    action: Action,
    viewport: usize,
    session: &mut term::Session,
    terminal: &mut term::Tui,
    refetch_at: &mut Option<Instant>,
) -> Result<bool, String> {
    if action == Action::None {
        return Ok(false);
    }
    // Any action the reviewer takes clears a stale message: leaving it up
    // would keep reporting a failure that has since been retried. The end of
    // the review outlives the message, so that one stays. This runs for every
    // action, including the three handled below — pressing `m` with an error
    // strip up should clear it like anything else.
    if !matches!(app.status, Status::Ended(_)) {
        app.status = Status::Idle;
    }
    match action {
        Action::Refetch => *refetch_at = Some(Instant::now()),
        Action::Suspend => session
            .suspend(terminal)
            .map_err(|e| format!("suspend failed: {e}"))?,
        Action::ToggleMouse => {
            app.apply(action, viewport);
            session
                .set_mouse(app.mouse)
                .map_err(|e| format!("could not hand the mouse over: {e}"))?;
        }
        other => app.apply(other, viewport),
    }
    Ok(true)
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
        ..App::default()
    };
    app.load(&payload, 1);
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
    let fetch_tx = client::spawn_fetcher(server, settings, tx);

    let theme = ui::Theme::detect();
    let signals = term::Signals::register().map_err(|e| format!("cannot watch signals: {e}"))?;
    let (mut session, mut terminal) =
        term::Session::start(app.mouse).map_err(|e| format!("cannot take the terminal: {e}"))?;

    let mut viewport = 1usize;
    let mut refetch_at: Option<Instant> = None;
    let mut refetch_since: Option<Instant> = None;
    let mut pending_g = false;
    let mut dirty = true;
    let mut last_draw = Instant::now();

    let result = (|| -> Result<(), String> {
        while !app.should_quit {
            if dirty || last_draw.elapsed() >= FORCED_REDRAW {
                let mut panes = app.panes;
                terminal
                    .draw(|frame| {
                        // The two rows the layout spends on the header and
                        // footer are not scrollable, so every page-sized
                        // action has to know about them.
                        viewport = frame.area().height.saturating_sub(2) as usize;
                        panes = ui::draw(frame, &app, &theme);
                    })
                    .map_err(|e| format!("draw failed: {e}"))?;
                // Hit-testing reads what the last frame drew, and so does the
                // focus reconciliation: the file pane can be absent because
                // the reviewer hid it *or* because the terminal is too narrow,
                // and only the frame knows which.
                app.set_panes(panes);
                dirty = false;
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

            if event::poll(TICK).map_err(|e| format!("input failed: {e}"))? {
                match event::read().map_err(|e| format!("input failed: {e}"))? {
                    Event::Key(key) => {
                        let (action, next_g) = action_for(key, pending_g);
                        pending_g = next_g;
                        dirty |= act(
                            &mut app,
                            action,
                            viewport,
                            &mut session,
                            &mut terminal,
                            &mut refetch_at,
                        )?;
                    }
                    Event::Mouse(mouse) => {
                        let action = app.mouse_action(mouse);
                        dirty |= act(
                            &mut app,
                            action,
                            viewport,
                            &mut session,
                            &mut terminal,
                            &mut refetch_at,
                        )?;
                    }
                    Event::Resize(_, _) => dirty = true,
                    _ => {}
                }
            }

            for incoming in rx.try_iter() {
                dirty = true;
                match incoming {
                    // Restart the quiet window rather than queueing a fetch
                    // per event: a rebuild touching forty files is one diff.
                    // `refetch_since` is what stops a stream that never goes
                    // quiet from postponing the fetch forever.
                    Incoming::Event(ServerEvent::Changed) => {
                        refetch_at = Some(Instant::now() + QUIET);
                        refetch_since.get_or_insert_with(Instant::now);
                    }
                    Incoming::Event(ServerEvent::Submitted { summary }) => {
                        app.status = Status::Note(match summary {
                            Some(s) if !s.is_empty() => format!("Review submitted — {s}"),
                            _ => "Review submitted.".to_string(),
                        })
                    }
                    Incoming::Event(ServerEvent::Ended { reason }) => {
                        app.status = Status::Ended(format!("Review ended ({reason}). q to close."));
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
                }
            }

            let starved = refetch_since.is_some_and(|since| since.elapsed() >= MAX_REFETCH_WAIT);
            if let Some(due) = refetch_at
                && (Instant::now() >= due || starved)
            {
                refetch_at = None;
                refetch_since = None;
                // Asking is all the loop does; the answer arrives as an
                // `Incoming::Diff` like any other event.
                let _ = fetch_tx.send(());
            }
        }
        Ok(())
    })();

    // Both errors matter, and the loop's is almost always the interesting one
    // — "draw failed" says more than "could not restore the terminal". Report
    // that first and keep the restore failure for when it is the only one.
    let restored = session.finish();
    result?;
    restored.map_err(|e| format!("could not restore the terminal: {e}"))
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
                    // it once, guarded by a `poll` that times out.
                    || (code.contains("event::read") && name != "main.rs")
                    // A blocking channel receive in the viewer would park the
                    // loop on a thread that may never answer. Worker threads
                    // own their own `recv`; client.rs is where they live.
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
}
