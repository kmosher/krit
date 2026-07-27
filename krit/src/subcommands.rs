//! CLI verbs that talk to the running krit server, discovered via the state
//! file. Blocking on purpose — these run and exit before the async runtime
//! ever starts.

use crate::state::{KritState, default_state_path};
use serde_json::{Value, json};
use std::io::Read;

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
fn require_state() -> KritState {
    let path = default_state_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "Error: no state file at {} — no running krit server found for this session.",
                path.display()
            );
            eprintln!("Start one with `krit` first, or set KRIT_STATE_FILE to a state-file path.");
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("Error: cannot read state file {}: {err}", path.display());
            std::process::exit(1);
        }
    };
    match serde_json::from_str(&content) {
        Ok(s) => s,
        Err(err) => {
            eprintln!(
                "Error: state file {} is not a valid krit state: {err}",
                path.display()
            );
            eprintln!(
                "Expected fields: port, pid, cwd, host, url, startedAt. Is it stale or hand-written?"
            );
            std::process::exit(1);
        }
    }
}

fn base_url(state: &KritState) -> String {
    // 127.0.0.1 → localhost so sandbox host allowlists (which only accept
    // the name) don't block the loopback connection.
    state.url.replace("://127.0.0.1", "://localhost")
}

fn api(method: &str, path: &str, body: Option<Value>) -> Value {
    let state = require_state();
    let url = format!("{}{}", base_url(&state), path);
    let req = ureq::request(method, &url);
    let result = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match result {
        Ok(res) => res.into_json::<Value>().unwrap_or(Value::Null),
        Err(ureq::Error::Status(code, res)) => {
            eprintln!(
                "Error: {} {} from {} {}",
                code,
                res.status_text(),
                method,
                url
            );
            if let Ok(text) = res.into_string()
                && !text.is_empty()
            {
                eprintln!("{text}");
            }
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("Error reaching krit at {url}: {err}");
            eprintln!("The state file points to a server that is not responding. Did krit crash?");
            std::process::exit(1);
        }
    }
}

pub fn cmd_state() {
    let state = require_state();
    println!("{}", serde_json::to_string_pretty(&state).unwrap());
}

pub fn cmd_comments(filter: &str) {
    let comments = api("GET", "/api/comments", None);
    let empty = Vec::new();
    let all = comments.as_array().unwrap_or(&empty);
    let filtered: Vec<&Value> = all
        .iter()
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
        .collect();
    println!("{}", serde_json::to_string_pretty(&filtered).unwrap());
}

pub fn cmd_reply(id: &str, body: &str) {
    // ?source=cli keeps this reply out of the reply-added broadcast, which
    // would otherwise wake the agent's own event subscription — ourselves.
    api(
        "POST",
        &format!("/api/comments/{id}/replies?source=cli"),
        Some(json!({"body": body})),
    );
    println!("replied to {id}");
}

pub fn cmd_resolve(id: &str) {
    api(
        "PUT",
        &format!("/api/comments/{id}"),
        Some(json!({"status": "resolved"})),
    );
    println!("resolved {id}");
}

pub fn cmd_reopen(id: &str) {
    api(
        "PUT",
        &format!("/api/comments/{id}"),
        Some(json!({"status": "open"})),
    );
    println!("reopened {id}");
}

pub fn cmd_refresh() {
    api("POST", "/api/refresh", None);
    println!("refreshed");
}

/// Block until the user clicks "Done reviewing". Exits 0 on submit, 1 when
/// there's no reachable server or the state file is unusable (`require_state`
/// exits before the stream ever opens), 2 on connection loss before submit.
/// Retained for the batch workflow — the streaming flow subscribes to
/// /api/events-ws directly (see the skill).
pub fn cmd_wait_for_submit() -> ! {
    let state = require_state();
    let url = format!("{}/api/events?role=cli", base_url(&state));
    eprintln!(
        "wait-for-submit: connected — leave comments and click Done reviewing in the browser."
    );

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
                println!(
                    "{}",
                    json!({"submitted": true, "timestamp": parsed["timestamp"]})
                );
                std::process::exit(0);
            }
        }
    }
    eprintln!("wait-for-submit: server closed the connection before submit fired.");
    std::process::exit(2);
}
