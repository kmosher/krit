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
use std::collections::{HashMap, HashSet};

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
    /// One row of a hunk drawn side by side. Carries both sides rather than
    /// one, which is what makes it a different row type from `Code` — every
    /// scroll and hit-test still counts it as exactly one row.
    Split {
        file: usize,
        hunk: usize,
        pair: Pair,
    },
    /// An unchanged line the reviewer opened out of the space between two
    /// hunks. `line` is its **new-file** number, which is the only number the
    /// gap knows for certain; the old-file one comes from the gap's `delta`.
    Context {
        file: usize,
        gap: usize,
        line: u32,
    },
    /// The "⋯ N lines" row standing in for whatever is still folded away.
    /// One per gap, and it survives until the gap is fully open — expanding
    /// from both edges leaves it in the middle, which is what makes stepping
    /// in from either side legible.
    Expand {
        file: usize,
        gap: usize,
    },
    /// One blank line between files, so the headers don't collide.
    Gap,
}

/// A run of unchanged lines between two hunks, in new-file numbering.
///
/// Named separately from the hunks because a gap is what the patch *doesn't*
/// carry: its text comes from `fileContents`, not from the diff, and the whole
/// point of expansion is to read lines git had no reason to send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GapRange {
    /// First and last new-file line in the gap, inclusive.
    pub new_start: u32,
    pub new_end: u32,
    /// `new_line - old_line` for every line here. Constant across a gap: no
    /// line was added or removed inside it, which is what makes it a gap.
    pub delta: i64,
}

impl GapRange {
    pub fn len(&self) -> u32 {
        self.new_end.saturating_sub(self.new_start) + 1
    }

    pub fn old_line(&self, new_line: u32) -> Option<u32> {
        u32::try_from(new_line as i64 - self.delta)
            .ok()
            .filter(|n| *n > 0)
    }
}

/// Every gap in a file, including the ones before the first hunk and after the
/// last. `total_lines` is the new side's length; without it the trailing gap
/// cannot be sized and the end of the file is unreachable.
///
/// **`total_lines == 0` means the length is unknown**, and is a supported
/// argument: only the runs *between* hunks come back, with no trailing one.
/// `take_file_text` passes it for a file whose text the server refused to send,
/// so the row can still say why it will not open. It is also what a file with
/// no new side at all reports — a deletion — where the answer is likewise that
/// there is nothing after the last hunk.
///
/// Returned in file order and indexed by position, because that index is what
/// the expansion state is keyed on — a gap identified by its line numbers would
/// lose the reviewer's expansions the moment an edit above it shifted them.
pub fn gaps_of(file: &FileDiff, total_lines: u32) -> Vec<GapRange> {
    let mut gaps = Vec::new();
    let mut cursor = 1u32; // first new-file line not yet covered by a hunk
    let mut delta = 0i64;
    for hunk in &file.hunks {
        if hunk.new_start > cursor {
            gaps.push(GapRange {
                new_start: cursor,
                new_end: hunk.new_start - 1,
                // The lines just before a hunk share that hunk's offset.
                delta: hunk.new_start as i64 - hunk.old_start as i64,
            });
        }
        cursor = hunk.new_start + hunk.new_len;
        delta = (hunk.new_start as i64 + hunk.new_len as i64)
            - (hunk.old_start as i64 + hunk.old_len as i64);
    }
    // `cursor >= 1` as well as the length check: a deleted or emptied file's
    // only hunk is `@@ -1,N +0,0 @@`, which leaves `cursor` at 0, and `0 >= 0`
    // would claim a trailing gap running from line 0 to line 0 — one line, on a
    // side that has none. That phantom is also the only way to reach
    // `Row::Context { line: 0 }`, whose `line - 1` underflows.
    if cursor >= 1 && total_lines >= cursor {
        gaps.push(GapRange {
            new_start: cursor,
            new_end: total_lines,
            delta,
        });
    }
    gaps
}

/// Which of a diff's two sides a line, a column or an anchor belongs to.
///
/// One name for an axis that was spelled four ways: a bare `bool`, `left`/
/// `right` on a `Pair`, `additions: bool` on the anchor helpers, and the wire's
/// own strings. None of those said at the call site which value meant which
/// side, and an inverted one anchors a comment on the wrong line with nothing
/// on screen to say so — the failure this whole area keeps producing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// The deletions side: the file as it was, drawn in the left column.
    Old,
    /// The additions side: the file as it is, drawn in the right column and the
    /// side a comment means unless something says otherwise.
    New,
}

impl Side {
    /// What the wire calls it. The server validates against these two strings
    /// and `reanchor.rs` matches on `"additions"`, so this is the only spelling
    /// that may reach a `ReviewComment`.
    pub fn wire_name(self) -> &'static str {
        match self {
            Side::Old => "deletions",
            Side::New => "additions",
        }
    }

    /// The side a line belongs to, given whether it has a new-file number.
    /// Context lines have both, and report as `New` — the side a comment on an
    /// unchanged line means.
    pub fn of_line(has_new_line: bool) -> Side {
        if has_new_line { Side::New } else { Side::Old }
    }
}

/// One row of a side-by-side hunk: the old line on the left, the new one on the
/// right, either of which may be absent.
///
/// Both indices are into the hunk's own `lines`, so a pair claims nothing the
/// unified model does not already say — it only decides what sits beside what.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pair {
    pub left: Option<usize>,
    pub right: Option<usize>,
}

impl Pair {
    /// The line this pair draws on one side. `left`/`right` are what the
    /// *renderer* needs — they are columns — and this is what everything else
    /// needs, which is the side.
    pub fn on(self, side: Side) -> Option<usize> {
        match side {
            Side::Old => self.left,
            Side::New => self.right,
        }
    }
}

/// Lay a hunk out side by side.
///
/// A unified hunk is runs: some context, then deletions, then additions, then
/// context again. Split view pairs each run of deletions with the run of
/// additions that replaced it, index by index, and pads the shorter one with
/// blanks — so a line and its replacement sit on the same row and can be read
/// against each other, which is the entire reason to want this view.
///
/// Pairing is per *run*, not per hunk: a hunk with two separate edits in it
/// would otherwise pair the first deletion with an addition from the second
/// edit, several lines away, and the two columns would describe changes that
/// have nothing to do with each other. Context is what ends a run, because
/// context is the only thing both sides agree on.
pub fn pair_hunk(hunk: &crate::patch::Hunk) -> Vec<Pair> {
    let mut pairs = Vec::new();
    let mut dels: Vec<usize> = Vec::new();
    let mut adds: Vec<usize> = Vec::new();
    let flush = |pairs: &mut Vec<Pair>, dels: &mut Vec<usize>, adds: &mut Vec<usize>| {
        for i in 0..dels.len().max(adds.len()) {
            pairs.push(Pair {
                left: dels.get(i).copied(),
                right: adds.get(i).copied(),
            });
        }
        dels.clear();
        adds.clear();
    };
    for (i, line) in hunk.lines.iter().enumerate() {
        match line.kind {
            LineKind::Deletion => dels.push(i),
            LineKind::Addition => adds.push(i),
            LineKind::Context => {
                flush(&mut pairs, &mut dels, &mut adds);
                pairs.push(Pair {
                    left: Some(i),
                    right: Some(i),
                });
            }
        }
    }
    flush(&mut pairs, &mut dels, &mut adds);
    pairs
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    RenamedFrom,
    Binary,
    Collapsed,
    /// The executable bit changed. Its own note because such a file has no
    /// hunks at all — without it the header reads `+0 −0` and the reviewer has
    /// no way to tell why the file is in the review.
    Mode,
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
            | Row::Comment { file, .. }
            | Row::Split { file, .. }
            | Row::Context { file, .. }
            | Row::Expand { file, .. } => Some(file),
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

/// Flatten files into rows.
///
/// - `collapsed` holds paths whose bodies are hidden — the header still
///   renders, so a collapsed file is navigable rather than gone.
/// - `gaps` is the unchanged runs between hunks, by path, and `expanded` how
///   much of each one the reviewer has opened. A path missing from `gaps` draws
///   no `⋯` row, which is what a file whose text never arrived looks like.
/// - `split` selects the row model, not a drawing style: it swaps every
///   `Row::Code` for a `Row::Split` carrying both sides, so the same file is a
///   different number of rows either way.
pub fn build_rows(
    files: &[FileDiff],
    collapsed: &HashSet<String>,
    comments: &CommentRows,
    gaps: &HashMap<String, Vec<GapRange>>,
    expanded: &HashMap<(String, usize), Opened>,
    split: bool,
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
        if file.mode.is_some() {
            rows.push(Row::Meta {
                file: fi,
                note: Note::Mode,
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
        // A gap sits before the hunk that follows it, and the trailing one
        // after the last — the same order they occupy in the file, so the row
        // list reads top to bottom whatever is open.
        let file_gaps = gaps.get(&file.path).map(Vec::as_slice).unwrap_or(&[]);
        let mut gi = 0usize;
        let mut next_line = 1u32;
        for (hi, hunk) in file.hunks.iter().enumerate() {
            if file_gaps
                .get(gi)
                .is_some_and(|g| g.new_start == next_line && g.new_end < hunk.new_start)
            {
                push_gap(
                    &mut rows,
                    fi,
                    gi,
                    file_gaps[gi],
                    expanded.get(&(file.path.clone(), gi)),
                );
                gi += 1;
            }
            rows.push(Row::Hunk { file: fi, hunk: hi });
            if split {
                // One row per pair, and a pair's comments are whichever side's
                // comments those lines carry — anchored by line, as always, so
                // the same comment lands in the same place in either view.
                for pair in pair_hunk(hunk) {
                    rows.push(Row::Split {
                        file: fi,
                        hunk: hi,
                        pair,
                    });
                    // A context pair holds the *same* line index on both
                    // sides, so iterating both would push its comments twice —
                    // the body rendered twice, and a phantom stop for `}`.
                    let sides = match (pair.right, pair.left) {
                        (Some(r), Some(l)) if r == l => vec![r],
                        (r, l) => r.into_iter().chain(l).collect(),
                    };
                    for li in sides {
                        push_comments(&mut rows, fi, comments.after_line(fi, hi, li));
                    }
                }
            } else {
                for li in 0..hunk.lines.len() {
                    rows.push(Row::Code {
                        file: fi,
                        hunk: hi,
                        line: li,
                    });
                    push_comments(&mut rows, fi, comments.after_line(fi, hi, li));
                }
            }
            next_line = hunk.new_start + hunk.new_len;
        }
        if let Some(&gap) = file_gaps.get(gi) {
            push_gap(
                &mut rows,
                fi,
                gi,
                gap,
                expanded.get(&(file.path.clone(), gi)),
            );
        }
    }
    rows
}

/// How much of a gap the reviewer has opened, from each end.
pub type Opened = (u32, u32);

/// Rows for one gap: whatever is open at the top, the "⋯" row while anything
/// is still folded, then whatever is open at the bottom.
fn push_gap(
    rows: &mut Vec<Row>,
    file: usize,
    gap: usize,
    range: GapRange,
    opened: Option<&Opened>,
) {
    let (from_start, from_end) = opened.copied().unwrap_or((0, 0));
    // Clamped against each other rather than only against the length: two
    // edges creeping toward the middle must meet exactly once, or the last
    // step renders a line twice and the row model disagrees with the file.
    let len = range.len();
    let from_start = from_start.min(len);
    let from_end = from_end.min(len - from_start);
    for n in 0..from_start {
        rows.push(Row::Context {
            file,
            gap,
            line: range.new_start + n,
        });
    }
    if from_start + from_end < len {
        rows.push(Row::Expand { file, gap });
    }
    for n in (0..from_end).rev() {
        rows.push(Row::Context {
            file,
            gap,
            line: range.new_end - n,
        });
    }
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

/// The columns between the gutters and the code: the space after the old-line
/// gutter, the space after the new-line one, the change marker, and one more
/// space. Four, so a code row is `gutter * 2 + MARKER_COLS` cells of prefix.
///
/// Here rather than in `ui` because two modules have to agree on it. `ui`
/// draws it; `App` subtracts it to turn a mouse column into a column of the
/// line, and a disagreement would put every character-level selection off by
/// a fixed amount — which reads as a plausible anchor, not as an error.
pub const MARKER_COLS: usize = 4;

/// Columns one side of a split row spends before its text: its line-number
/// gutter, then the space, marker and space.
///
/// Here beside `MARKER_COLS`, and for the same reason its doc gives — `ui`
/// draws with it, `App::text_column_at` subtracts it to turn a mouse column
/// back into a column of the line, and the tests locate their coordinates with
/// it. Three copies of the arithmetic is how they drift, and a drift here does
/// not fail: it anchors the comment a few characters off.
pub fn split_side_prefix(gutter: usize) -> usize {
    gutter + MARKER_COLS - 1
}

/// Code columns available to *one* side of a split row: what is left after both
/// prefixes and the one-column divider between them, halved.
pub fn split_half_width(pane_width: usize, gutter: usize) -> usize {
    let chrome = 2 * split_side_prefix(gutter) + 1;
    pane_width.saturating_sub(chrome) / 2
}

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
        let rows = build_rows(
            &files,
            &HashSet::new(),
            &CommentRows::default(),
            &HashMap::new(),
            &HashMap::new(),
            false,
        );
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
        let rows = build_rows(
            &files,
            &HashSet::new(),
            &comments,
            &HashMap::new(),
            &HashMap::new(),
            false,
        );
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
        let rows = build_rows(
            &files,
            &HashSet::new(),
            &comments,
            &HashMap::new(),
            &HashMap::new(),
            false,
        );
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
        let rows = build_rows(
            &files,
            &collapsed,
            &comments,
            &HashMap::new(),
            &HashMap::new(),
            false,
        );
        assert!(!rows.iter().any(|r| r.comment().is_some()));
        assert_eq!(comments_in(&files, 0, &comments), 1);
        assert_eq!(comments_in(&files, 1, &comments), 0);
    }

    #[test]
    fn a_collapsed_file_keeps_its_header_so_it_stays_navigable() {
        let files = parse_patch(TWO_FILES, &[]);
        let collapsed: HashSet<String> = ["a.rs".to_string()].into_iter().collect();
        let rows = build_rows(
            &files,
            &collapsed,
            &CommentRows::default(),
            &HashMap::new(),
            &HashMap::new(),
            false,
        );
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

    /// Two hunks with unchanged runs before, between and after them, and an
    /// old/new offset that is not zero — a diff whose line numbers agree hides
    /// every mistake `delta` can make.
    const SPACED: &str = "diff --git a/a.rs b/a.rs\n\
                          @@ -10,2 +10,3 @@\n\
                          \x20keep\n\
                          +added\n\
                          \x20tail\n\
                          @@ -30,1 +31,1 @@\n\
                          -was\n\
                          +is";

    /// Two separate edits inside one hunk, with context between them, and an
    /// uneven replacement — the shapes that a naive whole-hunk pairing gets
    /// wrong.
    const RUNS: &str = "diff --git a/a.rs b/a.rs\n\
                        @@ -1,7 +1,6 @@\n\
                        \x20head\n\
                        -one\n\
                        -two\n\
                        +uno\n\
                        \x20middle\n\
                        -three\n\
                        +tres\n\
                        +cuatro\n\
                        \x20tail";

    #[test]
    fn a_split_row_pairs_each_edit_with_its_own_replacement() {
        let files = parse_patch(RUNS, &[]);
        let pairs = pair_hunk(&files[0].hunks[0]);
        let kinds: Vec<(Option<usize>, Option<usize>)> =
            pairs.iter().map(|p| (p.left, p.right)).collect();
        assert_eq!(
            kinds,
            vec![
                (Some(0), Some(0)), // context "head"
                (Some(1), Some(3)), // -one / +uno
                (Some(2), None),    // -two, nothing replaced it
                (Some(4), Some(4)), // context "middle"
                (Some(5), Some(6)), // -three / +tres
                (None, Some(7)),    // +cuatro, nothing it replaced
                (Some(8), Some(8)), // context "tail"
            ],
            "each run pairs with its own replacement, not across the context"
        );
    }

    #[test]
    fn every_hunk_line_appears_exactly_once_in_the_split() {
        // The pairing decides what sits beside what; it must not lose a line or
        // show one twice. Either failure is a diff that disagrees with the
        // patch it came from, and reads as a plausible diff.
        for patch in [RUNS, TWO_FILES, SPACED] {
            for file in parse_patch(patch, &[]) {
                for hunk in &file.hunks {
                    let mut seen: Vec<usize> = pair_hunk(hunk)
                        .iter()
                        .flat_map(|p| {
                            // Context appears on both sides as the same index;
                            // count it once.
                            match (p.left, p.right) {
                                (Some(l), Some(r)) if l == r => vec![l],
                                (l, r) => l.into_iter().chain(r).collect(),
                            }
                        })
                        .collect();
                    seen.sort_unstable();
                    let before = seen.len();
                    seen.dedup();
                    assert_eq!(before, seen.len(), "a line paired twice");
                    assert_eq!(
                        seen,
                        (0..hunk.lines.len()).collect::<Vec<_>>(),
                        "every line exactly once"
                    );
                }
            }
        }
    }

    #[test]
    fn split_rows_replace_the_unified_ones_rather_than_joining_them() {
        let files = parse_patch(RUNS, &[]);
        let rows = build_rows(
            &files,
            &HashSet::new(),
            &CommentRows::default(),
            &HashMap::new(),
            &HashMap::new(),
            true,
        );
        assert!(
            !rows.iter().any(|r| matches!(r, Row::Code { .. })),
            "split view draws no unified rows"
        );
        assert_eq!(
            rows.iter()
                .filter(|r| matches!(r, Row::Split { .. }))
                .count(),
            pair_hunk(&files[0].hunks[0]).len()
        );
    }

    #[test]
    fn a_files_gaps_are_the_lines_no_hunk_covers() {
        let files = parse_patch(SPACED, &[]);
        let gaps = gaps_of(&files[0], 60);
        assert_eq!(gaps.len(), 3, "before, between, after: {gaps:?}");

        // Lines 1..9 precede the first hunk, which starts at 10 on both sides.
        assert_eq!(gaps[0].new_start, 1);
        assert_eq!(gaps[0].new_end, 9);
        assert_eq!(gaps[0].old_line(5), Some(5));

        // The first hunk added a line, so everything after it is one further
        // down the new file than the old. Getting this wrong renders the right
        // text against the wrong old number, which reads as a plausible line.
        assert_eq!(gaps[1].new_start, 13);
        assert_eq!(gaps[1].new_end, 30);
        assert_eq!(gaps[1].old_line(13), Some(12));

        assert_eq!(gaps[2].new_start, 32);
        assert_eq!(gaps[2].new_end, 60);
        assert_eq!(gaps[2].old_line(32), Some(31));
    }

    #[test]
    fn a_file_with_no_new_side_offers_no_gap_at_all() {
        // A deletion, and a file emptied without being deleted, both produce
        // `@@ -1,N +0,0 @@`. The trailing-gap guard used to read `0 >= 0` as a
        // one-line gap on a side that has none — a `⋯ 1 unchanged line` row for
        // a line that does not exist, and the only route to `Row::Context
        // { line: 0 }`, whose `line - 1` underflows.
        let emptied = "diff --git a/gone.txt b/gone.txt\n\
                       @@ -1,3 +0,0 @@\n\
                       -one\n\
                       -two\n\
                       -three";
        let files = parse_patch(emptied, &[]);
        assert_eq!(gaps_of(&files[0], 0), Vec::new());
        // And the same when the server *did* send text for it (an emptied file
        // reports `contents: ""`, so the length is a real zero rather than the
        // unknown-length sentinel).
        assert_eq!(gaps_of(&files[0], 0), Vec::new());
    }

    #[test]
    fn a_hunk_that_starts_at_line_one_has_no_gap_before_it() {
        let files = parse_patch(TWO_FILES, &[]);
        let gaps = gaps_of(&files[0], 2);
        assert_eq!(gaps, Vec::new(), "the hunk covers the whole file");
    }

    #[test]
    fn opening_a_gap_from_both_edges_meets_in_the_middle_exactly_once() {
        // The two edges creep toward each other, and the row model has to stay
        // a faithful list of the file: a line rendered twice, or skipped, is a
        // diff that disagrees with itself and nothing on screen says so.
        let files = parse_patch(SPACED, &[]);
        let gaps: HashMap<String, Vec<GapRange>> =
            [("a.rs".to_string(), gaps_of(&files[0], 60))].into();
        let range = gaps["a.rs"][0];
        assert_eq!(range.len(), 9);

        for open in 0..=12u32 {
            let expanded: HashMap<(String, usize), Opened> =
                [(("a.rs".to_string(), 0), (open, open))].into();
            let rows = build_rows(
                &files,
                &HashSet::new(),
                &CommentRows::default(),
                &gaps,
                &expanded,
                false,
            );
            let mut shown: Vec<u32> = rows
                .iter()
                .filter_map(|r| match *r {
                    Row::Context { gap: 0, line, .. } => Some(line),
                    _ => None,
                })
                .collect();
            let before = shown.len();
            shown.sort_unstable();
            shown.dedup();
            assert_eq!(before, shown.len(), "a line rendered twice at open={open}");
            assert!(
                shown.len() as u32 <= range.len(),
                "more lines than the gap holds at open={open}"
            );
            let still_folded = rows
                .iter()
                .any(|r| matches!(*r, Row::Expand { gap: 0, .. }));
            assert_eq!(
                still_folded,
                (shown.len() as u32) < range.len(),
                "the ⋯ row must be there exactly while something is hidden (open={open})"
            );
        }
    }

    #[test]
    fn an_open_gap_reads_top_to_bottom() {
        let files = parse_patch(SPACED, &[]);
        let gaps: HashMap<String, Vec<GapRange>> =
            [("a.rs".to_string(), gaps_of(&files[0], 60))].into();
        let expanded: HashMap<(String, usize), Opened> = [(("a.rs".to_string(), 0), (2, 3))].into();
        let rows = build_rows(
            &files,
            &HashSet::new(),
            &CommentRows::default(),
            &gaps,
            &expanded,
            false,
        );
        let shown: Vec<Row> = rows
            .iter()
            .copied()
            .filter(|r| matches!(r, Row::Context { gap: 0, .. } | Row::Expand { gap: 0, .. }))
            .collect();
        assert_eq!(
            shown,
            vec![
                Row::Context {
                    file: 0,
                    gap: 0,
                    line: 1
                },
                Row::Context {
                    file: 0,
                    gap: 0,
                    line: 2
                },
                Row::Expand { file: 0, gap: 0 },
                Row::Context {
                    file: 0,
                    gap: 0,
                    line: 7
                },
                Row::Context {
                    file: 0,
                    gap: 0,
                    line: 8
                },
                Row::Context {
                    file: 0,
                    gap: 0,
                    line: 9
                },
            ]
        );
    }
}
