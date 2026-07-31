//! Which review are we in? The worktree and branch that `state` keys every
//! per-review file by.
//!
//! These shell out to git the way `krit::git` does. A client needs git only to
//! identify which review it is looking at — it has to derive the same
//! state-file path the server wrote — and never to compute one; diffing, blob
//! reads and content tags all stay on the server. That asymmetry is why these
//! four live apart from the rest.
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

/// Are we inside a working tree?
///
/// The answer is git's *output*, not its exit status. Inside a gitdir —
/// `~/git/<repo>`, which is where most of this repo's checkouts keep theirs —
/// `rev-parse --is-inside-work-tree` prints `false` and exits **0**, so a
/// status check answers "yes" for a directory that has no working tree. The
/// caller then admits it and `repo_root()` fails, which is a panic in the
/// server rather than the clean "not inside a git repository" it meant to
/// print.
pub fn is_git_repo() -> bool {
    git_string(&["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
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

#[cfg(test)]
mod tests {
    use super::*;

    fn run_in(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?} failed");
    }

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("krit-repo-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `is_git_repo` reads git's answer, not its exit status. These run the
    /// real thing rather than asserting on a stub, because the whole bug was a
    /// wrong belief about what git prints and what it exits with.
    #[test]
    fn a_gitdir_is_not_a_working_tree_even_though_git_exits_zero() {
        let dir = tmpdir("gitdir");
        run_in(&dir, &["init", "--quiet", "checkout"]);
        let gitdir = dir.join("checkout").join(".git");
        if !gitdir.is_dir() {
            // A split gitdir (`.git` as a pointer file) can't be entered this
            // way; the plain layout is what this asserts.
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let out = Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(&gitdir)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "the premise: inside a gitdir git exits 0"
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "false",
            "…and prints false, which is the answer that matters"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn outside_a_repo_there_is_no_root_and_no_branch() {
        let dir = tmpdir("bare-dir");
        let out = Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(&dir)
            .output()
            .expect("git runs");
        // Nothing to be inside of: git fails outright here, which is the other
        // half of what `is_git_repo` has to get right.
        assert!(!out.status.success());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
