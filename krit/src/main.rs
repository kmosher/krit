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
                     0.0.0.0 to expose the server to the local network, in
                     which case krit mints an access token and off-machine
                     clients must open the tokenized URL it prints.
  --base <rev>       Base for the UI's "branch" scope, overriding the
                     baseBranches ladder in settings. Any rev. The scope diffs
                     the working tree against its merge-base with HEAD.
  --no-open          Don't open the browser automatically
  --idle-timeout <ms>
                     How long to keep serving after the last browser tab
                     disconnects (default: 5000; also KRIT_IDLE_TIMEOUT_MS).
                     The window exists to survive a page refresh; raise it if
                     something slower is in the loop. Clicking Done reviewing
                     bypasses it — the last tab closing then stops the server
                     at once.
  -v, --version      Show version number
  -h, --help         Show this help message

Subcommands (talk to the running krit server for the current session):
  state                       Print state JSON (port, pid, url, etc.)
  comments [filter]           List comments. filter: open | resolved | replied | all (default: all)
  reply <id> <text...>        Reply to a comment
  resolve <id>                Mark a comment resolved
  reopen <id>                 Reopen a resolved comment
  wait-for-submit             Block until the user clicks Done reviewing in the browser UI,
                              then print the submit as JSON — including `summary`, the
                              reviewer's concluding notes, when they wrote any
                              (exit 0 on submit, 1 if no server is reachable or
                              the state file is unusable, 2 if the connection
                              drops before submit)
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

    match dispatch(&raw_args) {
        Dispatch::Subcommand(idx) => {
            run_subcommand(&raw_args[idx..]);
            return;
        }
        Dispatch::RetiredWatch => {
            eprintln!("`krit watch` is not a subcommand. Subscribe to the event stream directly:");
            eprintln!("  ws://localhost:<port>/api/events-ws   (port from `krit state`)");
            // 64 (EX_USAGE), not 2: scripts gate the batch review flow on
            // wait-for-submit's exit codes, where 2 means "disconnected
            // before submit".
            std::process::exit(64);
        }
        Dispatch::Server => {}
    }

    let mut port_arg: Option<u16> = None;
    let mut host = "127.0.0.1".to_string();
    let mut no_open = false;
    let mut base_ref: Option<String> = None;
    // Flag beats env beats default; an unparseable env value is ignored rather
    // than fatal, since it can come from a shell profile the caller forgot.
    let mut idle_timeout_ms: Option<u64> = std::env::var("KRIT_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok());
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
            "--base" => {
                let Some(v) = iter.next() else {
                    eprintln!("Error: --base requires a revision");
                    std::process::exit(1);
                };
                base_ref = Some(v.clone());
            }
            "--idle-timeout" => {
                let Some(v) = iter.next().and_then(|v| v.parse().ok()) else {
                    eprintln!("Error: --idle-timeout requires a number of milliseconds");
                    std::process::exit(1);
                };
                idle_timeout_ms = Some(v);
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
    runtime.block_on(serve(
        port_arg,
        host,
        no_open,
        custom_diff_args,
        base_ref,
        idle_timeout_ms,
    ));
}

/// What argv means before any of it is acted on.
#[derive(Debug, PartialEq)]
enum Dispatch {
    /// argv[idx..] is a subcommand and its arguments.
    Subcommand(usize),
    RetiredWatch,
    Server,
}

/// Subcommand dispatch happens BEFORE flag parsing so git-diff flags don't get
/// rejected. The first non-flag argument — wherever it appears, not just
/// argv[1] — is treated as the subcommand, unless a `--` precedes it, which is
/// the hard signal that the rest is git-diff args. Running before flag parsing
/// means a flag's own value can be mistaken for a subcommand if it happens to
/// be one of the names (`krit --host state`); see the dispatch tests, which
/// pin that as current behavior rather than desired behavior.
fn dispatch(raw_args: &[String]) -> Dispatch {
    let dash_dash_idx = raw_args.iter().position(|a| a == "--");
    let Some(idx) = raw_args.iter().position(|a| !a.starts_with('-')) else {
        return Dispatch::Server;
    };
    if !dash_dash_idx.map(|d| idx < d).unwrap_or(true) {
        return Dispatch::Server;
    }
    if subcommands::SUBCOMMANDS.contains(&raw_args[idx].as_str()) {
        return Dispatch::Subcommand(idx);
    }
    // Retirement stub, mirroring v1's `diffx watch` stub: without it,
    // `krit watch` would fall through to the server path with `watch` as a
    // git-diff ref and launch an empty review.
    if raw_args[idx] == "watch" {
        return Dispatch::RetiredWatch;
    }
    Dispatch::Server
}

/// A subcommand invocation with its arguments already validated. `parse_verb`
/// performs no I/O and never exits, so every way an invocation can be rejected
/// is reachable from a test. Borrowed from argv where it can be; `Reply` owns
/// its body because that one is joined from several arguments.
#[derive(Debug, PartialEq)]
enum Verb<'a> {
    State,
    Comments(&'a str),
    Reply { id: &'a str, body: String },
    Resolve(&'a str),
    Reopen(&'a str),
    WaitForSubmit,
    Refresh,
}

const COMMENT_FILTERS: [&str; 4] = ["open", "resolved", "replied", "all"];

/// Err carries the exact usage line to print before exiting 1.
fn parse_verb(args: &[String]) -> Result<Verb<'_>, String> {
    let rest = &args[1..];
    match args[0].as_str() {
        "state" => Ok(Verb::State),
        "comments" => {
            let filter = rest.first().map(|s| s.as_str()).unwrap_or("all");
            if !COMMENT_FILTERS.contains(&filter) {
                return Err(format!(
                    "Unknown filter: {filter}. Use one of: open, resolved, replied, all."
                ));
            }
            Ok(Verb::Comments(filter))
        }
        // Unquoted review prose arrives as many argv entries; joining them
        // beats making every caller remember the quotes.
        "reply" => match rest {
            [id, body @ ..] if !body.is_empty() => Ok(Verb::Reply {
                id,
                body: body.join(" "),
            }),
            _ => Err("Usage: krit reply <comment-id> <text>".into()),
        },
        "resolve" => match rest.first() {
            Some(id) => Ok(Verb::Resolve(id)),
            None => Err("Usage: krit resolve <comment-id>".into()),
        },
        "reopen" => match rest.first() {
            Some(id) => Ok(Verb::Reopen(id)),
            None => Err("Usage: krit reopen <comment-id>".into()),
        },
        "wait-for-submit" => Ok(Verb::WaitForSubmit),
        "refresh" => Ok(Verb::Refresh),
        _ => unreachable!("dispatch() only routes names in SUBCOMMANDS"),
    }
}

fn run_subcommand(args: &[String]) {
    let verb = match parse_verb(args) {
        Ok(verb) => verb,
        Err(usage) => {
            eprintln!("{usage}");
            std::process::exit(1);
        }
    };
    match verb {
        Verb::State => subcommands::cmd_state(),
        Verb::Comments(filter) => subcommands::cmd_comments(filter),
        Verb::Reply { id, body } => subcommands::cmd_reply(id, &body),
        Verb::Resolve(id) => subcommands::cmd_resolve(id),
        Verb::Reopen(id) => subcommands::cmd_reopen(id),
        Verb::WaitForSubmit => subcommands::cmd_wait_for_submit(),
        Verb::Refresh => subcommands::cmd_refresh(),
    }
}

async fn serve(
    port_arg: Option<u16>,
    host: String,
    no_open: bool,
    custom_diff_args: Option<Vec<String>>,
    base_ref: Option<String>,
    idle_timeout_ms: Option<u64>,
) {
    let repo_root = PathBuf::from(git::repo_root().expect("repo root (checked above)"));

    let state_path = default_state_path();
    let comment_store = store::CommentStore::new(Some(comments_store_path()));

    // A bind that reaches other machines exposes the file-read and
    // file-write routes to everyone on the network, so it gets a token; a
    // loopback bind gets none and behaves exactly as it always has.
    let api_token = server::mint_api_token(&host);
    let token_query = match &api_token {
        Some(t) => format!("?krit_token={}", urlencode(t)),
        None => String::new(),
    };

    let hub = hub::Hub::new();
    if let Some(ms) = idle_timeout_ms {
        hub.set_idle_shutdown_ms(ms);
    }
    let app_state = server::new_state(
        hub.clone(),
        comment_store,
        repo_root.clone(),
        custom_diff_args,
        base_ref,
        api_token.clone(),
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
    // Only when overridden. A grace period set in a shell profile and long
    // forgotten is otherwise invisible until someone wonders why the port is
    // still held.
    if idle_timeout_ms.is_some() {
        println!(
            "idle timeout: {}ms after the last tab closes",
            hub.idle_shutdown_ms()
        );
    }
    if api_token.is_some() {
        // The state file stays token-free on purpose: subcommands connect
        // over loopback and never need it, so the secret has no reason to
        // sit in a temp file.
        println!("This bind is reachable from other machines, so they must use the access token:");
        println!("  {local_url}{token_query}");
    }
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

    // Tokenized even though this browser reaches us over loopback and would
    // be admitted anyway — one launch URL, valid from wherever it is opened,
    // beats a URL whose validity depends on which interface answered it.
    let open_url = if host == "0.0.0.0" {
        format!("http://127.0.0.1:{actual_port}{token_query}")
    } else {
        format!("{local_url}{token_query}")
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
        print_manual_url_hint(&format!("{local_url}{token_query}"));
    }

    // Always-on fs-watcher; sync callback (broadcast::send is sync), safe
    // from the watcher thread. Setup runs on a blocking thread because
    // registering a recursive watch is synchronous filesystem work, and
    // nothing about it should gate startup or serving.
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
    // with_connect_info, because the token check asks whether the peer is
    // this machine; without it every request looks remote.
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move { hub_for_shutdown.shutdown.notified().await })
    .await;

    remove_state_if_owned(std::process::id(), &state_path);
    if let Err(err) = result {
        eprintln!("krit: server error: {err}");
        std::process::exit(1);
    }
    std::process::exit(0);
}

fn manual_url_hint(url: &str) -> [String; 2] {
    [
        format!("If the tab didn't open, visit {url} in your browser."),
        "When you're done reviewing, click \"Done reviewing\" in the browser (Ctrl+C to abort)."
            .to_string(),
    ]
}

fn print_manual_url_hint(url: &str) {
    for line in manual_url_hint(url) {
        println!("{line}");
    }
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
    window_title_from(&git::repo_name(), &git::branch_name())
}

/// Builds the review window's title, or `None` when there is no repo name to
/// build it from. An empty branch drops only the branch half. The git lookups
/// stay in the wrapper above so these rules are testable without a repo.
fn window_title_from(repo: &str, branch: &str) -> Option<String> {
    if repo.is_empty() {
        return None;
    }
    if branch.is_empty() {
        Some(repo.to_string())
    } else {
        Some(format!("{repo} · {branch}"))
    }
}

/// Hands the deep link to the OS, reporting *why* it failed rather than only
/// that it did. `open::that` collapses everything into an exit status, which is
/// how a sandbox denial and a missing app arrive looking identical; going
/// through the launcher directly keeps its stderr, which distinguishes them.
#[cfg(target_os = "macos")]
fn spawn_deep_link(link: &str) -> Result<(), String> {
    match std::process::Command::new("/usr/bin/open")
        .arg("--")
        .arg(link)
        .output()
    {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stderr = stderr.trim();
            if stderr.is_empty() {
                Err(format!("`open` exited with {}", out.status))
            } else {
                Err(format!("`open` exited with {}: {stderr}", out.status))
            }
        }
        Err(err) => Err(format!("could not run `open`: {err}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn spawn_deep_link(link: &str) -> Result<(), String> {
    open::that(link).map_err(|err| err.to_string())
}

/// What to print when the deep link doesn't launch. The failure is worth this
/// much text because of who hits it: the link is opened by a *child* process,
/// so an agent-driven session trips it whenever its own sandbox blocks that
/// child — `krit` itself runs fine, no window appears, and the old wording
/// ("is it installed?") sent the reader after a healthy app install. Naming the
/// spawned launcher, and the one flag that fixes it, is the difference between
/// a dead end and a one-line fix.
fn deep_link_failure_message(reason: &str) -> String {
    let mut out = String::new();
    out.push_str("Could not hand this review to the krit app.\n");
    out.push_str(&format!("  reason: {reason}\n"));
    out.push_str(
        "  The krit:// link is opened by a spawned `open`, which a sandbox can\n\
         \x20 block even when krit itself runs fine. Under Claude Code, re-run\n\
         \x20 the krit command with dangerouslyDisableSandbox: true. Otherwise\n\
         \x20 check that krit.app is installed and claims the krit:// scheme.\n",
    );
    out
}

fn launch_review_ui(url: &str) {
    let loaded = settings::load_settings();
    // The UI gets this as a strip; the launcher is the only place a `launcher`
    // or `browser` preference is read, so a reviewer whose file is broken would
    // otherwise just see krit ignore it and open the wrong thing.
    if let Some(err) = &loaded.error {
        eprintln!("Warning: {err}; using default settings.");
    }
    let settings = loaded.effective;

    if settings["launcher"].as_str() == Some("app") {
        // The desktop app claims the krit:// scheme; this deep link routes to
        // the running instance (cold-starting it if needed), which reads `url`
        // and spawns a window pointed at this review's server.
        let mut deep_link = format!("krit://review?url={}", urlencode(url));
        if let Some(title) = review_window_title() {
            deep_link.push_str(&format!("&title={}", urlencode(&title)));
        }
        match spawn_deep_link(&deep_link) {
            // Ok only means the OS accepted the URL — the app may not be
            // running or may drop the deep link. Don't claim it opened; the
            // connect check in serve() reports whether a UI actually arrived.
            Ok(()) => {
                println!("Asked the krit app to open this review.")
            }
            Err(reason) => eprint!("{}", deep_link_failure_message(&reason)),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    // --- deep-link failure diagnosis -----------------------------------

    #[test]
    fn a_failed_deep_link_names_the_sandbox_and_the_flag_that_fixes_it() {
        let msg = deep_link_failure_message("`open` exited with exit status: 1");
        // The reason the launcher gave has to survive into the output — it is
        // what separates a blocked child from a missing app.
        assert!(msg.contains("`open` exited with exit status: 1"), "{msg}");
        // An agent reading this needs the cause and the remedy, not a guess
        // about the app install. Both halves are the point of the message.
        assert!(msg.contains("sandbox"), "{msg}");
        assert!(msg.contains("dangerouslyDisableSandbox: true"), "{msg}");
        // The old wording sent readers to reinstall a healthy app.
        assert!(!msg.contains("is it installed?"), "{msg}");
    }

    #[test]
    fn the_deep_link_failure_still_points_at_the_app_when_the_sandbox_is_not_the_cause() {
        // Sandbox first, but a genuinely missing app is the other real cause
        // and must not be dropped in favour of it.
        let msg = deep_link_failure_message("could not run `open`: No such file or directory");
        assert!(msg.contains("krit.app"), "{msg}");
        assert!(msg.contains("krit:// scheme"), "{msg}");
    }

    // --- argv dispatch -------------------------------------------------

    #[test]
    fn a_leading_subcommand_name_routes_to_the_subcommand() {
        assert_eq!(dispatch(&argv(&["state"])), Dispatch::Subcommand(0));
        assert_eq!(
            dispatch(&argv(&["reply", "abc", "done"])),
            Dispatch::Subcommand(0)
        );
        // Flags before the name are the server's, so the name is still found
        // at its own index and the whole tail goes to the subcommand.
        assert_eq!(
            dispatch(&argv(&["--no-open", "comments", "open"])),
            Dispatch::Subcommand(1)
        );
    }

    #[test]
    fn a_subcommand_name_after_dash_dash_is_a_git_diff_ref() {
        // `--` is the hard signal that the rest belongs to git diff. A branch
        // called `state` or a file named `refresh` must not hijack the run.
        assert_eq!(dispatch(&argv(&["--", "state"])), Dispatch::Server);
        assert_eq!(dispatch(&argv(&["--", "watch"])), Dispatch::Server);
        assert_eq!(dispatch(&argv(&["--", "--staged"])), Dispatch::Server);
    }

    #[test]
    fn the_retired_watch_stub_is_distinguished_from_a_normal_launch() {
        // Without the stub `krit watch` reaches git diff as a ref and opens
        // an empty review, which reads as krit being broken.
        assert_eq!(dispatch(&argv(&["watch"])), Dispatch::RetiredWatch);
        assert_eq!(dispatch(&argv(&["HEAD~3"])), Dispatch::Server);
        assert_eq!(dispatch(&argv(&[])), Dispatch::Server);
        assert_eq!(dispatch(&argv(&["-p", "8080"])), Dispatch::Server);
    }

    #[test]
    fn a_numeric_port_value_never_parses_as_a_subcommand() {
        assert_eq!(dispatch(&argv(&["-p", "9999"])), Dispatch::Server);
    }

    #[test]
    fn a_word_shaped_flag_value_is_currently_mistaken_for_a_subcommand() {
        // Known false positive, pinned rather than fixed: dispatch runs before
        // flag parsing, so it cannot know `--host` consumed the next word. No
        // real host or port is spelled like a verb, so the exposure today is
        // nil — but a future flag taking a word-shaped value inherits this,
        // and the failure mode is `krit` silently running a subcommand instead
        // of opening a review. Change this test when that becomes real.
        assert_eq!(
            dispatch(&argv(&["--host", "state"])),
            Dispatch::Subcommand(1)
        );
    }

    // --- verb parsing --------------------------------------------------

    #[test]
    fn comments_defaults_to_all_and_rejects_an_unknown_filter() {
        // A typo'd filter that silently fell through to `all` would show the
        // agent resolved comments it believes are still open.
        assert_eq!(
            parse_verb(&argv(&["comments"])).unwrap(),
            Verb::Comments("all")
        );
        assert_eq!(
            parse_verb(&argv(&["comments", "replied"])).unwrap(),
            Verb::Comments("replied")
        );
        let err = parse_verb(&argv(&["comments", "opne"])).unwrap_err();
        assert!(err.starts_with("Unknown filter: opne"));
        assert!(err.contains("open, resolved, replied, all"));
    }

    #[test]
    fn reply_joins_its_unquoted_prose_back_into_one_body() {
        // Agents invoke this without quoting; taking only argv[2] would
        // truncate every multi-word reply to its first word.
        assert_eq!(
            parse_verb(&argv(&["reply", "c-1", "looks", "good", "to", "me"])).unwrap(),
            Verb::Reply {
                id: "c-1",
                body: "looks good to me".into()
            }
        );
    }

    #[test]
    fn reply_needs_both_an_id_and_a_body() {
        // An id with no text would post an empty reply, which the reviewer
        // sees as a response that says nothing.
        assert_eq!(
            parse_verb(&argv(&["reply"])).unwrap_err(),
            "Usage: krit reply <comment-id> <text>"
        );
        assert_eq!(
            parse_verb(&argv(&["reply", "c-1"])).unwrap_err(),
            "Usage: krit reply <comment-id> <text>"
        );
    }

    #[test]
    fn resolve_and_reopen_require_an_id_and_ignore_extra_words() {
        assert_eq!(
            parse_verb(&argv(&["resolve", "c-2"])).unwrap(),
            Verb::Resolve("c-2")
        );
        assert_eq!(
            parse_verb(&argv(&["reopen", "c-2", "stray"])).unwrap(),
            Verb::Reopen("c-2")
        );
        assert!(parse_verb(&argv(&["resolve"])).is_err());
        assert!(parse_verb(&argv(&["reopen"])).is_err());
    }

    #[test]
    fn the_argument_free_verbs_take_no_arguments() {
        assert_eq!(parse_verb(&argv(&["state"])).unwrap(), Verb::State);
        assert_eq!(parse_verb(&argv(&["refresh"])).unwrap(), Verb::Refresh);
        assert_eq!(
            parse_verb(&argv(&["wait-for-submit"])).unwrap(),
            Verb::WaitForSubmit
        );
    }

    #[test]
    fn every_advertised_subcommand_parses() {
        // dispatch() routes on SUBCOMMANDS and parse_verb matches on names;
        // a name added to one list and not the other hits `unreachable!`.
        for name in subcommands::SUBCOMMANDS {
            let args = match name {
                "reply" => argv(&[name, "id", "text"]),
                "resolve" | "reopen" => argv(&[name, "id"]),
                _ => argv(&[name]),
            };
            assert!(parse_verb(&args).is_ok(), "{name} did not parse");
        }
    }

    // --- urlencode -----------------------------------------------------

    #[test]
    fn urlencode_keeps_the_unreserved_set_bare() {
        // These must NOT be escaped: the token and the launch URL both ride
        // through here, and over-escaping breaks the deep link as surely as
        // under-escaping does.
        let unreserved = "AZaz09-_.~";
        assert_eq!(urlencode(unreserved), unreserved);
    }

    #[test]
    fn urlencode_escapes_everything_that_would_end_the_query_param() {
        // The token is embedded as ?krit_token=<v> and the launch URL as
        // ?url=<v>; an unescaped & or = silently splits one param into two.
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode("http://x/y?z"), "http%3A%2F%2Fx%2Fy%3Fz");
        assert_eq!(urlencode(" "), "%20");
        assert_eq!(urlencode("+"), "%2B", "a bare + would decode as a space");
        assert_eq!(urlencode("#frag"), "%23frag");
    }

    #[test]
    fn urlencode_escapes_multi_byte_characters_one_byte_at_a_time() {
        // Percent-encoding is defined over bytes, not chars: encoding the
        // char's code point would produce something no decoder accepts.
        assert_eq!(urlencode("é"), "%C3%A9");
        assert_eq!(urlencode(""), "");
    }

    // --- window title and hint -----------------------------------------

    #[test]
    fn the_window_title_degrades_one_step_at_a_time() {
        // Cosmetic, so a git hiccup drops the affected half rather than the
        // launch: no repo means no title, no branch means repo alone.
        assert_eq!(
            window_title_from("krit", "main"),
            Some("krit · main".to_string())
        );
        assert_eq!(window_title_from("krit", ""), Some("krit".to_string()));
        assert_eq!(window_title_from("", "main"), None);
        assert_eq!(window_title_from("", ""), None);
    }

    #[test]
    fn the_manual_hint_carries_the_url_and_how_to_finish() {
        // This is the only instruction a user gets when the browser launch
        // failed, so it must contain both the address and the exit ritual.
        let [first, second] = manual_url_hint("http://127.0.0.1:5173?krit_token=abc");
        assert!(first.contains("http://127.0.0.1:5173?krit_token=abc"));
        assert!(second.contains("Done reviewing"));
    }
}
