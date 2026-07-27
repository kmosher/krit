//! Path traversal defense, shared by every handler that touches the repo
//! from a client-supplied relative path.

use std::path::{Path, PathBuf};

fn hex_val(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|v| v as u8)
}

/// Percent-decode without pulling in a dep; invalid sequences pass through
/// verbatim (matching decodeURIComponent-with-fallback in v1). Works on raw
/// bytes throughout — slicing the &str here would panic on a multibyte
/// character right after a '%' (e.g. a file named `50%割引.txt`).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push(hi * 16 + lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Lexical half of the defense: true when `relative_path` cannot escape its
/// base by spelling alone — no `..` component, no NUL, not absolute (unix or
/// windows-drive), after percent-decoding and backslash normalization. The
/// file need not exist. Symlinks are invisible to it; anything that then
/// touches the filesystem must go through `resolve_safe_path`.
pub fn is_safe_path(relative_path: &str) -> bool {
    let normalized = percent_decode(relative_path).replace('\\', "/");
    if normalized.contains('\0') {
        return false;
    }
    // Component-wise, not a substring test: `foo..bar.rs` and `..hidden` are
    // legal filenames that appear in real diffs, and rejecting them makes
    // every operation on such a file fail silently.
    if normalized.split('/').any(|c| c == ".." || c == ".") {
        return false;
    }
    if normalized.starts_with('/') {
        return false;
    }
    // Windows drive letters ("C:/...") — not expected on this platform but
    // cheap to reject.
    let mut chars = normalized.chars();
    if let (Some(c), Some(':')) = (chars.next(), chars.next())
        && c.is_ascii_alphabetic()
    {
        return false;
    }
    true
}

/// The check to use before any read or write: `is_safe_path` plus the
/// filesystem's own answer. A symlink *inside* the repo pointing outside it
/// satisfies every lexical rule, and `std::fs` follows it — so the resolved
/// location, not the spelling, is what has to land under `root`.
///
/// Returns the absolute path to operate on. The target may legitimately not
/// exist (a new-file write), in which case its parent directory is the thing
/// canonicalized; a parent that doesn't exist either is rejected, since
/// nothing can be created under it anyway.
pub fn resolve_safe_path(root: &Path, relative_path: &str) -> Option<PathBuf> {
    if !is_safe_path(relative_path) {
        return None;
    }
    let joined = root.join(relative_path);
    let real_root = root.canonicalize().ok()?;
    let resolved = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => joined
            .parent()?
            .canonicalize()
            .ok()?
            .join(joined.file_name()?),
    };
    if !resolved.starts_with(&real_root) {
        return None;
    }
    Some(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_valid_escapes() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("%2e%2e"), "..");
    }

    #[test]
    fn invalid_escapes_pass_through() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%2"), "%2");
    }

    #[test]
    fn multibyte_after_percent_does_not_panic() {
        // Regression: byte-indexing the &str here used to panic mid-char.
        assert_eq!(percent_decode("50%割引.txt"), "50%割引.txt");
        assert_eq!(percent_decode("%é"), "%é");
        assert_eq!(percent_decode("%a漢"), "%a漢");
        assert!(is_safe_path("docs/50%割引.txt"));
    }

    #[test]
    fn rejects_traversal_and_absolute() {
        assert!(!is_safe_path("../etc/passwd"));
        assert!(!is_safe_path("a/../../b"));
        assert!(!is_safe_path("%2e%2e/secret"));
        assert!(!is_safe_path("/etc/passwd"));
        assert!(!is_safe_path("C:/windows"));
        assert!(!is_safe_path("a\\..\\b"));
        assert!(!is_safe_path("nul\0byte"));
    }

    #[test]
    fn accepts_ordinary_repo_paths() {
        assert!(is_safe_path("src/main.rs"));
        assert!(is_safe_path("a b/c-d_e.txt"));
        assert!(is_safe_path("docs/räksmörgås.md"));
    }

    #[test]
    fn dots_inside_a_component_are_ordinary_filenames() {
        // A substring test for ".." rejected these; the files show up in a
        // diff regardless, so every operation on them failed silently.
        assert!(is_safe_path("src/foo..bar.rs"));
        assert!(is_safe_path("a..b/x.txt"));
        assert!(is_safe_path("..hidden"));
        assert!(is_safe_path("trailing.."));
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("krit-pathsafe-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        dir
    }

    #[test]
    fn a_symlink_out_of_the_repo_is_rejected_though_it_reads_as_safe() {
        let dir = scratch("symlink");
        let root = dir.join("repo");
        std::fs::write(dir.join("outside.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(dir.join("outside.txt"), root.join("link.txt")).unwrap();

        assert!(is_safe_path("link.txt"), "lexically it is unremarkable");
        assert!(
            resolve_safe_path(&root, "link.txt").is_none(),
            "following it would read and write outside the repo root"
        );

        // A symlinked directory in the middle of the path escapes just as well.
        std::os::unix::fs::symlink(&dir, root.join("up")).unwrap();
        assert!(resolve_safe_path(&root, "up/outside.txt").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_existing_and_not_yet_created_files() {
        let dir = scratch("resolve");
        let root = dir.join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "x").unwrap();

        assert!(resolve_safe_path(&root, "src/a.rs").is_some());
        // New-file writes must still resolve: the parent exists, the file doesn't.
        assert!(resolve_safe_path(&root, "src/new.rs").is_some());
        // But nothing can be created under a parent that isn't there.
        assert!(resolve_safe_path(&root, "nope/new.rs").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
