//! Comment re-anchoring after a live file change — GitHub semantics: exact
//! match near the old position first, then normalized fuzzy match, else the
//! comment is flagged `outdated` and left at its last-known lines. The
//! matching (find_block) is pure; reanchor_file_comments applies the results
//! to the store (which persists on every update) with the server's store
//! lock held.

use crate::pathsafe::is_safe_path;
use crate::store::{CommentStore, UpdateFields};
use crate::types::ReviewComment;
use std::path::Path;

/// Lines searched on either side of the last-known position before falling
/// back to a whole-file scan — a nearby match is far more likely to be the
/// right one than an identical line somewhere else.
const SEARCH_WINDOW: i64 = 25;

fn normalize_line(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 1-based start line of `block` inside `file_lines`, window around `hint`
/// first, then the rest. `normalize` toggles exact vs fuzzy comparison.
fn find_block(file_lines: &[&str], block: &[&str], hint: u32, normalize: bool) -> Option<u32> {
    if block.is_empty() || block.len() > file_lines.len() {
        return None;
    }
    let eq = |a: &str, b: &str| {
        if normalize {
            normalize_line(a) == normalize_line(b)
        } else {
            a == b
        }
    };
    let matches_at = |start: usize| (0..block.len()).all(|i| eq(file_lines[start + i], block[i]));

    let max_start = (file_lines.len() - block.len()) as i64;
    let hint_idx = ((hint as i64) - 1).clamp(0, max_start);
    let lo = (hint_idx - SEARCH_WINDOW).max(0);
    let hi = (hint_idx + SEARCH_WINDOW).min(max_start);
    for start in lo..=hi {
        if matches_at(start as usize) {
            return Some(start as u32 + 1);
        }
    }
    for start in 0..=max_start {
        if start >= lo && start <= hi {
            continue;
        }
        if matches_at(start as usize) {
            return Some(start as u32 + 1);
        }
    }
    None
}

/// Remaps every non-resolved, additions-side comment on `file_path` to its
/// new position after a working-tree change. Deletion-side comments are left
/// alone (their content no longer exists by definition); drafts ARE
/// re-anchored but it's the caller's job not to broadcast them. Returns only
/// the comments that actually changed.
pub fn reanchor_file_comments(
    file_path: &str,
    store: &mut CommentStore,
    repo_root: &Path,
) -> Vec<ReviewComment> {
    if !is_safe_path(file_path) {
        return Vec::new();
    }
    // Deleted or unreadable — no lines to match, everything on the file
    // falls through to outdated. Lossy decode (matching read_side and the
    // edit paths): a stray invalid-UTF-8 byte must not blank the whole file
    // and spuriously outdate every comment on it.
    let content = std::fs::read(repo_root.join(file_path))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let file_lines: Vec<&str> = if content.is_empty() {
        Vec::new()
    } else {
        content.split('\n').collect()
    };

    let targets: Vec<ReviewComment> = store
        .for_file(file_path)
        .into_iter()
        .filter(|c| c.status != "resolved" && c.side == "additions")
        .collect();
    let mut changed = Vec::new();

    for comment in targets {
        let block: Vec<&str> = comment.line_content.split('\n').collect();
        let start = find_block(&file_lines, &block, comment.line_number, false)
            .or_else(|| find_block(&file_lines, &block, comment.line_number, true));

        match start {
            None => {
                if comment.outdated == Some(true) {
                    continue;
                }
                if let Some(updated) = store.update(
                    &comment.id,
                    UpdateFields {
                        outdated: Some(true),
                        ..Default::default()
                    },
                ) {
                    changed.push(updated);
                }
            }
            Some(start) => {
                let end_line = comment.end_line_or_start();
                let new_end = start + (end_line - comment.line_number);
                if start == comment.line_number
                    && new_end == end_line
                    && comment.outdated != Some(true)
                {
                    continue;
                }
                if let Some(updated) = store.update(
                    &comment.id,
                    UpdateFields {
                        line_number: Some(start),
                        end_line: Some(new_end),
                        outdated: Some(false),
                        ..Default::default()
                    },
                ) {
                    changed.push(updated);
                }
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::CommentStore;

    const FILE: &[&str] = &[
        "fn main() {",
        "    let a = 1;",
        "    let b = 2;",
        "    let a = 1;",
        "}",
    ];

    #[test]
    fn exact_match_prefers_window_around_hint() {
        // "let a = 1;" appears at lines 2 and 4; the hint decides which wins.
        assert_eq!(find_block(FILE, &["    let a = 1;"], 2, false), Some(2));
        assert_eq!(find_block(FILE, &["    let a = 1;"], 4, false), Some(2)); // window scan is low-to-high
        assert_eq!(find_block(FILE, &["    let b = 2;"], 1, false), Some(3));
    }

    #[test]
    fn fuzzy_match_normalizes_whitespace() {
        assert_eq!(find_block(FILE, &["let  b   =  2;"], 3, false), None);
        assert_eq!(find_block(FILE, &["let  b   =  2;"], 3, true), Some(3));
    }

    #[test]
    fn multi_line_blocks_and_misses() {
        assert_eq!(
            find_block(FILE, &["    let a = 1;", "    let b = 2;"], 1, false),
            Some(2)
        );
        assert_eq!(find_block(FILE, &["gone"], 1, true), None);
        assert_eq!(find_block(FILE, &[], 1, false), None);
        assert_eq!(find_block(&[], &["x"], 1, false), None);
    }

    // ---- reanchor_file_comments (the store-mutating wrapper) ----

    fn comment(id: &str, line: u32, line_content: &str, side: &str, status: &str) -> ReviewComment {
        ReviewComment {
            id: id.into(),
            file_path: "f.rs".into(),
            side: side.into(),
            line_number: line,
            end_line: Some(line),
            line_content: line_content.into(),
            body: "b".into(),
            status: status.into(),
            created_at: 0,
            replies: Vec::new(),
            outdated: None,
            suggestion: None,
            start_column: None,
            end_column: None,
            selected_text: None,
        }
    }

    fn temp_root_with(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("krit-reanchor-{}-{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("f.rs"), bytes).unwrap();
        dir
    }

    #[test]
    fn remaps_moved_comment_and_reports_it() {
        // Comment anchored to "let b = 2;" at line 2; file now has it at line 4.
        let root = temp_root_with("moved", b"a\nx\ny\nlet b = 2;\nz");
        let mut store = CommentStore::new(None);
        store.add(comment("c", 2, "let b = 2;", "additions", "open"));

        let changed = reanchor_file_comments("f.rs", &mut store, &root);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].line_number, 4);
        assert_eq!(changed[0].end_line, Some(4));
        assert_eq!(changed[0].outdated, Some(false));
    }

    #[test]
    fn flags_vanished_comment_outdated_once() {
        let root = temp_root_with("gone", b"totally\ndifferent\nfile");
        let mut store = CommentStore::new(None);
        store.add(comment("c", 1, "let b = 2;", "additions", "open"));

        let changed = reanchor_file_comments("f.rs", &mut store, &root);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].outdated, Some(true));

        // Already-outdated on a second pass is a no-op (not re-reported).
        let again = reanchor_file_comments("f.rs", &mut store, &root);
        assert!(again.is_empty());
    }

    #[test]
    fn leaves_resolved_and_deletion_side_comments_alone() {
        let root = temp_root_with("skip", b"nothing matches here");
        let mut store = CommentStore::new(None);
        store.add(comment(
            "resolved",
            1,
            "let b = 2;",
            "additions",
            "resolved",
        ));
        store.add(comment("deletion", 1, "let b = 2;", "deletions", "open"));

        let changed = reanchor_file_comments("f.rs", &mut store, &root);
        assert!(changed.is_empty());
        // Neither was flagged outdated.
        assert_eq!(store.get("resolved").unwrap().outdated, None);
        assert_eq!(store.get("deletion").unwrap().outdated, None);
    }

    #[test]
    fn invalid_utf8_does_not_blanket_outdate() {
        // Regression: a strict read used to blank the whole file on a stray
        // non-UTF-8 byte, spuriously outdating every comment. Lossy decode
        // keeps the intact anchor line matchable.
        let mut bytes = b"header\nlet b = 2;\n".to_vec();
        bytes.push(0xff); // invalid UTF-8, on its own trailing line
        let root = temp_root_with("lossy", &bytes);
        let mut store = CommentStore::new(None);
        store.add(comment("c", 2, "let b = 2;", "additions", "open"));

        let changed = reanchor_file_comments("f.rs", &mut store, &root);
        // The anchor is still at line 2 → nothing moved, nothing outdated.
        assert!(changed.is_empty());
        assert_ne!(store.get("c").unwrap().outdated, Some(true));
    }
}
