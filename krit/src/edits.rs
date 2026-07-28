//! Direct-manipulation edits: splice a character range out of (or back into)
//! a working-tree file. 1-based lines, 0-based columns, end_column exclusive
//! — the same convention as the schema v3 comment fields.

use crate::git::{content_tag, write_working_tree_file};
use crate::pathsafe::resolve_safe_path;
use std::path::Path;

/// Why an undo splice refused. The caller surfaces these to the user, so the
/// distinction between "your undo is stale" and "the file is unwritable"
/// has to survive out of this module.
#[derive(Debug, PartialEq, Eq)]
pub enum SpliceError {
    UnsafePath,
    Unreadable,
    /// Not valid UTF-8. Splicing would mean rewriting the whole file from a
    /// lossy decode, replacing every undecodable byte outside the edited
    /// range with U+FFFD.
    NotUtf8,
    /// The file no longer holds what the delete left behind.
    ContentChanged,
    /// The position doesn't exist in the file any more.
    PositionOutOfRange,
    WriteFailed,
}

impl std::fmt::Display for SpliceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::UnsafePath => "unsafe path",
            Self::Unreadable => "file is unreadable",
            Self::NotUtf8 => "file is not valid UTF-8",
            Self::ContentChanged => "file changed since the delete",
            Self::PositionOutOfRange => "position no longer exists in the file",
            Self::WriteFailed => "file is unwritable",
        };
        f.write_str(s)
    }
}

pub struct DeleteRange {
    pub file_path: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// Byte offset for a JS UTF-16 code-unit column into `line`. Columns arrive
/// from the browser, whose string indexing (and v1's String.slice) counts
/// UTF-16 units — byte-slicing with them panics or corrupts on any non-ASCII
/// text before the position. None when the column is past the end or splits
/// a surrogate pair; callers treat that as "range no longer matches".
fn utf16_col_to_byte(line: &str, col: usize) -> Option<usize> {
    let mut units = 0;
    for (byte_idx, ch) in line.char_indices() {
        if units == col {
            return Some(byte_idx);
        }
        units += ch.len_utf16();
        if units > col {
            return None;
        }
    }
    (units == col).then_some(line.len())
}

/// Both splice paths write the *whole* decoded string back, so a lossy decode
/// would replace every undecodable byte in the file — not just the edited
/// range — with U+FFFD. Refusing leaves such a file untouched.
///
/// Deliberately equivalent to `fs::read_to_string`, which rejects invalid
/// UTF-8 too. It exists to name the refusal at both splice call sites, so a
/// later switch to a lossy read reads as the behavior change it would be.
fn read_strict(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok()
}

/// A content tag `splice_insert_text` will accept. Only `splice_delete_range`
/// mints one, and only from the bytes it just wrote — so the tag authorizing
/// an undo can never be one sampled from disk afterwards, which would describe
/// a racing writer's file and send the undo into text it does not match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteTag(String);

#[cfg(test)]
impl DeleteTag {
    /// Undo has to refuse tags the delete path never minted — stale ones,
    /// bogus ones — and only a test can hand it those.
    fn for_test(tag: String) -> Self {
        Self(tag)
    }
}

/// What a delete leaves behind: the removed text, and the tag of the file the
/// delete produced.
pub struct Deletion {
    /// For the undo buffer and the user-edit event.
    pub deleted_text: String,
    pub content_tag: DeleteTag,
}

/// Removes the range and writes the file back, or None if the path is unsafe,
/// the file is unreadable or not valid UTF-8, or the range no longer fits the
/// file on disk — the range was computed against whatever the browser last
/// rendered, which may have drifted by the time the request lands.
pub fn splice_delete_range(repo_root: &Path, range: &DeleteRange) -> Option<Deletion> {
    let content = read_strict(&resolve_safe_path(repo_root, &range.file_path)?)?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let start_idx = range.start_line.checked_sub(1)? as usize;
    let end_idx = range.end_line.checked_sub(1)? as usize;
    if end_idx >= lines.len() || start_idx > end_idx {
        return None;
    }
    let first_line = lines[start_idx].clone();
    let last_line = lines[end_idx].clone();
    let sc = utf16_col_to_byte(&first_line, range.start_column as usize)?;
    let ec = utf16_col_to_byte(&last_line, range.end_column as usize)?;
    if start_idx == end_idx && sc > ec {
        return None;
    }

    let (deleted, merged) = if start_idx == end_idx {
        (
            first_line[sc..ec].to_string(),
            format!("{}{}", &first_line[..sc], &first_line[ec..]),
        )
    } else {
        let mut deleted = vec![first_line[sc..].to_string()];
        deleted.extend(lines[start_idx + 1..end_idx].iter().cloned());
        deleted.push(last_line[..ec].to_string());
        (
            deleted.join("\n"),
            format!("{}{}", &first_line[..sc], &last_line[ec..]),
        )
    };

    lines.splice(start_idx..=end_idx, [merged]);
    let written = lines.join("\n");
    if !write_working_tree_file(repo_root, &range.file_path, &written) {
        return None;
    }
    #[cfg(test)]
    run_after_write_hook();
    Some(Deletion {
        deleted_text: deleted,
        content_tag: DeleteTag(content_tag(written.as_bytes())),
    })
}

// The hook fires at the one instant a competing writer could slip between a
// delete and the tag that authorizes its undo. Real code has nothing there;
// tests install a writer to make the tag's provenance observable — a tag
// derived from the bytes this delete wrote is unaffected by it, a tag re-read
// from disk is not.
#[cfg(test)]
thread_local! {
    static AFTER_WRITE_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_after_write_hook() {
    let hook = AFTER_WRITE_HOOK.with(|h| h.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

/// Inverse of splice_delete_range: re-inserts `text` at its removal point.
/// The position is only meaningful in the exact file the delete left behind,
/// so `expected_tag` (the `git::content_tag` of that file) is required and
/// checked — without it an undo landing after someone else's edit splices the
/// text into an unrelated position. There is no OT reconciliation: a changed
/// file is a refused undo, not a rebased one.
pub fn splice_insert_text(
    repo_root: &Path,
    file_path: &str,
    start_line: u32,
    start_column: u32,
    text: &str,
    expected_tag: &DeleteTag,
) -> Result<(), SpliceError> {
    let path = resolve_safe_path(repo_root, file_path).ok_or(SpliceError::UnsafePath)?;
    let bytes = std::fs::read(path).map_err(|_| SpliceError::Unreadable)?;
    if content_tag(&bytes) != expected_tag.0 {
        return Err(SpliceError::ContentChanged);
    }
    let content = String::from_utf8(bytes).map_err(|_| SpliceError::NotUtf8)?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
    let Some(idx) = start_line.checked_sub(1).map(|n| n as usize) else {
        return Err(SpliceError::PositionOutOfRange);
    };
    if idx >= lines.len() {
        return Err(SpliceError::PositionOutOfRange);
    }
    let line = lines[idx].clone();
    let Some(col) = utf16_col_to_byte(&line, start_column as usize) else {
        return Err(SpliceError::PositionOutOfRange);
    };

    let inserted: Vec<&str> = text.split('\n').collect();
    if inserted.len() == 1 {
        lines[idx] = format!("{}{}{}", &line[..col], text, &line[col..]);
    } else {
        let mut new_lines: Vec<String> = inserted.iter().map(|s| s.to_string()).collect();
        new_lines[0] = format!("{}{}", &line[..col], new_lines[0]);
        let last = new_lines.len() - 1;
        new_lines[last] = format!("{}{}", new_lines[last], &line[col..]);
        lines.splice(idx..=idx, new_lines);
    }
    if write_working_tree_file(repo_root, file_path, &lines.join("\n")) {
        Ok(())
    } else {
        Err(SpliceError::WriteFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_cols_match_ascii_bytes() {
        assert_eq!(utf16_col_to_byte("hello", 0), Some(0));
        assert_eq!(utf16_col_to_byte("hello", 3), Some(3));
        assert_eq!(utf16_col_to_byte("hello", 5), Some(5));
        assert_eq!(utf16_col_to_byte("hello", 6), None);
        assert_eq!(utf16_col_to_byte("", 0), Some(0));
    }

    #[test]
    fn utf16_cols_diverge_from_bytes_on_multibyte() {
        // "café-menu": é is 1 UTF-16 unit but 2 UTF-8 bytes.
        let line = "café-menu";
        assert_eq!(utf16_col_to_byte(line, 4), Some(5)); // the '-' after é
        assert_eq!(&line[utf16_col_to_byte(line, 4).unwrap()..], "-menu");
        // 💚 is 2 UTF-16 units (surrogate pair), 4 UTF-8 bytes.
        let emoji = "a💚b";
        assert_eq!(utf16_col_to_byte(emoji, 1), Some(1));
        assert_eq!(utf16_col_to_byte(emoji, 3), Some(5));
        assert_eq!(utf16_col_to_byte(emoji, 2), None); // splits the pair
        assert_eq!(utf16_col_to_byte(emoji, 4), Some(6));
    }

    fn temp_repo(name: &str, contents: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("krit-edits-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), contents).unwrap();
        (dir, name.to_string())
    }

    fn tag_of(root: &Path, file: &str) -> DeleteTag {
        DeleteTag::for_test(content_tag(&std::fs::read(root.join(file)).unwrap()))
    }

    #[test]
    fn delete_range_with_non_ascii_prefix() {
        // Regression: UTF-16 columns from the browser used to be treated as
        // byte offsets, panicking or corrupting on lines like this one.
        let (root, file) = temp_repo("non-ascii.txt", "let s = \"café-menu\";\nnext");
        // Delete `menu` — UTF-16 cols 14..18 on line 1.
        let deleted = splice_delete_range(
            &root,
            &DeleteRange {
                file_path: file.clone(),
                start_line: 1,
                start_column: 14,
                end_line: 1,
                end_column: 18,
            },
        );
        assert_eq!(deleted.map(|d| d.deleted_text).as_deref(), Some("menu"));
        let after = std::fs::read_to_string(root.join(&file)).unwrap();
        assert_eq!(after, "let s = \"café-\";\nnext");
        // Undo restores byte-exactly.
        let tag = tag_of(&root, &file);
        assert!(splice_insert_text(&root, &file, 1, 14, "menu", &tag).is_ok());
        let restored = std::fs::read_to_string(root.join(&file)).unwrap();
        assert_eq!(restored, "let s = \"café-menu\";\nnext");
    }

    #[test]
    fn delete_across_multiple_lines() {
        // Delete from mid-line 1 through mid-line 3, stitching the ends.
        let (root, file) = temp_repo("multi-del.txt", "aaXbb\ncccc\ndYeee\nkeep");
        let deleted = splice_delete_range(
            &root,
            &DeleteRange {
                file_path: file.clone(),
                start_line: 1,
                start_column: 2, // after "aa"
                end_line: 3,
                end_column: 1, // before "Yeee"
            },
        );
        assert_eq!(
            deleted.map(|d| d.deleted_text).as_deref(),
            Some("Xbb\ncccc\nd")
        );
        let after = std::fs::read_to_string(root.join(&file)).unwrap();
        assert_eq!(after, "aaYeee\nkeep");
    }

    #[test]
    fn insert_multiline_text_stitches_ends() {
        let (root, file) = temp_repo("multi-ins.txt", "aabb\nkeep");
        // Insert "X\nY\nZ" between "aa" and "bb" on line 1.
        let tag = tag_of(&root, &file);
        assert!(splice_insert_text(&root, &file, 1, 2, "X\nY\nZ", &tag).is_ok());
        let after = std::fs::read_to_string(root.join(&file)).unwrap();
        assert_eq!(after, "aaX\nY\nZbb\nkeep");
    }

    #[test]
    fn delete_then_undo_round_trips_multiline() {
        let (root, file) = temp_repo("roundtrip.txt", "one\ntwo\nthree");
        let deleted = splice_delete_range(
            &root,
            &DeleteRange {
                file_path: file.clone(),
                start_line: 1,
                start_column: 3,
                end_line: 3,
                end_column: 0,
            },
        )
        .unwrap();
        assert_eq!(deleted.deleted_text, "\ntwo\n");
        assert_eq!(
            std::fs::read_to_string(root.join(&file)).unwrap(),
            "onethree"
        );
        let tag = tag_of(&root, &file);
        assert!(splice_insert_text(&root, &file, 1, 3, &deleted.deleted_text, &tag).is_ok());
        assert_eq!(
            std::fs::read_to_string(root.join(&file)).unwrap(),
            "one\ntwo\nthree"
        );
    }

    #[test]
    fn out_of_range_columns_refuse_rather_than_panic() {
        let (root, file) = temp_repo("short.txt", "ab");
        let result = splice_delete_range(
            &root,
            &DeleteRange {
                file_path: file,
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 99,
            },
        );
        assert!(result.is_none());
    }

    #[test]
    fn non_utf8_file_is_refused_not_rewritten() {
        let dir = std::env::temp_dir().join(format!("krit-edits-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = "latin1.txt";
        let original: &[u8] = b"caf\xe9 menu\nsecond \xe9 line";
        std::fs::write(dir.join(file), original).unwrap();

        assert!(
            splice_delete_range(
                &dir,
                &DeleteRange {
                    file_path: file.into(),
                    start_line: 1,
                    start_column: 0,
                    end_line: 1,
                    end_column: 3,
                },
            )
            .is_none()
        );
        assert_eq!(
            splice_insert_text(&dir, file, 1, 0, "x", &tag_of(&dir, file)),
            Err(SpliceError::NotUtf8)
        );
        // Every undecodable byte outside the edited range survives.
        assert_eq!(std::fs::read(dir.join(file)).unwrap(), original);
    }

    #[test]
    fn a_symlink_out_of_the_repo_is_not_writable() {
        // The splices write, so following a symlink out of the repo turns a
        // scoped in-repo edit into an arbitrary-filesystem write.
        let base = std::env::temp_dir().join(format!("krit-edits-symlink-{}", std::process::id()));
        let root = base.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let outside = base.join("outside.txt");
        std::fs::write(&outside, "secret\ncontent").unwrap();
        let link = root.join("link.txt");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert!(
            splice_delete_range(
                &root,
                &DeleteRange {
                    file_path: "link.txt".into(),
                    start_line: 1,
                    start_column: 0,
                    end_line: 1,
                    end_column: 6,
                },
            )
            .is_none()
        );
        assert_eq!(
            splice_insert_text(
                &root,
                "link.txt",
                1,
                0,
                "x",
                &DeleteTag::for_test("\"whatever\"".into())
            ),
            Err(SpliceError::UnsafePath)
        );
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "secret\ncontent"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The delete's tag names the bytes the delete itself wrote, not whatever
    /// is on disk once the caller gets around to looking. A tag sampled from
    /// disk after a competing write would authorize an undo into that other
    /// writer's file — the corruption the tag exists to prevent.
    #[test]
    fn the_delete_tag_describes_the_delete_own_output_not_a_racing_write() {
        let (root, file) = temp_repo("tag-provenance.txt", "one\ntwo\nthree");
        let expected_after_delete = "one\n\nthree";
        // A competing writer lands in the only window that matters: after the
        // delete's write, before its tag is settled.
        let racer_root = root.clone();
        let racer_file = file.clone();
        AFTER_WRITE_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                std::fs::write(racer_root.join(&racer_file), "one\nsomeone else\nthree").unwrap();
            }));
        });
        let deleted = splice_delete_range(
            &root,
            &DeleteRange {
                file_path: file.clone(),
                start_line: 2,
                start_column: 0,
                end_line: 2,
                end_column: 3,
            },
        )
        .unwrap();
        assert_eq!(
            deleted.content_tag,
            DeleteTag::for_test(content_tag(expected_after_delete.as_bytes()))
        );

        // So the undo it authorizes refuses against the racer's file rather
        // than splicing "two" back into a position that no longer means what
        // it did.
        assert_eq!(
            splice_insert_text(
                &root,
                &file,
                2,
                0,
                &deleted.deleted_text,
                &deleted.content_tag
            ),
            Err(SpliceError::ContentChanged)
        );
        assert_eq!(
            std::fs::read_to_string(root.join(&file)).unwrap(),
            "one\nsomeone else\nthree"
        );
    }

    /// Absent a racing write, the tag is exactly the file the delete left, so
    /// the undo it authorizes goes through.
    #[test]
    fn the_delete_tag_authorizes_the_undo_of_that_delete() {
        let (root, file) = temp_repo("tag-roundtrip.txt", "one\ntwo\nthree");
        let deleted = splice_delete_range(
            &root,
            &DeleteRange {
                file_path: file.clone(),
                start_line: 2,
                start_column: 0,
                end_line: 2,
                end_column: 3,
            },
        )
        .unwrap();
        assert_eq!(deleted.content_tag, tag_of(&root, &file));
        assert!(
            splice_insert_text(
                &root,
                &file,
                2,
                0,
                &deleted.deleted_text,
                &deleted.content_tag
            )
            .is_ok()
        );
        assert_eq!(
            std::fs::read_to_string(root.join(&file)).unwrap(),
            "one\ntwo\nthree"
        );
    }

    #[test]
    fn undo_refuses_when_the_file_changed_since_the_delete() {
        let (root, file) = temp_repo("stale-undo.txt", "one\ntwo\nthree");
        let deleted = splice_delete_range(
            &root,
            &DeleteRange {
                file_path: file.clone(),
                start_line: 2,
                start_column: 0,
                end_line: 2,
                end_column: 3,
            },
        )
        .unwrap();
        let tag = tag_of(&root, &file);

        // Someone else rewrites the file; the recorded position now means
        // something different.
        std::fs::write(root.join(&file), "completely\ndifferent\ncontent").unwrap();
        assert_eq!(
            splice_insert_text(&root, &file, 2, 0, &deleted.deleted_text, &tag),
            Err(SpliceError::ContentChanged)
        );
        assert_eq!(
            std::fs::read_to_string(root.join(&file)).unwrap(),
            "completely\ndifferent\ncontent"
        );
    }
}
