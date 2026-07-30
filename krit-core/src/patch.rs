//! Reading a `git diff` header, which is harder than it looks and must be
//! read the same way everywhere: the server slices patches by file, and every
//! client rebuilds a file list from the same string.

/// `diff --git a/<old> b/<new>` → `<new>`.
///
/// The header is ambiguous: a path may itself contain `" b/"` (`foo b/bar.rs`
/// yields `diff --git a/foo b/bar.rs b/foo b/bar.rs`), so the first separator
/// is the wrong one. Git writes the same path on both sides unless the file
/// was renamed, so the split is found by length symmetry first — the only
/// offset where the halves are identical is the real separator — and only a
/// rename, where the halves genuinely differ, falls back to the first `" b/"`.
///
/// `src/ui/hooks/useDiff.ts` and `src/ui/App.tsx` mirror this. They are the
/// copies that can still drift; the Rust clients share this one.
pub fn diff_header_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git a/")?;
    let split = rest.len().checked_sub(3)?;
    if split % 2 == 0 {
        let half = split / 2;
        // `get` rather than indexing: `half` can land mid-character.
        if rest.get(half..half + 3) == Some(" b/") && rest[..half] == rest[half + 3..] {
            return Some(rest[half + 3..].to_string());
        }
    }
    rest.split_once(" b/").map(|(_, new)| new.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_containing_the_separator_splits_by_symmetry() {
        // The naive first-" b/" split yields "bar.rs b/foo b/bar.rs" here.
        let header = "diff --git a/foo b/bar.rs b/foo b/bar.rs";
        assert_eq!(diff_header_path(header), Some("foo b/bar.rs".to_string()));
    }

    #[test]
    fn a_rename_falls_back_to_the_first_separator() {
        // Symmetry cannot resolve a rename — the halves genuinely differ.
        assert_eq!(
            diff_header_path("diff --git a/old.rs b/new.rs"),
            Some("new.rs".to_string())
        );
    }

    #[test]
    fn a_multibyte_path_never_splits_mid_character() {
        // The symmetry midpoint can land inside a UTF-8 sequence, which is
        // why the probe is `get` and not a slice index.
        assert_eq!(
            diff_header_path("diff --git a/räksmörgås.md b/räksmörgås.md"),
            Some("räksmörgås.md".to_string())
        );
    }

    #[test]
    fn a_line_that_is_not_a_header_is_not_a_path() {
        assert_eq!(diff_header_path("@@ -1 +1 @@"), None);
        assert_eq!(diff_header_path("diff --git "), None);
    }
}
