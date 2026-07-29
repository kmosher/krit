//! CLI verbs that talk to the running krit server, discovered via the state
//! file. Blocking on purpose — these run and exit before the async runtime
//! ever starts.
//!
//! Each verb is split in two: a pure part that decides what to request and
//! what to say about the answer, and a thin wrapper that does the I/O and
//! calls `std::process::exit`. That puts the request shapes, the error
//! diagnoses and the SSE frame scanning under test. The wrappers are not
//! covered: the socket loop, `default_state_path`'s env-var resolution, and
//! every `process::exit` path still need a running server to exercise.

use crate::state::{KritState, default_state_path};
use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const SUBCOMMANDS: [&str; 7] = [
    "state",
    "comments",
    "reply",
    "resolve",
    "reopen",
    "wait-for-submit",
    "refresh",
];

// Missing file, unreadable file, and unparseable file are three different
// diagnoses (server never started / wrong KRIT_STATE_FILE vs permissions vs
// a stale-or-hand-written file) — collapsing them into one generic error
// turned each into a support thread. Always name the path checked.
#[derive(Debug)]
pub enum StateError {
    Missing(PathBuf),
    Unreadable(PathBuf, String),
    Invalid(PathBuf, String),
}

impl StateError {
    /// One stderr line per element, in order.
    fn lines(&self) -> Vec<String> {
        match self {
            StateError::Missing(path) => vec![
                format!(
                    "Error: no state file at {} — no running krit server found for this session.",
                    path.display()
                ),
                "Start one with `krit` first, or set KRIT_STATE_FILE to a state-file path."
                    .to_string(),
            ],
            StateError::Unreadable(path, err) => vec![format!(
                "Error: cannot read state file {}: {err}",
                path.display()
            )],
            StateError::Invalid(path, err) => vec![
                format!(
                    "Error: state file {} is not a valid krit state: {err}",
                    path.display()
                ),
                "Expected fields: port, pid, cwd, host, url, startedAt. Is it stale or hand-written?"
                    .to_string(),
            ],
        }
    }
}

fn read_state_at(path: &Path) -> Result<KritState, StateError> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(StateError::Missing(path.to_path_buf()));
        }
        Err(err) => return Err(StateError::Unreadable(path.to_path_buf(), err.to_string())),
    };
    serde_json::from_str(&content)
        .map_err(|err| StateError::Invalid(path.to_path_buf(), err.to_string()))
}

/// Resolves the running server's state file, or prints the diagnosis and
/// **exits the process with status 1** — every verb needs a server, so there
/// is nothing useful to return. The env-var lookup lives here rather than in
/// `read_state_at` because a test can't change it without racing every other
/// test.
fn require_state() -> KritState {
    match read_state_at(&default_state_path()) {
        Ok(state) => state,
        Err(err) => {
            for line in err.lines() {
                eprintln!("{line}");
            }
            std::process::exit(1);
        }
    }
}

fn base_url(state: &KritState) -> String {
    // 127.0.0.1 → localhost so sandbox host allowlists (which only accept
    // the name) don't block the loopback connection.
    state.url.replace("://127.0.0.1", "://localhost")
}

/// One request a verb makes. Naming the request as data is what lets a test
/// pin the wire contract of `reply`/`resolve`/`reopen`/`refresh` without a
/// server. That matters because these verbs print their success line
/// unconditionally — nothing but the shape of this struct stands between a
/// wrong route and a confident "refreshed".
#[derive(Debug, PartialEq)]
pub struct ApiCall {
    pub method: &'static str,
    pub path: String,
    pub body: Option<Value>,
}

#[derive(Debug)]
pub enum ApiError {
    Status {
        code: u16,
        status_text: String,
        method: &'static str,
        url: String,
        text: String,
    },
    Transport {
        url: String,
        err: String,
    },
}

impl ApiError {
    fn lines(&self) -> Vec<String> {
        match self {
            ApiError::Status {
                code,
                status_text,
                method,
                url,
                text,
            } => {
                let mut lines = vec![format!("Error: {code} {status_text} from {method} {url}")];
                if !text.is_empty() {
                    lines.push(text.clone());
                }
                lines
            }
            ApiError::Transport { url, err } => vec![
                format!("Error reaching krit at {url}: {err}"),
                "The state file points to a server that is not responding. Did krit crash?"
                    .to_string(),
            ],
        }
    }
}

fn call_api(base: &str, call: &ApiCall) -> Result<Value, ApiError> {
    let url = format!("{}{}", base, call.path);
    let req = ureq::request(call.method, &url);
    let result = match &call.body {
        Some(b) => req.send_json(b.clone()),
        None => req.call(),
    };
    match result {
        // A 2xx with a non-JSON body is still a success: these verbs care
        // that the server acted, not what it echoed back.
        Ok(res) => Ok(res.into_json::<Value>().unwrap_or(Value::Null)),
        Err(ureq::Error::Status(code, res)) => {
            let status_text = res.status_text().to_string();
            let text = res.into_string().unwrap_or_default();
            Err(ApiError::Status {
                code,
                status_text,
                method: call.method,
                url,
                text,
            })
        }
        Err(err) => Err(ApiError::Transport {
            url,
            err: err.to_string(),
        }),
    }
}

fn api(call: ApiCall) -> Value {
    let state = require_state();
    match call_api(&base_url(&state), &call) {
        Ok(value) => value,
        Err(err) => {
            for line in err.lines() {
                eprintln!("{line}");
            }
            std::process::exit(1);
        }
    }
}

pub fn cmd_state() {
    let state = require_state();
    println!("{}", serde_json::to_string_pretty(&state).unwrap());
}

fn comments_call() -> ApiCall {
    ApiCall {
        method: "GET",
        path: "/api/comments".to_string(),
        body: None,
    }
}

/// `replied` means "open and already answered" — the agent's own follow-up
/// queue — which is why it is not simply a status test.
fn filter_comments<'a>(all: &'a [Value], filter: &str) -> Vec<&'a Value> {
    all.iter()
        .filter(|c| match filter {
            "open" => c["status"] == "open",
            "resolved" => c["status"] == "resolved",
            "replied" => {
                c["status"] == "open"
                    && !c["replies"]
                        .as_array()
                        .map(|r| r.is_empty())
                        .unwrap_or(true)
            }
            _ => true,
        })
        .collect()
}

pub fn cmd_comments(filter: &str) {
    let comments = api(comments_call());
    let empty = Vec::new();
    let all = comments.as_array().unwrap_or(&empty);
    let filtered = filter_comments(all, filter);
    println!("{}", serde_json::to_string_pretty(&filtered).unwrap());
}

fn reply_call(id: &str, body: &str) -> ApiCall {
    // ?source=cli keeps this reply out of the reply-added broadcast, which
    // would otherwise wake the agent's own event subscription — ourselves.
    ApiCall {
        method: "POST",
        path: format!("/api/comments/{id}/replies?source=cli"),
        body: Some(json!({"body": body})),
    }
}

pub fn cmd_reply(id: &str, body: &str) {
    api(reply_call(id, body));
    println!("replied to {id}");
}

fn status_call(id: &str, status: &str) -> ApiCall {
    ApiCall {
        method: "PUT",
        path: format!("/api/comments/{id}"),
        body: Some(json!({ "status": status })),
    }
}

pub fn cmd_resolve(id: &str) {
    api(status_call(id, "resolved"));
    println!("resolved {id}");
}

pub fn cmd_reopen(id: &str) {
    api(status_call(id, "open"));
    println!("reopened {id}");
}

fn refresh_call() -> ApiCall {
    ApiCall {
        method: "POST",
        path: "/api/refresh".to_string(),
        body: None,
    }
}

pub fn cmd_refresh() {
    api(refresh_call());
    println!("refreshed");
}

/// Pull every complete SSE frame out of `buf`, returning the `submitted`
/// payload as soon as one appears. Split out because it is the whole of
/// wait-for-submit that can be wrong: everything else is a socket.
fn scan_for_submit(buf: &mut Vec<u8>) -> Option<Value> {
    // SSE frames are separated by a blank line.
    while let Some(idx) = buf.windows(2).position(|w| w == b"\n\n") {
        let frame = String::from_utf8_lossy(&buf[..idx]).into_owned();
        buf.drain(..idx + 2);
        let data: String = frame
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue; // ping/keep-alive
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if parsed["type"] == "submitted" {
            // `summary` is forwarded verbatim, including its absence: the
            // concluding notes are the point of waiting, and a caller that
            // json-parses this output must be able to tell "no notes" from
            // "empty notes" the same way the event does.
            let mut payload = json!({"submitted": true, "timestamp": parsed["timestamp"]});
            if let Some(summary) = parsed.get("summary").filter(|s| !s.is_null()) {
                payload["summary"] = summary.clone();
            }
            return Some(payload);
        }
    }
    None
}

/// Block until the user clicks "Done reviewing". Exits 0 on submit, 1 when
/// there's no reachable server or the state file is unusable (`require_state`
/// exits before the stream ever opens), 2 on connection loss before submit.
/// Retained for the batch workflow — the streaming flow subscribes to
/// /api/events-ws directly (see the skill).
pub fn cmd_wait_for_submit() -> ! {
    let state = require_state();
    let url = format!("{}/api/events?role=cli", base_url(&state));
    eprintln!("wait-for-submit: connected — review, then click Done reviewing in the browser.");

    let res = match ureq::get(&url).set("Accept", "text/event-stream").call() {
        Ok(res) => res,
        Err(err) => {
            eprintln!("wait-for-submit: cannot reach krit at {url}: {err}");
            std::process::exit(2);
        }
    };

    let mut reader = res.into_reader();
    // Buffered as raw bytes and decoded a whole frame at a time: a read
    // boundary lands anywhere, and decoding each 4 KiB chunk on its own turns
    // a multi-byte character straddling one into U+FFFD on both sides. The
    // frame's JSON then fails to parse and is silently skipped below — and
    // the frame dropped could be `submitted`, leaving this hanging until the
    // connection drops and exiting 2 on a review that did finish.
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) => break, // server closed the stream
            Ok(n) => n,
            Err(_) => break, // server went away mid-stream
        };
        buf.extend_from_slice(&chunk[..n]);
        if let Some(payload) = scan_for_submit(&mut buf) {
            println!("{payload}");
            std::process::exit(0);
        }
    }
    eprintln!("wait-for-submit: server closed the connection before submit fired.");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("krit-subcmd-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_with_url(url: &str) -> KritState {
        KritState {
            port: 1234,
            pid: 42,
            cwd: "/x".into(),
            host: "127.0.0.1".into(),
            url: url.into(),
            started_at: 1,
            v: 2,
        }
    }

    // --- state file ---------------------------------------------------

    #[test]
    fn a_missing_state_file_is_diagnosed_apart_from_a_corrupt_one() {
        // The three diagnoses drive three different user actions (start a
        // server / fix permissions / delete a stale file), so the variants
        // must not collapse into one another.
        let dir = tmpdir("missing");
        let path = dir.join("nope.json");
        let err = read_state_at(&path).err().unwrap();
        assert!(matches!(err, StateError::Missing(_)));
        let lines = err.lines();
        assert!(
            lines[0].contains(&path.display().to_string()),
            "the path checked must be named: {lines:?}"
        );
        assert!(lines[1].contains("KRIT_STATE_FILE"));

        std::fs::write(&path, "{not json").unwrap();
        let err = read_state_at(&path).err().unwrap();
        assert!(matches!(err, StateError::Invalid(..)));
        assert!(err.lines()[0].contains("not a valid krit state"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_well_formed_json_file_that_is_not_a_state_file_is_invalid_not_missing() {
        // A stale v1-shaped or hand-written file parses as JSON but lacks the
        // fields; reporting it as "no server running" sends the user to start
        // a second server on top of the one already there.
        let dir = tmpdir("wrong-shape");
        let path = dir.join("state.json");
        std::fs::write(&path, r#"{"port":1234}"#).unwrap();
        assert!(matches!(
            read_state_at(&path).err().unwrap(),
            StateError::Invalid(..)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_valid_state_file_round_trips() {
        let dir = tmpdir("valid");
        let path = dir.join("state.json");
        std::fs::write(
            &path,
            r#"{"port":5173,"pid":7,"cwd":"/w","host":"127.0.0.1","url":"http://127.0.0.1:5173","startedAt":9,"v":2}"#,
        )
        .unwrap();
        let state = read_state_at(&path).expect("parses");
        assert_eq!(state.port, 5173);
        assert_eq!(state.url, "http://127.0.0.1:5173");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_in_place_of_the_state_file_reports_unreadable() {
        // Not NotFound, so it must not claim there is no server — the path is
        // occupied by something, which is a configuration mistake.
        let dir = tmpdir("is-a-dir");
        assert!(matches!(
            read_state_at(&dir).err().unwrap(),
            StateError::Unreadable(..)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- URL construction ---------------------------------------------

    #[test]
    fn loopback_is_rewritten_to_localhost_but_the_port_survives() {
        // Sandbox host allowlists match on the name only; the rewrite exists
        // for that and must not disturb the port or the scheme.
        assert_eq!(
            base_url(&state_with_url("http://127.0.0.1:5173")),
            "http://localhost:5173"
        );
        assert_eq!(
            base_url(&state_with_url("https://127.0.0.1:443")),
            "https://localhost:443"
        );
    }

    #[test]
    fn a_non_loopback_host_is_left_alone() {
        // A 0.0.0.0 bind advertises a real host; rewriting it would point the
        // subcommand at the wrong machine.
        assert_eq!(
            base_url(&state_with_url("http://192.168.1.9:5173")),
            "http://192.168.1.9:5173"
        );
        assert_eq!(
            base_url(&state_with_url("http://localhost:8080")),
            "http://localhost:8080"
        );
        // Only the scheme-anchored form is a loopback authority — a host that
        // merely contains the digits keeps them.
        assert_eq!(
            base_url(&state_with_url("http://my127.0.0.1host:1")),
            "http://my127.0.0.1host:1"
        );
    }

    // --- request shapes -----------------------------------------------

    #[test]
    fn reply_posts_to_the_replies_route_and_suppresses_its_own_echo() {
        // Dropping ?source=cli makes the agent hear its own reply on the
        // event stream, which reads as a new user comment.
        let call = reply_call("abc-123", "Done.");
        assert_eq!(call.method, "POST");
        assert_eq!(call.path, "/api/comments/abc-123/replies?source=cli");
        assert_eq!(call.body, Some(json!({"body": "Done."})));
    }

    #[test]
    fn resolve_and_reopen_differ_only_in_the_status_they_send() {
        // Same route, same method: the status field is the entire difference,
        // so a swap here would silently invert both verbs.
        let resolve = status_call("id-1", "resolved");
        let reopen = status_call("id-1", "open");
        assert_eq!(resolve.method, "PUT");
        assert_eq!(resolve.path, "/api/comments/id-1");
        assert_eq!(resolve.body, Some(json!({"status": "resolved"})));
        assert_eq!(reopen.path, resolve.path);
        assert_eq!(reopen.body, Some(json!({"status": "open"})));
    }

    #[test]
    fn refresh_posts_to_the_refresh_route_with_no_body() {
        // `refresh` prints "refreshed" unconditionally, so the route is the
        // only thing standing between the user and a verb that reports
        // success while delivering nothing.
        let call = refresh_call();
        assert_eq!(call.method, "POST");
        assert_eq!(call.path, "/api/refresh");
        assert_eq!(call.body, None);
    }

    #[test]
    fn comments_gets_the_comments_route() {
        assert_eq!(comments_call().method, "GET");
        assert_eq!(comments_call().path, "/api/comments");
        assert_eq!(comments_call().body, None);
    }

    // --- comment filtering --------------------------------------------

    fn comment(id: &str, status: &str, replies: Value) -> Value {
        json!({"id": id, "status": status, "replies": replies})
    }

    fn ids(v: &[&Value]) -> Vec<String> {
        v.iter().map(|c| c["id"].as_str().unwrap().into()).collect()
    }

    #[test]
    fn each_filter_selects_its_own_slice() {
        let all = vec![
            comment("open-bare", "open", json!([])),
            comment("open-answered", "open", json!([{"body": "ok"}])),
            comment("done", "resolved", json!([{"body": "ok"}])),
        ];
        assert_eq!(
            ids(&filter_comments(&all, "open")),
            ["open-bare", "open-answered"]
        );
        assert_eq!(ids(&filter_comments(&all, "resolved")), ["done"]);
        // `replied` is the agent's follow-up queue: still open AND already
        // answered. A resolved-and-answered comment must not appear.
        assert_eq!(ids(&filter_comments(&all, "replied")), ["open-answered"]);
        assert_eq!(filter_comments(&all, "all").len(), 3);
    }

    #[test]
    fn an_unknown_filter_passes_everything_through() {
        // main.rs rejects unknown filters before we get here, so the fallback
        // must not silently hide comments if that check is ever bypassed.
        let all = vec![comment("a", "open", json!([]))];
        assert_eq!(filter_comments(&all, "nonsense").len(), 1);
        assert!(filter_comments(&[], "open").is_empty());
    }

    #[test]
    fn a_comment_with_no_replies_field_is_not_counted_as_replied() {
        // Older stores omit `replies` entirely; treating a missing array as
        // non-empty would put every open comment in the follow-up queue.
        let all = vec![json!({"id": "a", "status": "open"})];
        assert!(filter_comments(&all, "replied").is_empty());
        assert_eq!(filter_comments(&all, "open").len(), 1);
    }

    // --- HTTP round trip ----------------------------------------------

    struct Seen {
        request_line: String,
        body: String,
    }

    /// A one-shot HTTP server. Returns its base URL and a handle yielding the
    /// request it actually received, so a test can assert on the wire rather
    /// than on the `ApiCall` alone.
    fn one_shot(response: &'static str) -> (String, std::thread::JoinHandle<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 1024];
            // Read headers, then exactly Content-Length more bytes: the
            // client keeps the socket open, so reading to EOF would hang.
            let head_end = loop {
                let n = sock.read(&mut chunk).unwrap();
                raw.extend_from_slice(&chunk[..n]);
                if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
                if n == 0 {
                    break raw.len();
                }
            };
            let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            while raw.len() < head_end + len {
                let n = sock.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
            }
            sock.write_all(response.as_bytes()).unwrap();
            let _ = sock.flush();
            Seen {
                request_line: head.lines().next().unwrap_or_default().to_string(),
                body: String::from_utf8_lossy(&raw[head_end..]).into_owned(),
            }
        });
        (base, handle)
    }

    const OK_JSON: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";

    #[test]
    fn a_call_sends_the_method_path_and_json_body_it_was_given() {
        // The ApiCall assertions above pin intent; this pins that the intent
        // survives onto the socket.
        let (base, server) = one_shot(OK_JSON);
        let value = call_api(&base, &reply_call("c-9", "looks good")).expect("2xx");
        let seen = server.join().unwrap();
        assert_eq!(
            seen.request_line,
            "POST /api/comments/c-9/replies?source=cli HTTP/1.1"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&seen.body).unwrap(),
            json!({"body": "looks good"})
        );
        assert_eq!(value, json!({"ok": true}));
    }

    #[test]
    fn a_bodyless_call_sends_no_body() {
        let (base, server) = one_shot(OK_JSON);
        call_api(&base, &refresh_call()).expect("2xx");
        let seen = server.join().unwrap();
        assert_eq!(seen.request_line, "POST /api/refresh HTTP/1.1");
        assert!(seen.body.is_empty(), "unexpected body: {:?}", seen.body);
    }

    #[test]
    fn a_success_with_a_non_json_body_is_still_a_success() {
        // These verbs care that the server acted, not what it echoed; a 200
        // with an empty or HTML body must not be reported as a failure.
        let (base, server) = one_shot("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
        assert_eq!(call_api(&base, &refresh_call()).unwrap(), Value::Null);
        server.join().unwrap();

        let (base, server) = one_shot("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
        assert_eq!(call_api(&base, &refresh_call()).unwrap(), Value::Null);
        server.join().unwrap();
    }

    #[test]
    fn an_error_status_reports_the_code_the_verb_and_the_server_text() {
        // The body is where the server explains itself ("no such comment");
        // dropping it leaves the user with a bare 404.
        let (base, server) =
            one_shot("HTTP/1.1 404 Not Found\r\nContent-Length: 16\r\n\r\nno such comment\n");
        let err = call_api(&base, &status_call("ghost", "resolved")).unwrap_err();
        server.join().unwrap();
        let lines = err.lines();
        assert!(lines[0].starts_with("Error: 404 Not Found from PUT http://127.0.0.1:"));
        assert!(lines[0].ends_with("/api/comments/ghost"));
        assert_eq!(lines[1].trim(), "no such comment");
    }

    #[test]
    fn an_error_status_with_an_empty_body_prints_only_the_status_line() {
        // An empty second line would read as the server having said nothing
        // meaningful, which is worse than saying nothing at all.
        let (base, server) =
            one_shot("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
        let err = call_api(&base, &refresh_call()).unwrap_err();
        server.join().unwrap();
        assert_eq!(err.lines().len(), 1);
    }

    #[test]
    fn an_unreachable_server_says_the_state_file_is_stale() {
        // The state file is the only reason we tried this address, so the
        // diagnosis has to point at it — otherwise the user debugs the network.
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            drop(l);
            format!("http://127.0.0.1:{port}")
        };
        let err = call_api(&dead, &refresh_call()).unwrap_err();
        assert!(matches!(err, ApiError::Transport { .. }));
        let lines = err.lines();
        assert!(lines[0].starts_with("Error reaching krit at "));
        assert!(lines[1].contains("not responding"));
    }

    // --- wait-for-submit frame scanning --------------------------------

    #[test]
    fn submitted_is_recognised_and_carries_the_timestamp_through() {
        let mut buf = br#"data: {"type":"submitted","timestamp":1700000000000}

"#
        .to_vec();
        let payload = scan_for_submit(&mut buf).expect("submit seen");
        assert_eq!(
            payload,
            json!({"submitted": true, "timestamp": 1700000000000u64})
        );
    }

    #[test]
    fn frames_before_submit_are_consumed_without_ending_the_wait() {
        // Comments and pings stream continuously during a review; any one of
        // them ending the wait would exit before the user was done.
        let mut buf =
            b"data: {\"type\":\"comment-added\"}\n\n: ping\n\ndata: not json\n\n".to_vec();
        assert!(scan_for_submit(&mut buf).is_none());
        assert!(buf.is_empty(), "consumed frames must be drained");
    }

    #[test]
    fn a_frame_split_across_reads_is_held_until_it_is_complete() {
        // The read boundary lands anywhere. A half-frame must stay buffered:
        // parsing it early drops the frame, and the frame dropped could be
        // the submit that ends the review.
        let mut buf = br#"data: {"type":"submi"#.to_vec();
        assert!(scan_for_submit(&mut buf).is_none());
        assert_eq!(buf.len(), 20, "the partial frame must be kept verbatim");
        buf.extend_from_slice(b"tted\",\"timestamp\":5}\n\n");
        assert_eq!(scan_for_submit(&mut buf).unwrap()["timestamp"], json!(5));
    }

    #[test]
    fn a_multi_byte_character_straddling_a_read_boundary_survives() {
        // Decoding each chunk on its own turns a split character into U+FFFD
        // on both sides; the frame's JSON then fails to parse and is skipped.
        let frame = "data: {\"type\":\"comment-added\",\"body\":\"café ☕\"}\n\ndata: {\"type\":\"submitted\",\"timestamp\":7}\n\n";
        let bytes = frame.as_bytes();
        let mut buf = Vec::new();
        let mut found = None;
        // One byte at a time is the worst case of the same hazard.
        for b in bytes {
            buf.push(*b);
            if let Some(p) = scan_for_submit(&mut buf) {
                found = Some(p);
                break;
            }
        }
        assert_eq!(found.unwrap()["timestamp"], json!(7));
    }

    #[test]
    fn a_multi_line_data_frame_is_rejoined_before_parsing() {
        // SSE splits long payloads across repeated `data:` lines; parsing
        // them individually yields two JSON fragments and no submit.
        let mut buf = b"data: {\"type\":\ndata: \"submitted\",\"timestamp\":3}\n\n".to_vec();
        assert_eq!(scan_for_submit(&mut buf).unwrap()["timestamp"], json!(3));
    }

    #[test]
    fn concluding_notes_are_relayed_to_the_waiting_caller() {
        // The notes are why anything waits on this at all — dropping them here
        // would end the review with the reviewer's conclusions going nowhere.
        let mut buf = br#"data: {"type":"submitted","timestamp":9,"summary":"looks good, ship it"}

"#
        .to_vec();
        let payload = scan_for_submit(&mut buf).unwrap();
        assert_eq!(payload["summary"], json!("looks good, ship it"));
    }

    #[test]
    fn a_submit_with_no_notes_omits_the_field_rather_than_emptying_it() {
        // A caller parsing this output has to be able to distinguish "finished
        // without notes" from "notes were empty"; an always-present ""
        // collapses the two.
        let mut buf = br#"data: {"type":"submitted","timestamp":9}

"#
        .to_vec();
        let payload = scan_for_submit(&mut buf).unwrap();
        assert!(
            payload.get("summary").is_none(),
            "absent notes must stay absent, not become empty"
        );
    }

    #[test]
    fn an_explicitly_null_summary_is_treated_as_absent() {
        // A hand-rolled or older producer may serialize the field as null
        // rather than omitting it; relaying `"summary": null` would make every
        // consumer handle a third case for no reason.
        let mut buf = br#"data: {"type":"submitted","timestamp":9,"summary":null}

"#
        .to_vec();
        let payload = scan_for_submit(&mut buf).unwrap();
        assert!(payload.get("summary").is_none());
    }

    #[test]
    fn multi_line_notes_survive_the_frame_rejoin() {
        // Concluding notes are the one field a reviewer will press Enter in,
        // and SSE encodes a raw newline as a frame break. The JSON escape keeps
        // it one frame; this pins that it stays intact.
        let mut buf = br#"data: {"type":"submitted","timestamp":9,"summary":"one\ntwo"}

"#
        .to_vec();
        let payload = scan_for_submit(&mut buf).unwrap();
        assert_eq!(payload["summary"], json!("one\ntwo"));
    }

    #[test]
    fn a_submit_without_a_timestamp_still_ends_the_wait() {
        // The timestamp is informational; refusing to exit without one would
        // hang a review that genuinely finished.
        let mut buf = b"data: {\"type\":\"submitted\"}\n\n".to_vec();
        let payload = scan_for_submit(&mut buf).unwrap();
        assert_eq!(payload["submitted"], json!(true));
        assert_eq!(payload["timestamp"], Value::Null);
    }
}
