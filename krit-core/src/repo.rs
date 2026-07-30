//! Which review are we in? The worktree and branch that `state` keys every
//! per-review file by.
//!
//! These three shell out to git the way `krit::git` does, and lived there
//! until the TUI needed them: a client has to derive the same state-file path
//! the server wrote, which means asking git the same two questions. Everything
//! *else* in `krit::git` — diffing, blob reads, content tags — stays on the
//! server, and that asymmetry is the point. A client needs git to know which
//! review it is looking at, and never to compute one.
//!
//! Unlike most of `krit::git`, these read the process's ambient cwd rather
//! than taking a root: identity is "where the invocation happened", which is
//! the question being asked.

use std::path::Path;
use std::process::Command;

fn git_string(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn is_git_repo() -> bool {
    git_string(&["rev-parse", "--is-inside-work-tree"]).is_some()
}

pub fn repo_root() -> Option<String> {
    git_string(&["rev-parse", "--show-toplevel"])
}

pub fn repo_name() -> String {
    repo_root()
        .as_deref()
        .and_then(|r| Path::new(r).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn branch_name() -> String {
    git_string(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default()
}
