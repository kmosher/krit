//! krit in the terminal — a second client for the same server, so a review
//! can happen in the pane beside the agent. Design: docs/design/tui.md.
//!
//! This is phase 0: a read-only viewer. It adopts a running krit server via
//! the state file, renders its diff, and follows the same event stream the
//! browser UI does. Commenting is phase 1.

mod app;
mod client;
mod patch;
mod rows;
mod term;
mod text;
mod ui;

use app::{Action, App, Status, action_for};
use client::ServerEvent;
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

A server it started stops on its own shortly after the last client leaves. A
server that was already running is adopted, and keeps its own range.

Honors NO_COLOR.";

/// How long the diff has to stay quiet before refetching.
///
/// `/api/events` is the human stream: it carries the fs-watcher's batched
/// output and every direct edit, unfiltered, which is right for a UI and
/// means a single `cargo build` can produce a burst of them. The server
/// deliberately doesn't debounce for us.
const QUIET: Duration = Duration::from_millis(120);

/// Long enough that an idle viewer isn't spinning, short enough that a key
/// feels immediate.
const TICK: Duration = Duration::from_millis(100);

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
            println!("krit-tui {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    if let Err(message) = run(&diff_args) {
        // Printed after the session guard has restored the terminal, so it
        // lands on the user's shell rather than on a screen about to vanish.
        eprintln!("{message}");
        std::process::exit(1);
    }
}

/// Apply one action. Three of them are not the app's to make — they need the
/// socket or the terminal — and routing every source of actions through here
/// is what keeps a key and a click from drifting apart in what they do.
fn act(
    app: &mut App,
    action: Action,
    viewport: usize,
    session: &mut term::Session,
    terminal: &mut term::Tui,
    refetch_at: &mut Option<Instant>,
) -> Result<(), String> {
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
        other => {
            // Any input clears a stale message; leaving it up would keep
            // reporting a failure that has since been retried. The end of the
            // review outlives the message, so that one stays.
            if other != Action::None && !matches!(app.status, Status::Ended(_)) {
                app.status = Status::Idle;
            }
            app.apply(other, viewport);
        }
    }
    Ok(())
}

fn run(diff_args: &[String]) -> Result<(), String> {
    let attached = client::attach(diff_args)?;
    let server = attached.base().to_string();
    // Fetched before taking the screen: with no diff there is nothing to
    // show, and an error is more readable in the shell than in a viewport
    // that is about to be torn down.
    let payload = client::fetch_diff(&server)?;

    let mut app = App::default();
    app.load(&payload);
    // A range only means something to the server that was started with it.
    // Silently ignoring the one on the command line would leave the reviewer
    // reading a diff they did not ask for and no way to tell.
    if matches!(attached, client::Attached::Adopted(_)) && !diff_args.is_empty() {
        app.status = Status::Note(
            "Attached to a krit server that was already running — it keeps its own range."
                .to_string(),
        );
    }

    let (tx, rx) = mpsc::channel();
    client::spawn_events(&server, tx);

    let theme = ui::Theme::detect();
    let suspend =
        term::SuspendSignal::register().map_err(|e| format!("cannot watch signals: {e}"))?;
    let (mut session, mut terminal) =
        term::Session::start(app.mouse).map_err(|e| format!("cannot take the terminal: {e}"))?;

    let mut viewport = 1usize;
    let mut refetch_at: Option<Instant> = None;
    let mut pending_g = false;

    let result = (|| -> Result<(), String> {
        while !app.should_quit {
            let mut panes = app.panes;
            terminal
                .draw(|frame| {
                    // The two rows the layout spends on the header and footer
                    // are not scrollable, so every page-sized action has to
                    // know about them.
                    viewport = frame.area().height.saturating_sub(2) as usize;
                    panes = ui::draw(frame, &app, &theme);
                })
                .map_err(|e| format!("draw failed: {e}"))?;
            // Hit-testing reads what the last frame drew, so this has to be
            // stored after the draw and before the next event is handled.
            app.panes = panes;

            if suspend.take() {
                session
                    .suspend(&mut terminal)
                    .map_err(|e| format!("suspend failed: {e}"))?;
                continue;
            }

            if event::poll(TICK).map_err(|e| format!("input failed: {e}"))? {
                match event::read().map_err(|e| format!("input failed: {e}"))? {
                    Event::Key(key) => {
                        let (action, next_g) = action_for(key, pending_g);
                        pending_g = next_g;
                        act(
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
                        act(
                            &mut app,
                            action,
                            viewport,
                            &mut session,
                            &mut terminal,
                            &mut refetch_at,
                        )?;
                    }
                    // A resize redraws on the next pass; ratatui reads the new
                    // size itself.
                    Event::Resize(_, _) => {}
                    _ => {}
                }
            }

            for server_event in rx.try_iter() {
                match server_event {
                    // Restart the quiet window rather than queueing a fetch
                    // per event: a rebuild touching forty files is one diff.
                    ServerEvent::Changed => refetch_at = Some(Instant::now() + QUIET),
                    ServerEvent::Submitted { summary } => {
                        app.status = Status::Note(match summary {
                            Some(s) if !s.is_empty() => format!("Review submitted — {s}"),
                            _ => "Review submitted.".to_string(),
                        })
                    }
                    ServerEvent::Ended { reason } => {
                        app.status = Status::Ended(format!("Review ended ({reason}). q to close."));
                    }
                    ServerEvent::Disconnected => {
                        app.status = Status::Ended(
                            "Lost the connection to krit — it crashed or was killed. q to close."
                                .to_string(),
                        );
                    }
                }
            }

            if let Some(due) = refetch_at
                && Instant::now() >= due
            {
                refetch_at = None;
                match client::fetch_diff(&server) {
                    Ok(payload) => {
                        app.load(&payload);
                        if !matches!(app.status, Status::Ended(_)) {
                            app.status = Status::Idle;
                        }
                    }
                    // A failed refetch leaves the last good diff on screen: it
                    // is stale, but it is what the reviewer was reading, and
                    // an empty pane says less than a stale one plus a strip.
                    Err(message) => app.status = Status::Error(message),
                }
            }
        }
        Ok(())
    })();

    session
        .finish()
        .map_err(|e| format!("could not restore the terminal: {e}"))?;
    result
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
}
