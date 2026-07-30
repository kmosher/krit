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
krit-tui - review a running krit session in the terminal

Usage: krit-tui [options]

Options:
  -h, --help     Show this help message
  -v, --version  Show version number

Attaches to the krit server for the current worktree and branch, the same
one `krit state` reports. Start one with `krit` first.

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

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{HELP}");
        return;
    }
    if args.iter().any(|a| a == "-v" || a == "--version") {
        println!("krit-tui {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if let Some(unknown) = args.first() {
        eprintln!("krit-tui: unknown argument {unknown}\n\n{HELP}");
        std::process::exit(2);
    }

    if let Err(message) = run() {
        // Printed after the session guard has restored the terminal, so it
        // lands on the user's shell rather than on a screen about to vanish.
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let server = client::resolve_server().map_err(|err| err.lines().join("\n"))?;
    // Fetched before taking the screen: with no diff there is nothing to
    // show, and an error is more readable in the shell than in a viewport
    // that is about to be torn down.
    let payload = client::fetch_diff(&server)?;

    let mut app = App::default();
    app.load(&payload);

    let (tx, rx) = mpsc::channel();
    client::spawn_events(&server, tx);

    let theme = ui::Theme::detect();
    let suspend =
        term::SuspendSignal::register().map_err(|e| format!("cannot watch signals: {e}"))?;
    let (mut session, mut terminal) =
        term::Session::start().map_err(|e| format!("cannot take the terminal: {e}"))?;

    let mut viewport = 1usize;
    let mut refetch_at: Option<Instant> = None;
    let mut pending_g = false;

    let result = (|| -> Result<(), String> {
        while !app.should_quit {
            terminal
                .draw(|frame| {
                    // The two rows the layout spends on the header and footer
                    // are not scrollable, so every page-sized action has to
                    // know about them.
                    viewport = frame.area().height.saturating_sub(2) as usize;
                    ui::draw(frame, &app, &theme);
                })
                .map_err(|e| format!("draw failed: {e}"))?;

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
                        match action {
                            Action::Refetch => refetch_at = Some(Instant::now()),
                            Action::Suspend => session
                                .suspend(&mut terminal)
                                .map_err(|e| format!("suspend failed: {e}"))?,
                            other => {
                                // Any key clears a stale message; leaving it
                                // up would keep reporting a failure that has
                                // since been retried. The terminal end of the
                                // review outlives it, so that one stays.
                                if other != Action::None && !matches!(app.status, Status::Ended(_))
                                {
                                    app.status = Status::Idle;
                                }
                                app.apply(other, viewport);
                            }
                        }
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
