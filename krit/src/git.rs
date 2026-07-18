//! Everything git: krit shells out to the real `git` binary rather than
//! linking a git library — exact diff semantics (rename detection, diff
//! algorithms, textconv) for free, and it's the approach v1 proved.

use crate::pathsafe::is_safe_path;
use std::path::Path;
use std::process::Command;

/// Sentinels for the two non-ref content sources served alongside named git
/// refs for hunk expansion.
pub const WORKING_TREE_REF: &str = "WORKING_TREE";
pub const INDEX_REF: &str = "INDEX";

// Force standard unified diff regardless of user's git config
// (diff.external = difftastic, color.ui = always, etc).
const DIFF_FLAGS: [&str; 2] = ["--no-ext-diff", "--no-color"];

fn git_stdout(args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(out.stdout)
}

fn git_string(args: &[&str]) -> Option<String> {
    git_stdout(args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn is_git_repo() -> bool {
    git_string(&["rev-parse", "--is-inside-work-tree"]).is_some()
}

pub fn repo_root() -> Option<String> {
    git_string(&["rev-parse", "--show-toplevel"]).map(|s| s.trim().to_string())
}

pub fn repo_name() -> String {
    repo_root()
        .as_deref()
        .and_then(|r| Path::new(r).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn branch_name() -> String {
    git_string(&["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

pub fn custom_git_diff(args: &[String]) -> String {
    let mut cmd_args: Vec<&str> = vec!["diff"];
    cmd_args.extend(DIFF_FLAGS);
    cmd_args.extend(args.iter().map(|s| s.as_str()));
    git_string(&cmd_args).unwrap_or_default()
}

pub fn git_diff(staged: bool, untracked: bool, root: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();

    let unstaged = git_string(&["diff", DIFF_FLAGS[0], DIFF_FLAGS[1]]).unwrap_or_default();
    if !unstaged.is_empty() {
        parts.push(unstaged);
    }
    if staged {
        let s = git_string(&["diff", DIFF_FLAGS[0], DIFF_FLAGS[1], "--staged"]).unwrap_or_default();
        if !s.is_empty() {
            parts.push(s);
        }
    }
    if untracked {
        let u = untracked_files_diff(root);
        if !u.is_empty() {
            parts.push(u);
        }
    }
    parts.join("\n")
}

pub fn untracked_file_paths() -> Vec<String> {
    git_string(&["ls-files", "--others", "--exclude-standard"])
        .map(|out| {
            let trimmed = out.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                trimmed.lines().map(|l| l.to_string()).collect()
            }
        })
        .unwrap_or_default()
}

/// NUL byte in the first 8KB — git's own text/binary heuristic.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

// Untracked files have no git diff; synthesize a new-file patch per file so
// they render like any other addition. Shape (headers, sentinel index line,
// the leading '\n') matches v1 byte-for-byte — the UI parses this.
fn untracked_files_diff(root: &Path) -> String {
    let files = untracked_file_paths();
    if files.is_empty() {
        return String::new();
    }
    let mut patches: Vec<String> = Vec::new();
    for file in files {
        let abs = root.join(&file);
        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(_) => continue, // skip unreadable files
        };
        if looks_binary(&bytes) {
            patches.push(format!(
                "diff --git a/{file} b/{file}\nnew file mode 100644\nindex 0000000..0000001\nBinary files /dev/null and b/{file} differ"
            ));
        } else {
            let content = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = content.split('\n').collect();
            let mut patch = format!(
                "diff --git a/{file} b/{file}\nnew file mode 100644\nindex 0000000..0000001\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{} @@",
                lines.len()
            );
            for l in &lines {
                patch.push('\n');
                patch.push('+');
                patch.push_str(l);
            }
            patches.push(patch);
        }
    }
    if patches.is_empty() {
        String::new()
    } else {
        format!("\n{}", patches.join("\n"))
    }
}

/// File contents at a ref/sentinel, for hunk-context expansion. 50MB cap via
/// the read itself being bounded by practical repo contents (git enforces
/// nothing here; v1's maxBuffer existed for Node's exec plumbing).
pub fn file_content_at_ref(root: &Path, file_path: &str, git_ref: &str) -> Option<Vec<u8>> {
    if !is_safe_path(file_path) {
        return None;
    }
    if git_ref == WORKING_TREE_REF {
        return std::fs::read(root.join(file_path)).ok();
    }
    let spec = if git_ref == INDEX_REF {
        format!(":{file_path}")
    } else {
        format!("{git_ref}:{file_path}")
    };
    git_stdout(&["show", &spec])
}

/// Legacy two-version content fetch for GET /api/file-content:
/// new = working tree, old = HEAD.
pub fn file_content(root: &Path, file_path: &str, version: &str) -> Option<Vec<u8>> {
    if !is_safe_path(file_path) {
        return None;
    }
    if version == "new" {
        return std::fs::read(root.join(file_path)).ok();
    }
    git_stdout(&["show", &format!("HEAD:{file_path}")])
}

pub fn write_working_tree_file(root: &Path, file_path: &str, contents: &str) -> bool {
    if !is_safe_path(file_path) {
        return false;
    }
    std::fs::write(root.join(file_path), contents).is_ok()
}

/// Resolve a krit invocation to the (old, new) refs its patch was computed
/// against, mirroring `git diff`'s own semantics for each arg shape — see the
/// table in v1's git.ts. Wrong answers degrade to "no hunk expansion", not
/// corruption.
pub fn resolve_diff_refs(custom_args: Option<&[String]>) -> (String, String) {
    let args = custom_args.unwrap_or(&[]);
    let mut positionals: Vec<&str> = Vec::new();
    let mut staged = false;
    let mut past_dash_dash = false;
    for a in args {
        if past_dash_dash {
            continue; // pathspecs, not refs
        }
        if a == "--" {
            past_dash_dash = true;
            continue;
        }
        if a == "--staged" || a == "--cached" {
            staged = true;
            continue;
        }
        if a.starts_with('-') {
            continue; // other git-diff flags
        }
        positionals.push(a);
    }
    if staged {
        return ("HEAD".into(), INDEX_REF.into());
    }
    match positionals.len() {
        0 => ("HEAD".into(), WORKING_TREE_REF.into()),
        1 => {
            let a = positionals[0];
            if let Some((x, y)) = a.split_once("...") {
                let head = if y.is_empty() { "HEAD" } else { y };
                let merge_base = git_string(&["merge-base", x, head])
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| x.to_string());
                (merge_base, head.to_string())
            } else if let Some((x, y)) = a.split_once("..") {
                let head = if y.is_empty() { "HEAD" } else { y };
                (x.to_string(), head.to_string())
            } else {
                (a.to_string(), WORKING_TREE_REF.into())
            }
        }
        // 2+ positionals: first two are the refs (git's own behavior; extras
        // would be pathspecs).
        _ => (positionals[0].to_string(), positionals[1].to_string()),
    }
}
