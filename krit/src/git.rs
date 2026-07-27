//! Everything git: krit shells out to the real `git` binary rather than
//! linking a git library — exact diff semantics (rename detection, diff
//! algorithms, textconv) for free, and it's the approach v1 proved.

use crate::pathsafe::{is_safe_path, resolve_safe_path};
use std::path::Path;
use std::process::Command;

/// Sentinels for the two non-ref content sources served alongside named git
/// refs for hunk expansion.
pub const WORKING_TREE_REF: &str = "WORKING_TREE";
pub const INDEX_REF: &str = "INDEX";

// Force standard unified diff regardless of user's git config
// (diff.external = difftastic, color.ui = always, etc).
const DIFF_FLAGS: [&str; 2] = ["--no-ext-diff", "--no-color"];

/// Prepended to every `git diff` we parse. `core.quotePath=false` makes git
/// emit non-ASCII paths as raw UTF-8 in diff headers (`diff --git a/café.rs …`)
/// instead of C-quoted-and-escaped (`"a/caf\303\251.rs"`). Both the client and
/// server split a patch on the literal `diff --git a/` prefix; the quoted form
/// doesn't start with it, so such a file's diff would be silently dropped or
/// glued onto the preceding file. Off by default (`quotePath` defaults true).
const QUOTE_PATH_OFF: [&str; 2] = ["-c", "core.quotePath=false"];

/// Error carries git's own stderr — the diff paths surface it to the client
/// so a typo'd ref reads as an error, not as an empty "no changes" review.
fn git_output(args: &[&str]) -> Result<Vec<u8>, String> {
    match Command::new("git").args(args).output() {
        Ok(out) if out.status.success() => Ok(out.stdout),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(err) => Err(format!("failed to run git: {err}")),
    }
}

/// Same as `git_output`, pinned to `root` rather than the process's
/// inherited cwd — the diff calls below already carry `root` as a parameter
/// (for the untracked/content-read paths), so there's no reason to rely on
/// the ambient cwd matching it, the way the rest of this file's git_string
/// callers still do.
fn git_output_at(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    match Command::new("git").args(args).current_dir(root).output() {
        Ok(out) if out.status.success() => Ok(out.stdout),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(err) => Err(format!("failed to run git: {err}")),
    }
}

fn git_stdout(args: &[&str]) -> Option<Vec<u8>> {
    git_output(args).ok()
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

pub fn custom_git_diff(args: &[String]) -> Result<String, String> {
    let mut cmd_args: Vec<&str> = QUOTE_PATH_OFF.to_vec();
    cmd_args.push("diff");
    cmd_args.extend(DIFF_FLAGS);
    cmd_args.extend(args.iter().map(|s| s.as_str()));
    git_output(&cmd_args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Full-repo diff. `untracked_files`, when `Some`, is the caller's
/// already-computed `untracked_file_paths(root)` list (never recomputed
/// here) — see `git_diff_paths` for the path-scoped sibling both share.
pub fn git_diff(
    staged: bool,
    untracked_files: Option<&[String]>,
    root: &Path,
) -> Result<String, String> {
    diff_impl(staged, untracked_files, root, None)
}

/// Same as `git_diff`, but scoped to `paths` via a trailing `-- <paths>`
/// pathspec on every `git diff` invocation, so a targeted refetch (one
/// changed file, or the batch from a files-changed event) never pays for a
/// whole-repo diff just to slice one fragment back out of it.
/// `untracked_files` is filtered to the requested `paths` before synthesizing
/// their patches.
pub fn git_diff_paths(
    staged: bool,
    untracked_files: Option<&[String]>,
    root: &Path,
    paths: &[String],
) -> Result<String, String> {
    diff_impl(staged, untracked_files, root, Some(paths))
}

/// `-- <paths>` pathspec appended when scoping to specific files; omitted
/// (whole-repo diff) when `paths` is `None`.
fn scoped_args<'a>(base: &[&'a str], paths: Option<&'a [String]>) -> Vec<&'a str> {
    let mut args: Vec<&str> = base.to_vec();
    if let Some(paths) = paths {
        args.push("--");
        args.extend(paths.iter().map(|s| s.as_str()));
    }
    args
}

fn diff_impl(
    staged: bool,
    untracked_files: Option<&[String]>,
    root: &Path,
    paths: Option<&[String]>,
) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();

    let unstaged_args = scoped_args(
        &[
            QUOTE_PATH_OFF[0],
            QUOTE_PATH_OFF[1],
            "diff",
            DIFF_FLAGS[0],
            DIFF_FLAGS[1],
        ],
        paths,
    );
    let unstaged =
        git_output_at(root, &unstaged_args).map(|b| String::from_utf8_lossy(&b).into_owned())?;
    if !unstaged.is_empty() {
        parts.push(unstaged);
    }
    if staged {
        let staged_args = scoped_args(
            &[
                QUOTE_PATH_OFF[0],
                QUOTE_PATH_OFF[1],
                "diff",
                DIFF_FLAGS[0],
                DIFF_FLAGS[1],
                "--staged",
            ],
            paths,
        );
        let s =
            git_output_at(root, &staged_args).map(|b| String::from_utf8_lossy(&b).into_owned())?;
        if !s.is_empty() {
            parts.push(s);
        }
    }
    if let Some(untracked_files) = untracked_files {
        // Scope the synthesized-patch set to the requested paths too, so a
        // path-scoped request doesn't drag in every other untracked file.
        let scoped: Vec<String> = match paths {
            Some(paths) => untracked_files
                .iter()
                .filter(|f| paths.contains(f))
                .cloned()
                .collect(),
            None => untracked_files.to_vec(),
        };
        let u = untracked_files_diff_for(root, &scoped);
        if !u.is_empty() {
            parts.push(u);
        }
    }
    Ok(parts.join("\n"))
}

pub fn untracked_file_paths(root: &Path) -> Vec<String> {
    // Run from the repo root so paths come back root-relative regardless of
    // the server's launch cwd — from a subdir, cwd-relative output silently
    // dropped or mis-pathed untracked files (a bug v1 shared).
    // `-z`: NUL-delimited output is emitted verbatim, so a non-ASCII name
    // arrives as raw UTF-8 instead of the C-quoted-and-octal-escaped
    // `"caf\303\251.rs"` that quotePath produces (see QUOTE_PATH_OFF). These
    // names go straight into the untrackedFiles response, the synthesized
    // patch header, and the path-scoping check — a mangled one matches
    // nothing and renders as a binary placeholder under a wrong name.
    let Ok(out) = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(root)
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    out.stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

/// NUL byte in the first 8KB — git's own text/binary heuristic.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// One untracked file's synthesized new-file patch. Byte shape (headers,
/// sentinel index line, `@@` count, `+`-prefixed body) matches v1 exactly —
/// the UI parses this byte shape, so the two move together. `unreadable` files render
/// as the binary placeholder (v1's isBinaryFile reported true on read error).
fn synthesize_untracked_patch(file: &str, bytes: &[u8], unreadable: bool) -> String {
    if unreadable || looks_binary(bytes) {
        return format!(
            "diff --git a/{file} b/{file}\nnew file mode 100644\nindex 0000000..0000001\nBinary files /dev/null and b/{file} differ"
        );
    }
    let content = String::from_utf8_lossy(bytes);
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
    patch
}

// Untracked files have no git diff; synthesize a new-file patch per file so
// they render like any other addition. The whole block gets a leading '\n'
// so it joins onto the tracked-diff parts — matches v1 byte-for-byte. Takes
// the file list rather than calling `untracked_file_paths` itself: the
// caller (the diff endpoint) already computed it once for the response's
// `untrackedFiles` field, and re-running `ls-files` here would fork git a
// second time for the same answer.
fn untracked_files_diff_for(root: &Path, files: &[String]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut patches: Vec<String> = Vec::new();
    for file in files {
        // An unreadable file must not vanish from the patch while still
        // listed in untrackedFiles — it renders as the binary placeholder.
        let (bytes, unreadable) = match std::fs::read(root.join(file)) {
            Ok(b) => (b, false),
            Err(_) => (Vec::new(), true),
        };
        patches.push(synthesize_untracked_patch(file, &bytes, unreadable));
    }
    if patches.is_empty() {
        String::new()
    } else {
        format!("\n{}", patches.join("\n"))
    }
}

/// File contents at a ref/sentinel, for hunk-context expansion. No size cap
/// here — v1's 50MB maxBuffer was Node exec plumbing, not policy; the 5MB
/// text cap that protects the /api/diff payload lives in server.rs.
pub fn file_content_at_ref(root: &Path, file_path: &str, git_ref: &str) -> Option<Vec<u8>> {
    if !is_safe_path(file_path) {
        return None;
    }
    if git_ref == WORKING_TREE_REF {
        return std::fs::read(resolve_safe_path(root, file_path)?).ok();
    }
    let spec = if git_ref == INDEX_REF {
        format!(":{file_path}")
    } else {
        format!("{git_ref}:{file_path}")
    };
    git_output_at(root, &["show", &spec]).ok()
}

/// Two-version content fetch behind GET /api/file-content: new = working
/// tree, old = HEAD. The inline-edit flow rides on this — it seeds the editor
/// modal, supplies the `If-Match` base, and re-reads on a stale-write retry.
pub fn file_content(root: &Path, file_path: &str, version: &str) -> Option<Vec<u8>> {
    if !is_safe_path(file_path) {
        return None;
    }
    if version == "new" {
        return std::fs::read(resolve_safe_path(root, file_path)?).ok();
    }
    git_output_at(root, &["show", &format!("HEAD:{file_path}")]).ok()
}

/// Content fingerprint for the optimistic-concurrency token on
/// GET/PUT /api/file-content (`ETag` / `If-Match`). FNV-1a: this answers "did
/// the bytes change under me", not "did an adversary substitute them", so a
/// ten-line non-cryptographic hash beats taking on a hashing dependency. A
/// collision costs one lost overwrite warning, which is the behaviour every
/// client had before the token existed.
pub fn content_tag(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("\"{hash:016x}\"")
}

/// The tag a PUT's `If-Match` is checked against: the working-tree file as it
/// stands right now. `None` for a path that doesn't exist (or isn't readable),
/// which a caller sending `If-Match` should treat as a mismatch — it was
/// editing something that is no longer there.
pub fn working_tree_content_tag(root: &Path, file_path: &str) -> Option<String> {
    std::fs::read(resolve_safe_path(root, file_path)?)
        .ok()
        .map(|bytes| content_tag(&bytes))
}

pub fn write_working_tree_file(root: &Path, file_path: &str, contents: &str) -> bool {
    let Some(path) = resolve_safe_path(root, file_path) else {
        return false;
    };
    std::fs::write(path, contents).is_ok()
}

/// Resolve a krit invocation to the (old, new) refs its patch was computed
/// against, mirroring `git diff`'s own semantics for each arg shape. Wrong
/// answers degrade to "no hunk expansion", not corruption.
///
/// | args                | old              | new         |
/// |---------------------|------------------|-------------|
/// | (none)              | HEAD             | WORKING_TREE|
/// | `--staged`/`--cached`| HEAD            | INDEX       |
/// | `<ref>`             | `<ref>`          | WORKING_TREE|
/// | `<a>..<b>`          | `<a>`            | `<b>`       |
/// | `<a>..`             | `<a>`            | HEAD        |
/// | `<a>...<b>`         | merge-base(a, b) | `<b>`       |
/// | `<a> <b>` (2+)      | `<a>`            | `<b>`       |
///
/// An empty right side of `..`/`...` means HEAD. Flags are skipped and
/// everything after `--` is pathspec, so neither reaches the table.
pub fn resolve_diff_refs(custom_args: Option<&[String]>) -> (String, String) {
    // The server runs with the repo as its cwd, so `.` is that repo; the
    // parameterized form exists so the merge-base shell-out can be pointed at
    // a fixture repo instead of the ambient cwd.
    resolve_diff_refs_at(Path::new("."), custom_args)
}

fn resolve_diff_refs_at(root: &Path, custom_args: Option<&[String]>) -> (String, String) {
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
                let merge_base = git_output_at(root, &["merge-base", x, head])
                    .ok()
                    .map(|b| String::from_utf8_lossy(&b).trim().to_string())
                    .filter(|s| !s.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("krit-git-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@test.test"]);
        run(&["config", "user.name", "test"]);
        dir
    }

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn git_diff_paths_scopes_to_requested_files() {
        let root = init_repo("scoped");
        std::fs::write(root.join("a.rs"), "one\n").unwrap();
        std::fs::write(root.join("b.rs"), "two\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);

        std::fs::write(root.join("a.rs"), "one-changed\n").unwrap();
        std::fs::write(root.join("b.rs"), "two-changed\n").unwrap();

        let scoped = git_diff_paths(false, None, &root, &["a.rs".to_string()]).unwrap();
        assert!(scoped.contains("a.rs"));
        assert!(
            !scoped.contains("b.rs"),
            "scoping to a.rs must not pull in b.rs's diff at all: {scoped}"
        );

        let full = git_diff(false, None, &root).unwrap();
        assert!(full.contains("a.rs") && full.contains("b.rs"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_ascii_paths_emit_unquoted_headers() {
        // With core.quotePath on (git's default) the header would be
        // `diff --git "a/café.rs" "b/café.rs"`, which the client/server patch
        // splitters (both keyed on the literal `diff --git a/` prefix) can't
        // see. QUOTE_PATH_OFF must keep the path raw UTF-8 so the header
        // starts with `diff --git a/` and carries the real name.
        let root = init_repo("non-ascii");
        std::fs::write(root.join("café.rs"), "one\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join("café.rs"), "two\n").unwrap();

        let diff = git_diff(false, None, &root).unwrap();
        assert!(
            diff.contains("diff --git a/café.rs b/café.rs"),
            "header must be raw UTF-8, not C-quoted: {diff}"
        );
        // And the scoped path must find it (the batch-refetch hot path).
        let scoped = git_diff_paths(false, None, &root, &["café.rs".to_string()]).unwrap();
        assert!(scoped.contains("diff --git a/café.rs b/café.rs"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn untracked_non_ascii_names_come_back_unquoted() {
        // C-quoted output (`"caf\303\251.rs"`) would flow into untrackedFiles,
        // into the synthesized `diff --git a/…` header, and into the
        // path-scoping check — matching nothing under the file's real name.
        let root = init_repo("untracked-non-ascii");
        std::fs::write(root.join("café.rs"), "one\n").unwrap();

        let untracked = untracked_file_paths(&root);
        assert_eq!(untracked, vec!["café.rs".to_string()]);

        let diff = git_diff(false, Some(&untracked), &root).unwrap();
        assert!(
            diff.contains("diff --git a/café.rs b/café.rs"),
            "synthesized header must carry the real name: {diff}"
        );
        let scoped =
            git_diff_paths(false, Some(&untracked), &root, &["café.rs".to_string()]).unwrap();
        assert!(scoped.contains("diff --git a/café.rs b/café.rs"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_diff_paths_scopes_untracked_synthesis_to_requested_paths() {
        let root = init_repo("scoped-untracked");
        std::fs::write(root.join("tracked.rs"), "x\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);

        std::fs::write(root.join("new1.rs"), "n1\n").unwrap();
        std::fs::write(root.join("new2.rs"), "n2\n").unwrap();

        let untracked = untracked_file_paths(&root);
        assert_eq!(untracked.len(), 2, "both new files should be untracked");

        let scoped =
            git_diff_paths(false, Some(&untracked), &root, &["new1.rs".to_string()]).unwrap();
        assert!(scoped.contains("new1.rs"));
        assert!(
            !scoped.contains("new2.rs"),
            "untracked synthesis must be scoped to requested paths too: {scoped}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_single_file_param_routes_through_the_scoped_path() {
        // The 1-element case IS git_diff_paths — no separate single-file
        // code path.
        let root = init_repo("single-file-equivalence");
        std::fs::write(root.join("a.rs"), "one\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join("a.rs"), "one-changed\n").unwrap();

        let via_paths = git_diff_paths(false, None, &root, &["a.rs".to_string()]).unwrap();
        assert!(via_paths.contains("one-changed"));

        let _ = std::fs::remove_dir_all(&root);
    }

    fn refs(args: &[&str]) -> (String, String) {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        resolve_diff_refs(Some(&owned))
    }

    fn refs_at(root: &Path, args: &[&str]) -> (String, String) {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        resolve_diff_refs_at(root, Some(&owned))
    }

    // Pins the arg-shape → refs table documented on resolve_diff_refs (minus
    // the `...` merge-base row, which has its own repo-backed test).
    #[test]
    fn resolve_refs_table() {
        assert_eq!(
            resolve_diff_refs(None),
            ("HEAD".into(), WORKING_TREE_REF.into())
        );
        assert_eq!(refs(&[]), ("HEAD".into(), WORKING_TREE_REF.into()));
        assert_eq!(refs(&["--staged"]), ("HEAD".into(), INDEX_REF.into()));
        assert_eq!(refs(&["--cached"]), ("HEAD".into(), INDEX_REF.into()));
        assert_eq!(
            refs(&["HEAD~3"]),
            ("HEAD~3".into(), WORKING_TREE_REF.into())
        );
        assert_eq!(refs(&["main..feature"]), ("main".into(), "feature".into()));
        assert_eq!(refs(&["main.."]), ("main".into(), "HEAD".into()));
        assert_eq!(refs(&["a", "b"]), ("a".into(), "b".into()));
        assert_eq!(refs(&["a", "b", "path/spec"]), ("a".into(), "b".into()));
        // Flags are skipped; everything after `--` is pathspec, not refs.
        assert_eq!(
            refs(&["-M", "HEAD~1"]),
            ("HEAD~1".into(), WORKING_TREE_REF.into())
        );
        assert_eq!(
            refs(&["--", "src/"]),
            ("HEAD".into(), WORKING_TREE_REF.into())
        );
        assert_eq!(
            refs(&["HEAD~2", "--", "src/"]),
            ("HEAD~2".into(), WORKING_TREE_REF.into())
        );
    }

    #[test]
    fn three_dot_resolves_the_old_side_to_the_merge_base() {
        // `a...b` reviews only what b added since it forked. Resolving the old
        // side to `a` itself instead would mix everything that landed on the
        // base branch after the fork into the reviewer's own diff.
        let root = init_repo("three-dot");
        std::fs::write(root.join("f.rs"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "base"]);
        git(&root, &["branch", "-M", "main"]);
        git(&root, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(root.join("f.rs"), "feature\n").unwrap();
        git(&root, &["commit", "-q", "-am", "feature work"]);
        git(&root, &["checkout", "-q", "main"]);
        std::fs::write(root.join("g.rs"), "moved on\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "main moves on"]);
        git(&root, &["checkout", "-q", "feature"]);

        let expected = String::from_utf8(
            Command::new("git")
                .args(["merge-base", "main", "feature"])
                .current_dir(&root)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        let (old, new) = refs_at(&root, &["main...feature"]);
        assert_eq!(old, expected);
        assert_ne!(old, "main", "the merge base is not the base branch tip");
        assert_eq!(new, "feature");

        // Empty right side means HEAD, and the merge base is computed against
        // it rather than against the literal string.
        let (old, new) = refs_at(&root, &["main..."]);
        assert_eq!(old, expected);
        assert_eq!(new, "HEAD");

        // Two dots is the plain range: no merge base, both sides verbatim.
        assert_eq!(
            refs_at(&root, &["main..feature"]),
            ("main".into(), "feature".into())
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn staged_changes_appear_only_when_staged_is_set() {
        // `staged: true` is the shipped default, so a diff that drops the index
        // side renders an empty review after `git add`.
        let root = init_repo("staged-side");
        std::fs::write(root.join("a.rs"), "one\n").unwrap();
        std::fs::write(root.join("both.rs"), "one\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);

        std::fs::write(root.join("a.rs"), "staged-only\n").unwrap();
        git(&root, &["add", "a.rs"]);
        std::fs::write(root.join("both.rs"), "staged\n").unwrap();
        git(&root, &["add", "both.rs"]);
        std::fs::write(root.join("both.rs"), "staged-then-worktree\n").unwrap();

        let unstaged_only = git_diff(false, None, &root).unwrap();
        assert!(
            !unstaged_only.contains("staged-only"),
            "a purely staged edit must not appear on the unstaged side: {unstaged_only}"
        );

        let with_staged = git_diff(true, None, &root).unwrap();
        assert!(
            with_staged.contains("staged-only"),
            "the staged edit must be in the diff: {with_staged}"
        );
        // A file with edits on both sides contributes one header per side.
        assert_eq!(
            with_staged
                .lines()
                .filter(|l| *l == "diff --git a/both.rs b/both.rs")
                .count(),
            2,
            "both.rs has a staged and an unstaged hunk: {with_staged}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_untracked_block_starts_on_its_own_line() {
        // Every patch splitter keys on a line STARTING with `diff --git a/`.
        // Without the separator the untracked block's first header glues onto
        // the tail of the preceding tracked patch and that file disappears.
        let root = init_repo("untracked-join");
        std::fs::write(root.join("tracked.rs"), "one\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join("tracked.rs"), "two\n").unwrap();
        std::fs::write(root.join("fresh.rs"), "new\n").unwrap();

        let untracked = untracked_file_paths(&root);
        let diff = git_diff(false, Some(&untracked), &root).unwrap();
        let headers: Vec<&str> = diff
            .lines()
            .filter(|l| l.starts_with("diff --git a/"))
            .collect();
        assert_eq!(
            headers.len(),
            2,
            "one line-initial header each for the tracked and untracked file: {diff}"
        );

        // The block carries its own leading newline rather than trusting the
        // preceding part to have ended in one — that is what makes the header
        // line-initial no matter what it is appended to.
        assert!(
            untracked_files_diff_for(&root, &untracked).starts_with("\ndiff --git a/fresh.rs"),
            "the untracked block must open with a separator, not with its header"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn file_content_at_ref_serves_each_side_from_its_own_source() {
        // Hunk expansion asks for the exact side the patch was computed
        // against; crossing the wires shows the reviewer context that never
        // existed beside the hunk.
        let root = init_repo("content-at-ref");
        std::fs::write(root.join("f.rs"), "committed\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join("f.rs"), "staged\n").unwrap();
        git(&root, &["add", "f.rs"]);
        std::fs::write(root.join("f.rs"), "working\n").unwrap();

        let at =
            |r: &str| String::from_utf8(file_content_at_ref(&root, "f.rs", r).unwrap()).unwrap();
        assert_eq!(at(WORKING_TREE_REF), "working\n");
        assert_eq!(at(INDEX_REF), "staged\n");
        assert_eq!(at("HEAD"), "committed\n");
        assert!(file_content_at_ref(&root, "../escape", WORKING_TREE_REF).is_none());
        assert!(file_content_at_ref(&root, "../escape", "HEAD").is_none());

        // file_content is the two-version view the editor modal rides on: new
        // is the working tree (what a save would overwrite), old is HEAD.
        assert_eq!(
            String::from_utf8(file_content(&root, "f.rs", "new").unwrap()).unwrap(),
            "working\n"
        );
        assert_eq!(
            String::from_utf8(file_content(&root, "f.rs", "old").unwrap()).unwrap(),
            "committed\n"
        );
        assert!(file_content(&root, "../escape", "new").is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn binary_heuristic() {
        assert!(!looks_binary(b"plain text\n"));
        assert!(looks_binary(b"has\0nul"));
        assert!(!looks_binary(&[]));
    }

    // Golden byte-shape for the synthesized untracked-file patch, which the UI
    // parses directly. A whitespace or header change here breaks rendering with
    // no other test failing, so this is the one that has to fail loudly.
    #[test]
    fn untracked_patch_text_golden() {
        assert_eq!(
            synthesize_untracked_patch("src/new.rs", b"line1\nline2", false),
            "diff --git a/src/new.rs b/src/new.rs\n\
             new file mode 100644\n\
             index 0000000..0000001\n\
             --- /dev/null\n\
             +++ b/src/new.rs\n\
             @@ -0,0 +1,2 @@\n\
             +line1\n\
             +line2"
        );
    }

    #[test]
    fn untracked_patch_trailing_newline_counts_as_line() {
        // "a\n" splits into ["a", ""] → 2 lines, matching git/v1.
        assert_eq!(
            synthesize_untracked_patch("f", b"a\n", false),
            "diff --git a/f b/f\n\
             new file mode 100644\n\
             index 0000000..0000001\n\
             --- /dev/null\n\
             +++ b/f\n\
             @@ -0,0 +1,2 @@\n\
             +a\n\
             +"
        );
    }

    #[test]
    fn untracked_patch_binary_and_unreadable_use_placeholder() {
        let expected = "diff --git a/x b/x\n\
             new file mode 100644\n\
             index 0000000..0000001\n\
             Binary files /dev/null and b/x differ";
        assert_eq!(synthesize_untracked_patch("x", b"\0\x01", false), expected);
        // Unreadable (empty bytes + flag) still renders, doesn't vanish.
        assert_eq!(synthesize_untracked_patch("x", b"", true), expected);
    }

    #[test]
    fn content_tag_is_stable_and_content_sensitive() {
        assert_eq!(content_tag(b"hello"), content_tag(b"hello"));
        assert_ne!(content_tag(b"hello"), content_tag(b"hello\n"));
        // Quoted, so it can go straight into an ETag / If-Match header.
        assert!(content_tag(b"hello").starts_with('"'));
        assert!(content_tag(b"hello").ends_with('"'));
    }

    #[test]
    fn working_tree_content_tag_tracks_disk_and_is_none_when_absent() {
        let dir = init_repo("content-tag");
        std::fs::write(dir.join("f.txt"), "one").unwrap();
        let first = working_tree_content_tag(&dir, "f.txt").unwrap();
        assert_eq!(first, content_tag(b"one"));
        std::fs::write(dir.join("f.txt"), "two").unwrap();
        assert_ne!(working_tree_content_tag(&dir, "f.txt").unwrap(), first);
        // A path that isn't there reads as None -- a caller holding an
        // If-Match for it should see a mismatch, not a silent pass.
        assert!(working_tree_content_tag(&dir, "gone.txt").is_none());
        // Unsafe paths never get a tag either.
        assert!(working_tree_content_tag(&dir, "../escape").is_none());
    }
}
