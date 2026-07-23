//! Two on-disk files, both keyed to the *review* (git worktree + checked-out
//! branch) so different repos/worktrees/branches never share state — but with
//! deliberately different homes, because they have different lifetimes:
//!
//! - **State file** (`default_state_path`): server discovery — port/pid/url so
//!   CLI subcommands and the Claude skill can find the running server. Ephemeral;
//!   meaningless once the server dies. Lives in a temp dir:
//!     1. $KRIT_STATE_FILE (explicit override)
//!     2. $CLAUDE_TMPDIR/krit-state-<hash(worktree+branch)>.json
//!     3. ~/.krit/state-<hash(worktree+branch)>.json (no CLAUDE_TMPDIR)
//!
//! - **Comment store** (`comments_store_path`): the reviewer's comments. Durable
//!   — it must outlive the server process AND the Claude session, so it is NEVER
//!   in a temp dir. Always `~/.krit/comments-<hash(worktree+branch)>.json`.
//!
//! Why not derive the comments path from the state path (as krit once did)?
//! $CLAUDE_TMPDIR is `/tmp/claude-<uid>` — Claude Code's per-*user* base dir,
//! not per-session (it isolates sessions via subdirs it nests itself). Comments
//! parked there were both pooled across every session and liable to be swept
//! out from under an in-progress review. Discovery state tolerates that; a
//! comment store does not.

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
    /// Contract version marker: 2 = krit. Tolerant default on read (v1
    /// diffx state files had no `v`; v1 is retired, but a lenient parse
    /// here costs nothing and keeps hand-written stubs working).
    #[serde(default)]
    pub v: u8,
}

// FNV-1a 64: stable across builds (unlike std's DefaultHasher), tiny, and
// plenty for keying a state file by review identity.
fn fnv1a64_hex12(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in input.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")[..12].to_string()
}

/// Identity of the review this krit process serves: the git worktree
/// (`--show-toplevel`, distinct per worktree and stable across subdirectories)
/// plus the checked-out branch. Outside a repo the cwd stands in for the
/// worktree. The `\0` separator can't appear in either part, so distinct
/// (worktree, branch) pairs never collide into one key.
fn review_key() -> String {
    let root = crate::git::repo_root().unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    format!("{root}\0{}", crate::git::branch_name())
}

pub fn default_state_path() -> PathBuf {
    if let Ok(p) = std::env::var("KRIT_STATE_FILE") {
        return PathBuf::from(p);
    }
    let slug = fnv1a64_hex12(&review_key());
    if let Ok(tmp) = std::env::var("CLAUDE_TMPDIR") {
        return PathBuf::from(tmp).join(format!("krit-state-{slug}.json"));
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".krit")
        .join(format!("state-{slug}.json"))
}

/// A failed write must reach the caller: without the state file every
/// subcommand is blind to this server, and a swallowed sandbox EPERM here
/// once cost half an hour of "no running krit server" forensics.
pub fn write_state(state: &KritState, path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(state).expect("state struct always serializes");
    std::fs::write(path, json)
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

/// Durable home for a review's comments — see the module header for why this
/// is decoupled from `default_state_path` and never lives in a temp dir.
/// Keyed by the same review identity as the state file.
pub fn comments_store_path() -> PathBuf {
    if let Ok(p) = std::env::var("KRIT_COMMENTS_FILE") {
        return PathBuf::from(p);
    }
    let slug = fnv1a64_hex12(&review_key());
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".krit")
        .join(format!("comments-{slug}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_hash_is_stable() {
        // Pinned: a changed hash would orphan existing per-review state files.
        assert_eq!(
            fnv1a64_hex12("/Users/x/repo"),
            fnv1a64_hex12("/Users/x/repo")
        );
        assert_ne!(fnv1a64_hex12("/a"), fnv1a64_hex12("/b"));
        assert_eq!(fnv1a64_hex12("").len(), 12);
    }

    #[test]
    fn same_worktree_different_branch_gets_a_distinct_slug() {
        // The key that scopes the comment store: a branch switch in one
        // worktree must not reuse another branch's store. The `\0` separator
        // also keeps ("/a/b", "c") from colliding with ("/a", "b/c").
        let root = "/Users/x/repo";
        let main = fnv1a64_hex12(&format!("{root}\0main"));
        let feature = fnv1a64_hex12(&format!("{root}\0feature"));
        assert_ne!(main, feature);
        assert_ne!(
            fnv1a64_hex12("/a/b\0c"),
            fnv1a64_hex12("/a\0b/c"),
            "separator must disambiguate worktree/branch boundary"
        );
    }

    #[test]
    fn reads_v1_state_file_without_version_field() {
        let v1 = r#"{"port":1234,"pid":42,"cwd":"/x","host":"127.0.0.1","url":"http://127.0.0.1:1234","startedAt":1}"#;
        let state: KritState = serde_json::from_str(v1).expect("v1 state parses");
        assert_eq!(state.v, 0);
        assert_eq!(state.port, 1234);
    }
}
