//! The flat list of rows the diff pane scrolls over.
//!
//! Files, hunks and lines are a tree; a scrollable view is a list. Flattening
//! once — and keeping every index into it — is what makes "scroll one line",
//! "jump to the next hunk" and "which file am I in" the same kind of cheap
//! question. The web UI arrived at the same shape for the same reason
//! (`computeRowWindow`, `useVirtualRows`), though the costs differ: ratatui
//! diffs its own back buffer, so drawing is nearly free and the expense is
//! *building* rows.

use crate::comments::CommentRows;
use crate::patch::{FileDiff, LineKind};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
    /// A file's header line: sigil, path, +N −M.
    File {
        file: usize,
    },
    /// A note under the header — a rename's old path, or "binary".
    Meta {
        file: usize,
        note: Note,
    },
    Hunk {
        file: usize,
        hunk: usize,
    },
    Code {
        file: usize,
        hunk: usize,
        line: usize,
    },
    /// One line of a comment block. `line` indexes the laid-out block rather
    /// than the comment's body: a body wraps, and a model row that rendered as
    /// three screen rows would break every scroll calculation there is.
    Comment {
        file: usize,
        comment: usize,
        line: usize,
    },
    /// One blank line between files, so the headers don't collide.
    Gap,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    RenamedFrom,
    Binary,
    Collapsed,
}

impl Row {
    /// Which file this row belongs to, if any. Drives the file-tree
    /// highlight, which follows the cursor rather than being moved by hand.
    pub fn file(self) -> Option<usize> {
        match self {
            Row::File { file }
            | Row::Meta { file, .. }
            | Row::Hunk { file, .. }
            | Row::Code { file, .. }
            | Row::Comment { file, .. } => Some(file),
            Row::Gap => None,
        }
    }

    /// The comment this row is part of, if it is part of one. What the reply
    /// and resolve keys act on.
    pub fn comment(self) -> Option<usize> {
        match self {
            Row::Comment { comment, .. } => Some(comment),
            _ => None,
        }
    }
}

/// Flatten files into rows. `collapsed` holds paths whose bodies are hidden —
/// the header still renders, so a collapsed file is navigable rather than
/// gone.
pub fn build_rows(
    files: &[FileDiff],
    collapsed: &HashSet<String>,
    comments: &CommentRows,
) -> Vec<Row> {
    let mut rows = Vec::new();
    let push_comments = |rows: &mut Vec<Row>, file: usize, which: &[usize]| {
        for &comment in which {
            for line in 0..comments.height(comment) {
                rows.push(Row::Comment {
                    file,
                    comment,
                    line,
                });
            }
        }
    };
    for (fi, file) in files.iter().enumerate() {
        if fi > 0 {
            rows.push(Row::Gap);
        }
        rows.push(Row::File { file: fi });
        if file.old_path.is_some() {
            rows.push(Row::Meta {
                file: fi,
                note: Note::RenamedFrom,
            });
        }
        if collapsed.contains(&file.path) {
            rows.push(Row::Meta {
                file: fi,
                note: Note::Collapsed,
            });
            continue;
        }
        // Comments whose line is nowhere in the diff. Under the header rather
        // than nowhere: see `comments::Anchor::File`.
        push_comments(&mut rows, fi, comments.under_file(fi));
        if file.binary {
            rows.push(Row::Meta {
                file: fi,
                note: Note::Binary,
            });
            continue;
        }
        for (hi, hunk) in file.hunks.iter().enumerate() {
            rows.push(Row::Hunk { file: fi, hunk: hi });
            for li in 0..hunk.lines.len() {
                rows.push(Row::Code {
                    file: fi,
                    hunk: hi,
                    line: li,
                });
                push_comments(&mut rows, fi, comments.after_line(fi, hi, li));
            }
        }
    }
    rows
}

/// How many comments a file holds, laid out or not — what the collapsed note
/// reports, so folding a file does not silently take its conversation with it.
pub fn comments_in(files: &[FileDiff], file: usize, comments: &CommentRows) -> usize {
    let mut n = comments.under_file(file).len();
    if let Some(f) = files.get(file) {
        for (hi, hunk) in f.hunks.iter().enumerate() {
            for li in 0..hunk.lines.len() {
                n += comments.after_line(file, hi, li).len();
            }
        }
    }
    n
}

/// Row indices of every file header, in order.
pub fn file_rows(rows: &[Row]) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(_, r)| matches!(r, Row::File { .. }))
        .map(|(i, _)| i)
        .collect()
}

/// Row index of each comment's *first* line, in order — so `}` steps from one
/// comment to the next rather than through a long body a line at a time.
pub fn comment_rows(rows: &[Row]) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(_, r)| matches!(r, Row::Comment { line: 0, .. }))
        .map(|(i, _)| i)
        .collect()
}

/// Row indices of every hunk header, in order.
pub fn hunk_rows(rows: &[Row]) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(_, r)| matches!(r, Row::Hunk { .. }))
        .map(|(i, _)| i)
        .collect()
}

/// The next stop in `stops` strictly after `from` (or strictly before, going
/// back). `None` when there is none, and what to do about that is the caller's
/// call: its one caller, `App::jump`, stays put going forward — silently
/// wrapping to the top of a 400-file review reads as a scroll glitch — and
/// going back falls through to the first stop, so `[` from inside the first
/// file lands on that file's header rather than refusing to move.
pub fn next_stop(stops: &[usize], from: usize, forward: bool) -> Option<usize> {
    if forward {
        stops.iter().copied().find(|&s| s > from)
    } else {
        stops.iter().copied().rfind(|&s| s < from)
    }
}

/// Scroll offset that keeps `cursor` visible in a `height`-row viewport,
/// moving as little as possible: the view follows the cursor, it doesn't
/// recenter on it.
pub fn scroll_to_show(offset: usize, height: usize, cursor: usize, total: usize) -> usize {
    if height == 0 || total == 0 {
        return 0;
    }
    let max_offset = total.saturating_sub(height);
    let offset = offset.min(max_offset);
    if cursor < offset {
        cursor
    } else if cursor >= offset + height {
        (cursor + 1 - height).min(max_offset)
    } else {
        offset
    }
}

/// The half-open range of rows to render. Separate from `scroll_to_show` so
/// the window can be computed without a cursor at all — the mouse-wheel path
/// scrolls the view without moving the selection.
pub fn row_window(total: usize, offset: usize, height: usize) -> std::ops::Range<usize> {
    let start = offset.min(total);
    let end = start.saturating_add(height).min(total);
    start..end
}

/// Widest line number that will appear in the gutter, as a column count.
/// Computed once per diff rather than per row: a 4-digit file and a 5-digit
/// file in one review must share a gutter, or every file boundary shifts the
/// code left and right.
pub fn gutter_width(files: &[FileDiff]) -> usize {
    let widest = files
        .iter()
        .flat_map(|f| &f.hunks)
        .flat_map(|h| &h.lines)
        // `Option::max`, not a numeric one: `None` sorts below `Some` in
        // Option's derived Ord, so a one-sided line still contributes the
        // number it does have.
        .filter_map(|l| l.old_line.max(l.new_line))
        .max()
        .unwrap_or(1);
    widest.to_string().len().max(2)
}

/// The columns between the gutters and the code: one separator space, the
/// change marker, and one more space.
///
/// Here rather than in `ui` because two modules have to agree on it. `ui`
/// draws it; `App` subtracts it to turn a mouse column into a column of the
/// line, and a disagreement would put every character-level selection off by
/// a fixed amount — which reads as a plausible anchor, not as an error.
pub const MARKER_COLS: usize = 4;

/// `+N −M` for a file's header.
pub fn stat_label(file: &FileDiff) -> String {
    format!("+{} −{}", file.additions, file.deletions)
}

/// The marker column for a diff line.
pub fn line_marker(kind: LineKind) -> char {
    match kind {
        LineKind::Addition => '+',
        LineKind::Deletion => '-',
        LineKind::Context => ' ',
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::parse_patch;

    const TWO_FILES: &str = "diff --git a/a.rs b/a.rs\n\
                             @@ -1,2 +1,2 @@\n\
                             -x\n\
                             +y\n\
                             \x20z\n\
                             diff --git a/b.rs b/b.rs\n\
                             @@ -5 +5 @@\n\
                             -p\n\
                             +q";

    fn rows_of(patch: &str) -> (Vec<crate::patch::FileDiff>, Vec<Row>) {
        let files = parse_patch(patch, &[]);
        let rows = build_rows(&files, &HashSet::new(), &CommentRows::default());
        (files, rows)
    }

    fn comment(path: &str, line: u32) -> krit_core::types::ReviewComment {
        krit_core::types::ReviewComment {
            id: format!("{path}:{line}"),
            file_path: path.into(),
            side: "additions".into(),
            line_number: line,
            end_line: None,
            line_content: String::new(),
            body: "note".into(),
            status: "open".into(),
            created_at: 0,
            replies: Vec::new(),
            outdated: None,
            suggestion: None,
            start_column: None,
            end_column: None,
            selected_text: None,
        }
    }

    #[test]
    fn flattens_files_hunks_and_lines_with_a_gap_between_files() {
        let (_, rows) = rows_of(TWO_FILES);
        assert_eq!(
            rows,
            vec![
                Row::File { file: 0 },
                Row::Hunk { file: 0, hunk: 0 },
                Row::Code {
                    file: 0,
                    hunk: 0,
                    line: 0
                },
                Row::Code {
                    file: 0,
                    hunk: 0,
                    line: 1
                },
                Row::Code {
                    file: 0,
                    hunk: 0,
                    line: 2
                },
                Row::Gap,
                Row::File { file: 1 },
                Row::Hunk { file: 1, hunk: 0 },
                Row::Code {
                    file: 1,
                    hunk: 0,
                    line: 0
                },
                Row::Code {
                    file: 1,
                    hunk: 0,
                    line: 1
                },
            ]
        );
        // No leading gap: a blank first row wastes the top of the viewport.
        assert_eq!(rows[0], Row::File { file: 0 });
    }

    #[test]
    fn a_comment_renders_under_the_line_it_is_anchored_to() {
        // TWO_FILES: a.rs new-side line 1 is the "+y" row (hunk 0, line 1).
        let files = parse_patch(TWO_FILES, &[]);
        let comments = crate::comments::layout(&[comment("a.rs", 1)], &files, 60);
        let rows = build_rows(&files, &HashSet::new(), &comments);
        let at = rows
            .iter()
            .position(|r| matches!(r, Row::Comment { .. }))
            .expect("the comment is in the rows");
        assert_eq!(
            rows[at - 1],
            Row::Code {
                file: 0,
                hunk: 0,
                line: 1
            }
        );
        // One model row per rendered line, so scrolling stays arithmetic.
        let block: Vec<&Row> = rows.iter().filter(|r| r.comment().is_some()).collect();
        assert_eq!(block.len(), comments.height(0));
        assert_eq!(rows[at].file(), Some(0));
    }

    #[test]
    fn a_comment_outside_every_hunk_renders_under_the_file_header() {
        let files = parse_patch(TWO_FILES, &[]);
        let comments = crate::comments::layout(&[comment("a.rs", 900)], &files, 60);
        let rows = build_rows(&files, &HashSet::new(), &comments);
        let at = rows
            .iter()
            .position(|r| matches!(r, Row::Comment { .. }))
            .expect("still rendered");
        assert_eq!(rows[at - 1], Row::File { file: 0 });
    }

    #[test]
    fn collapsing_a_file_hides_its_comments_with_its_body() {
        // Consistent with the web UI, where `collapsed` suppresses annotations
        // along with the rows — and with the reviewer's intent, which was to
        // put the whole file away. The note says how many went with it.
        let files = parse_patch(TWO_FILES, &[]);
        let comments = crate::comments::layout(&[comment("a.rs", 1)], &files, 60);
        let collapsed: HashSet<String> = ["a.rs".to_string()].into_iter().collect();
        let rows = build_rows(&files, &collapsed, &comments);
        assert!(!rows.iter().any(|r| r.comment().is_some()));
        assert_eq!(comments_in(&files, 0, &comments), 1);
        assert_eq!(comments_in(&files, 1, &comments), 0);
    }

    #[test]
    fn a_collapsed_file_keeps_its_header_so_it_stays_navigable() {
        let files = parse_patch(TWO_FILES, &[]);
        let collapsed: HashSet<String> = ["a.rs".to_string()].into_iter().collect();
        let rows = build_rows(&files, &collapsed, &CommentRows::default());
        assert_eq!(rows[0], Row::File { file: 0 });
        assert_eq!(
            rows[1],
            Row::Meta {
                file: 0,
                note: Note::Collapsed
            }
        );
        assert!(!rows.iter().any(|r| matches!(r, Row::Code { file: 0, .. })));
        // The other file is untouched.
        assert!(rows.iter().any(|r| matches!(r, Row::Code { file: 1, .. })));
        assert_eq!(file_rows(&rows).len(), 2);
    }

    #[test]
    fn a_binary_file_renders_a_note_instead_of_an_empty_body() {
        let patch = "diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ";
        let (_, rows) = rows_of(patch);
        assert_eq!(
            rows,
            vec![
                Row::File { file: 0 },
                Row::Meta {
                    file: 0,
                    note: Note::Binary
                }
            ]
        );
    }

    #[test]
    fn every_row_but_the_gap_knows_its_file() {
        let (_, rows) = rows_of(TWO_FILES);
        assert_eq!(rows[2].file(), Some(0));
        assert_eq!(rows[5].file(), None, "the gap belongs to neither");
        assert_eq!(rows[8].file(), Some(1));
    }

    #[test]
    fn stops_move_one_at_a_time_and_stop_at_the_ends() {
        let (_, rows) = rows_of(TWO_FILES);
        let files = file_rows(&rows);
        assert_eq!(files, vec![0, 6]);
        assert_eq!(next_stop(&files, 0, true), Some(6));
        assert_eq!(
            next_stop(&files, 6, true),
            None,
            "no wrap past the last file"
        );
        assert_eq!(next_stop(&files, 6, false), Some(0));
        assert_eq!(next_stop(&files, 0, false), None);
        // From a row in the middle of file 0, back goes to file 0's header.
        assert_eq!(next_stop(&files, 3, false), Some(0));
    }

    #[test]
    fn hunk_stops_are_separate_from_file_stops() {
        let patch = "diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-x\n+y\n@@ -9 +9 @@\n-p\n+q";
        let (_, rows) = rows_of(patch);
        assert_eq!(hunk_rows(&rows), vec![1, 4]);
        assert_eq!(next_stop(&hunk_rows(&rows), 1, true), Some(4));
    }

    #[test]
    fn the_view_follows_the_cursor_without_recentering() {
        // Already visible: nothing moves. A view that recenters on every step
        // makes reading a diff feel like the text is sliding under you.
        assert_eq!(scroll_to_show(0, 10, 5, 100), 0);
        // Off the bottom by one: scroll by exactly one.
        assert_eq!(scroll_to_show(0, 10, 10, 100), 1);
        // Off the top: the cursor becomes the first visible row.
        assert_eq!(scroll_to_show(20, 10, 4, 100), 4);
        // Never past the end, so the last screen isn't half blank.
        assert_eq!(scroll_to_show(0, 10, 99, 100), 90);
        assert_eq!(scroll_to_show(95, 10, 99, 100), 90);
    }

    #[test]
    fn a_viewport_taller_than_the_diff_starts_at_the_top() {
        assert_eq!(scroll_to_show(0, 50, 3, 10), 0);
        assert_eq!(scroll_to_show(5, 50, 3, 10), 0);
        assert_eq!(row_window(10, 0, 50), 0..10);
        assert_eq!(scroll_to_show(0, 0, 0, 10), 0, "zero height never panics");
        assert_eq!(row_window(0, 0, 10), 0..0);
        assert_eq!(row_window(10, 99, 5), 10..10);
    }

    #[test]
    fn the_gutter_is_sized_for_the_widest_number_in_the_whole_review() {
        // Otherwise the code column shifts as you scroll from a short file
        // into a long one.
        let patch = "diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-x\n+y\n\
                     diff --git a/b.rs b/b.rs\n@@ -12000 +12000 @@\n-p\n+q";
        let files = parse_patch(patch, &[]);
        assert_eq!(gutter_width(&files), 5);
        // A tiny diff still gets a floor, so single-digit files don't jitter.
        assert_eq!(
            gutter_width(&parse_patch("diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y", &[])),
            2
        );
        assert_eq!(gutter_width(&[]), 2);
    }

    #[test]
    fn stats_and_markers_do_not_depend_on_color() {
        let files = parse_patch(TWO_FILES, &[]);
        assert_eq!(stat_label(&files[0]), "+1 −1");
        assert_eq!(line_marker(LineKind::Addition), '+');
        assert_eq!(line_marker(LineKind::Deletion), '-');
        assert_eq!(line_marker(LineKind::Context), ' ');
    }
}
