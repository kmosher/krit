//! krit — local code review between you and your agent. The v2 backend of
//! diffx: same wire contract, one static binary, single-digit megabytes.
//! Architecture and build order: docs/design/krit-v2.md.

mod edits;
mod git;
mod hub;
mod pathsafe;
mod reanchor;
mod server;
mod settings;
mod state;
mod store;
mod subcommands;
mod types;
mod watcher;

use state::{
    KritState, comments_store_path, default_state_path, remove_state_if_owned, write_state,
};
use std::path::PathBuf;

const HELP: &str = r#"krit - Local code review tool for git diffs

Usage: krit [options] [-- <git diff args>]
       krit <subcommand> [args]

Options:
  -p, --port <port>  Port to run the server on (default: random available port)
  --host <host>      Host address to bind to (default: 127.0.0.1). Pass
                     0.0.0.0 to expose the server to the local network.
  --no-open          Don't open the browser automatically
  -v, --version      Show version number
  -h, --help         Show this help message

Subcommands (talk to the running krit server for the current session):
  state                       Print state JSON (port, pid, url, etc.)
  comments [filter]           List comments. filter: open | resolved | replied | all (default: all)
  reply <id> <text...>        Reply to a comment
  resolve <id>                Mark a comment resolved
  reopen <id>                 Reopen a resolved comment
  wait-for-submit             Block until the user clicks Done reviewing in the browser UI
                              (exit 0 on submit, 2 on disconnect)
  refresh                     Tell the browser tab to refetch the diff (after edits
                              made outside the in-browser editor)

Examples:
  krit                         Review uncommitted changes
  krit -- --staged             Review staged changes
  krit -- HEAD~3               Review last 3 commits
  krit -- main..feature        Compare branches
  krit comments open           List unresolved comments
  krit reply abc-123 "Done."   Reply to a comment

Session model:
  krit writes a state file so subcommands can find the running server, and its
  comments live alongside it. Both are keyed to the review (git worktree +
  branch), so different repos/worktrees/branches never share a store.
  Location priority:
    1. $KRIT_STATE_FILE
    2. $CLAUDE_TMPDIR/krit-state-<hash(worktree+branch)>.json
    3. ~/.krit/state-<hash(worktree+branch)>.json"#;

fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    // Subcommand dispatch happens BEFORE flag parsing so git-diff flags
    // don't get rejected. argv[1] is only a subcommand when no `--` comes
    // first — `--` is the hard signal that the rest is git-diff args.
    let dash_dash_idx = raw_args.iter().position(|a| a == "--");
    let first_positional_idx = raw_args.iter().position(|a| !a.starts_with('-'));
    if let Some(idx) = first_positional_idx {
        let is_before_dash_dash = dash_dash_idx.map(|d| idx < d).unwrap_or(true);
        if is_before_dash_dash && subcommands::SUBCOMMANDS.contains(&raw_args[idx].as_str()) {
            run_subcommand(&raw_args[idx..]);
            return;
        }
        // Retirement stub, mirroring v1's `diffx watch` stub: without it,
        // `krit watch` would fall through to the server path with `watch` as
        // a git-diff ref and launch an empty review.
        if is_before_dash_dash && raw_args[idx] == "watch" {
            eprintln!("`krit watch` is not a subcommand. Subscribe to the event stream directly:");
            eprintln!("  ws://localhost:<port>/api/events-ws   (port from `krit state`)");
            std::process::exit(2);
        }
    }

    let mut port_arg: Option<u16> = None;
    let mut host = "127.0.0.1".to_string();
    let mut no_open = false;
    let mut positionals: Vec<String> = Vec::new();
    let mut past_dash_dash = false;
    let mut iter = raw_args.iter();
    while let Some(arg) = iter.next() {
        if past_dash_dash {
            positionals.push(arg.clone());
            continue;
        }
        match arg.as_str() {
            "--" => past_dash_dash = true,
            "-p" | "--port" => {
                let Some(v) = iter.next().and_then(|v| v.parse().ok()) else {
                    eprintln!("Error: --port requires a number");
                    std::process::exit(1);
                };
                port_arg = Some(v);
            }
            "--host" => {
                let Some(v) = iter.next() else {
                    eprintln!("Error: --host requires a value");
                    std::process::exit(1);
                };
                host = v.clone();
            }
            "--no-open" => no_open = true,
            "-h" | "--help" => {
                println!("{HELP}");
                return;
            }
            "-v" | "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return;
            }
            other if other.starts_with('-') => {
                eprintln!("Unknown option: {other} (git-diff args go after `--`)");
                std::process::exit(1);
            }
            other => positionals.push(other.to_string()),
        }
    }
    let custom_diff_args = if positionals.is_empty() {
        None
    } else {
        Some(positionals)
    };

    if !git::is_git_repo() {
        eprintln!("Error: not inside a git repository");
        std::process::exit(1);
    }

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(serve(port_arg, host, no_open, custom_diff_args));
}

fn run_subcommand(args: &[String]) {
    let rest = &args[1..];
    match args[0].as_str() {
        "state" => subcommands::cmd_state(),
        "comments" => {
            let filter = rest.first().map(|s| s.as_str()).unwrap_or("all");
            if !["open", "resolved", "replied", "all"].contains(&filter) {
                eprintln!("Unknown filter: {filter}. Use one of: open, resolved, replied, all.");
                std::process::exit(1);
            }
            subcommands::cmd_comments(filter);
        }
        "reply" => match rest {
            [id, body @ ..] if !body.is_empty() => subcommands::cmd_reply(id, &body.join(" ")),
            _ => {
                eprintln!("Usage: krit reply <comment-id> <text>");
                std::process::exit(1);
            }
        },
        "resolve" => match rest.first() {
            Some(id) => subcommands::cmd_resolve(id),
            None => {
                eprintln!("Usage: krit resolve <comment-id>");
                std::process::exit(1);
            }
        },
        "reopen" => match rest.first() {
            Some(id) => subcommands::cmd_reopen(id),
            None => {
                eprintln!("Usage: krit reopen <comment-id>");
                std::process::exit(1);
            }
        },
        "wait-for-submit" => subcommands::cmd_wait_for_submit(),
        "refresh" => subcommands::cmd_refresh(),
        _ => unreachable!(),
    }
}

async fn serve(
    port_arg: Option<u16>,
    host: String,
    no_open: bool,
    custom_diff_args: Option<Vec<String>>,
) {
    let repo_root = PathBuf::from(git::repo_root().expect("repo root (checked above)"));

    let state_path = default_state_path();
    let comment_store = store::CommentStore::new(Some(comments_store_path()));

    let hub = hub::Hub::new();
    let app_state = server::new_state(
        hub.clone(),
        comment_store,
        repo_root.clone(),
        custom_diff_args,
    );

    let bind_addr = format!("{}:{}", host, port_arg.unwrap_or(0));
    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        // v1 parity: a busy requested port falls back to a random free one —
        // the state file advertises whatever port we actually got.
        Err(err) if port_arg.is_some() => {
            eprintln!("Port {bind_addr} unavailable ({err}); using a random free port instead.");
            match tokio::net::TcpListener::bind(format!("{host}:0")).await {
                Ok(l) => l,
                Err(err) => {
                    eprintln!("Error: cannot bind {host}:0: {err}");
                    std::process::exit(1);
                }
            }
        }
        Err(err) => {
            eprintln!("Error: cannot bind {bind_addr}: {err}");
            std::process::exit(1);
        }
    };
    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let local_url = format!("http://{host}:{actual_port}");

    println!("krit server running at {local_url}");
    let write_result = write_state(
        &KritState {
            port: actual_port,
            pid: std::process::id(),
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            host: host.clone(),
            url: local_url.clone(),
            started_at: types::now_millis(),
            v: 2,
        },
        &state_path,
    );
    match write_result {
        Ok(()) => println!("state file: {}", state_path.display()),
        Err(err) => {
            eprintln!(
                "WARNING: could not write the state file at {}: {err}",
                state_path.display()
            );
            eprintln!(
                "Subcommands (`krit state`, `krit comments`, ...) will not find this server."
            );
            eprintln!(
                "If this shell is sandboxed, allow writes to that directory or point KRIT_STATE_FILE at one that is writable."
            );
        }
    }

    // Every exit path says why it's exiting and cleans the state file —
    // v1's silent-SIGTERM forensics episode, never again.
    {
        let state_path = state_path.clone();
        tokio::spawn(async move {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            let mut sigint =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                    .expect("SIGINT handler");
            tokio::select! {
                _ = sigterm.recv() => println!("Received SIGTERM — shutting down."),
                _ = sigint.recv() => println!("\nShutting down..."),
            }
            remove_state_if_owned(std::process::id(), &state_path);
            std::process::exit(0);
        });
    }

    hub.start_no_browser_timer();
    {
        // Belt-and-suspenders exit path (stalled graceful drain) must clean
        // the state file too, or later subcommands chase a dead pid.
        let state_path = state_path.clone();
        let pid = std::process::id();
        hub.set_exit_cleanup(move || remove_state_if_owned(pid, &state_path));
    }

    let open_url = if host == "0.0.0.0" {
        format!("http://127.0.0.1:{actual_port}")
    } else {
        local_url.clone()
    };
    if !no_open {
        launch_review_ui(&open_url);
        // Verify the launch produced a real client. Without this, a dropped
        // deep link looks like success until the no-browser timer kills the
        // review three silent minutes later.
        let hub = hub.clone();
        let url = open_url.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if !hub.had_browser() {
                println!(
                    "No UI has connected 10s after launch — if nothing opened, visit {url} in a browser."
                );
            }
        });
    } else {
        print_manual_url_hint(&local_url);
    }

    // Always-on fs-watcher; sync callback (broadcast::send is sync), safe
    // from the watcher thread. Setup runs on a blocking thread because the
    // debouncer's file-ID cache scans the whole repo tree — long enough on a
    // large repo to look like a hung server if it gates startup or serving.
    // The watcher is deliberately leaked: it must live for the whole process,
    // and every exit path goes through process::exit anyway.
    {
        let watcher_state = app_state.clone();
        let watcher_root = repo_root.clone();
        tokio::task::spawn_blocking(move || {
            let watcher = watcher::watch_repo(watcher_root, move |paths| {
                // Reanchor every changed file (each pass persists its own
                // moved comments once — see store::CommentStore::update_many),
                // then broadcast the whole tick as ONE files-changed frame
                // instead of one file-changed frame per path. Isolate each
                // path: coalescing means one panicking reanchor would otherwise
                // drop the whole tick's broadcast AND kill this (leaked,
                // never-restarted) watcher thread, silently ending live
                // refresh. catch_unwind keeps the rest of the tick and the
                // thread alive; no reanchor panic is reachable today, this
                // guards a future edit from regressing that.
                for path in &paths {
                    let reanchor = std::panic::AssertUnwindSafe(|| {
                        server::reanchor_and_broadcast(&watcher_state, path);
                    });
                    if std::panic::catch_unwind(reanchor).is_err() {
                        eprintln!("krit: reanchor panicked on '{path}', skipping it");
                    }
                }
                watcher_state
                    .hub
                    .broadcast(types::Event::FilesChanged { paths });
            });
            std::mem::forget(watcher);
        });
    }

    let router = server::build_router(app_state);
    let hub_for_shutdown = hub.clone();
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move { hub_for_shutdown.shutdown.notified().await })
        .await;

    remove_state_if_owned(std::process::id(), &state_path);
    if let Err(err) = result {
        eprintln!("krit: server error: {err}");
        std::process::exit(1);
    }
    std::process::exit(0);
}

fn print_manual_url_hint(url: &str) {
    println!("If the tab didn't open, visit {url} in your browser.");
    println!(
        "When you're done reviewing, click \"Done reviewing\" in the browser (Ctrl+C to abort)."
    );
}

/// Percent-encode a query-param value (RFC 3986 unreserved set kept bare).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// Best-effort window title for the desktop app — repo + branch. Cosmetic, so a
// git hiccup just drops it; the review still opens.
fn review_window_title() -> Option<String> {
    let repo = git::repo_name();
    if repo.is_empty() {
        return None;
    }
    let branch = git::branch_name();
    if branch.is_empty() {
        Some(repo)
    } else {
        Some(format!("{repo} · {branch}"))
    }
}

fn launch_review_ui(url: &str) {
    let settings = settings::load_settings();

    if settings["launcher"].as_str() == Some("app") {
        // The desktop app claims the krit:// scheme; this deep link routes to
        // the running instance (cold-starting it if needed), which reads `url`
        // and spawns a window pointed at this review's server.
        let mut deep_link = format!("krit://review?url={}", urlencode(url));
        if let Some(title) = review_window_title() {
            deep_link.push_str(&format!("&title={}", urlencode(&title)));
        }
        match open::that(&deep_link) {
            // Ok only means the OS accepted the URL — the app may not be
            // running or may drop the deep link. Don't claim it opened; the
            // connect check in serve() reports whether a UI actually arrived.
            Ok(()) => {
                println!("Asked the krit app to open this review.")
            }
            Err(err) => eprintln!(
                "Could not reach the krit app ({err}); is it installed? Falling back to the URL."
            ),
        }
        print_manual_url_hint(url);
        return;
    }

    // settings.browser, when set, names a specific browser app.
    let browser = settings["browser"].as_str().map(|s| s.to_string());
    let result = match &browser {
        Some(app) => open::with(url, app),
        None => open::that(url),
    };
    match result {
        Ok(()) => {
            println!(
                "Opened a browser tab. krit is now waiting for you to leave inline comments in the UI."
            );
        }
        Err(err) => {
            eprintln!("Could not open a browser tab automatically ({err}).");
        }
    }
    print_manual_url_hint(url);
}
