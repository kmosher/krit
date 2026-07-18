//! CLI verbs that talk to the running krit server, discovered via the state
//! file. Blocking on purpose — these run and exit before the async runtime
//! ever starts.

use crate::state::{KritState, default_state_path, read_state};
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

fn require_state() -> KritState {
    match read_state(&default_state_path()) {
        Some(s) => s,
        None => {
            eprintln!("Error: no running krit server found for this session.");
            eprintln!("Start one with `krit` first, or set KRIT_STATE_FILE to a state-file path.");
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

/// Block until the user clicks "Done reviewing". Exit 0 on submit, 2 on
/// connection loss before submit. Retained for the batch workflow — the
/// streaming flow subscribes to /api/events-ws directly (see the skill).
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
    let mut buf = String::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) => break, // server closed the stream
            Ok(n) => n,
            Err(_) => break, // server went away mid-stream
        };
        buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
        // SSE frames are separated by a blank line.
        while let Some(idx) = buf.find("\n\n") {
            let frame = buf[..idx].to_string();
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
