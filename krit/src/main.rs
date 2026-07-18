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
    KritState, comments_file_path_for, default_state_path, remove_state_if_owned, write_state,
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
  krit writes a state file so subcommands can find the running server.
  Location priority:
    1. $KRIT_STATE_FILE
    2. $CLAUDE_TMPDIR/krit-state.json    (one krit per Claude Code session)
    3. ~/.krit/state-<hash(cwd)[:12]>.json"#;

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
        "reply" => {
            let (Some(id), body) = (rest.first(), rest[1.min(rest.len())..].join(" ")) else {
                eprintln!("Usage: krit reply <comment-id> <text>");
                std::process::exit(1);
            };
            if body.is_empty() {
                eprintln!("Usage: krit reply <comment-id> <text>");
                std::process::exit(1);
            }
            subcommands::cmd_reply(id, &body);
        }
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
    let comments_path = comments_file_path_for(&state_path);
    let comment_store = store::CommentStore::new(Some(comments_path));

    let hub = hub::Hub::new();
    let app_state = server::new_state(
        hub.clone(),
        comment_store,
        repo_root.clone(),
        custom_diff_args,
    );

    // Always-on fs-watcher; sync callback (broadcast::send is sync), safe
    // from the watcher thread. Kept alive until shutdown by binding.
    let watcher_state = app_state.clone();
    let _watcher = watcher::watch_repo(repo_root.clone(), move |path| {
        server::reanchor_and_broadcast(&watcher_state, &path);
        watcher_state
            .hub
            .broadcast(types::Event::FileChanged { path });
    });

    let bind_addr = format!("{}:{}", host, port_arg.unwrap_or(0));
    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(err) => {
            eprintln!("Error: cannot bind {bind_addr}: {err}");
            std::process::exit(1);
        }
    };
    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let local_url = format!("http://{host}:{actual_port}");

    println!("krit server running at {local_url}");
    write_state(
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
    println!("state file: {}", state_path.display());

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

    let open_url = if host == "0.0.0.0" {
        format!("http://127.0.0.1:{actual_port}")
    } else {
        local_url.clone()
    };
    if !no_open {
        launch_review_ui(&open_url);
    } else {
        print_manual_url_hint(&local_url);
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

fn launch_review_ui(url: &str) {
    // settings.browser, when set, names a specific browser app.
    let browser = settings::load_settings()["browser"]
        .as_str()
        .map(|s| s.to_string());
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
