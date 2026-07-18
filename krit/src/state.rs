//! Session state file: how CLI subcommands and the Claude skill discover the
//! running server. Same discovery scheme as v1 with krit's own namespace, so
//! v1 and v2 sessions never collide:
//!   1. $KRIT_STATE_FILE (explicit override)
//!   2. $CLAUDE_TMPDIR/krit-state.json (one krit per Claude Code session)
//!   3. ~/.krit/state-<hash(cwd)[:12]>.json (keyed by cwd for plain shells)

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KritState {
    pub port: u16,
    pub pid: u32,
    pub cwd: String,
    pub host: String,
    pub url: String,
    pub started_at: u64,
    /// Contract version marker: 2 = krit. Absent in v1 diffx state files.
    pub v: u8,
}

// FNV-1a 64: stable across builds (unlike std's DefaultHasher), tiny, and
// plenty for keying a state file by cwd.
fn fnv1a64_hex12(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in input.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")[..12].to_string()
}

pub fn default_state_path() -> PathBuf {
    if let Ok(p) = std::env::var("KRIT_STATE_FILE") {
        return PathBuf::from(p);
    }
    if let Ok(tmp) = std::env::var("CLAUDE_TMPDIR") {
        return PathBuf::from(tmp).join("krit-state.json");
    }
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".krit")
        .join(format!("state-{}.json", fnv1a64_hex12(&cwd)))
}

pub fn write_state(state: &KritState, path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, json);
    }
}

pub fn read_state(path: &Path) -> Option<KritState> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Remove the state file only if it still advertises this pid — a newer
/// server may have overwritten it before this one's shutdown handler runs.
pub fn remove_state_if_owned(pid: u32, path: &Path) {
    if let Some(current) = read_state(path)
        && current.pid != pid
    {
        return;
    }
    let _ = std::fs::remove_file(path);
}

/// Comments persist next to the state file, same session identity.
pub fn comments_file_path_for(state_path: &Path) -> PathBuf {
    let s = state_path.to_string_lossy();
    let base = s.strip_suffix(".json").unwrap_or(&s);
    PathBuf::from(format!("{base}.comments.json"))
}
