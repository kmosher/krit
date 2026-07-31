//! Comments, turned into rows.
//!
//! A comment is anchored to a *line of a file*; the diff pane scrolls over a
//! flat list of rows. Bridging the two is this module's whole job, and it is
//! two problems that look like one:
//!
//! - **Where does it attach.** The anchor names a line number on a side, and
//!   the row model contains only the lines the hunks happened to include. A
//!   comment on a line that is not in any hunk still has to be visible — the
//!   web UI can expand the gap around it, and a terminal client that could not
//!   would simply lose comments as an agent's edits shrink the diff.
//! - **How tall is it.** A body is prose, so its height depends on the width
//!   of the pane. Rows are screen rows — a model row that rendered as three
//!   would break every scroll calculation there is — so the layout is redone
//!   when the pane's width changes, and `App::rebuild` owns that.

use crate::patch::FileDiff;
use crate::text::wrap_columns;
use krit_core::types::ReviewComment;
use std::collections::HashMap;

/// One rendered line of a comment block. The kind is what `ui` styles by; the
/// text is complete, rail prefix and all, so the layout can be tested as text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommentLine {
    /// The badge line: status, where it is anchored, how many replies.
    Head(String),
    Body(String),
    Reply(String),
}

impl CommentLine {
    pub fn text(&self) -> &str {
        match self {
            CommentLine::Head(s) | CommentLine::Body(s) | CommentLine::Reply(s) => s,
        }
    }
}

/// Everything `POST /api/comments` needs about where a comment goes.
///
/// Derived from the reviewer's selection (`App::comment_anchor`) and consumed
/// by the write path, so it lives with the comment model rather than with
/// either end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommentAnchor {
    pub file_path: String,
    /// "additions" or "deletions" — which side's line numbers the range is in.
    pub side: &'static str,
    pub start_line: u32,
    pub end_line: u32,
    /// The anchored lines' text, joined with newlines. What the agent reads
    /// when the comment is quoted back at it.
    pub line_content: String,
    /// A character-level narrowing: start and end column in UTF-16 units, and
    /// the exact text between them. Absent for a line-wise selection.
    pub columns: Option<(u32, u32, String)>,
}

/// Where in the row model a comment ends up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anchor {
    /// After the code row for its last anchored line.
    Line {
        file: usize,
        hunk: usize,
        line: usize,
    },
    /// Under the file's header, because the line it names is in this file but
    /// not in any hunk the diff carries. Rendering it there is the honest
    /// answer: the alternative is a comment that exists, is listed by `krit
    /// comments`, and cannot be seen.
    File { file: usize },
    /// The file itself is not in this review — an agent deleted it, or the
    /// range moved. Nothing to attach to, so these are counted rather than
    /// placed.
    Elsewhere,
}

/// Every comment in the review, laid out and indexed by where it attaches.
#[derive(Debug, Default)]
pub struct CommentRows {
    /// Laid-out lines, parallel to the `comments` slice this was built from.
    blocks: Vec<Vec<CommentLine>>,
    at_line: HashMap<(usize, usize, usize), Vec<usize>>,
    at_file: HashMap<usize, Vec<usize>>,
    /// How many comments anchor to a file this review does not contain.
    pub elsewhere: usize,
}

impl CommentRows {
    /// Comment indices attached after a code row, oldest first.
    pub fn after_line(&self, file: usize, hunk: usize, line: usize) -> &[usize] {
        self.at_line
            .get(&(file, hunk, line))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// Comment indices attached under a file's header, oldest first.
    pub fn under_file(&self, file: usize) -> &[usize] {
        self.at_file
            .get(&file)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    pub fn height(&self, comment: usize) -> usize {
        self.blocks.get(comment).map(Vec::len).unwrap_or(0)
    }

    pub fn line(&self, comment: usize, line: usize) -> Option<&CommentLine> {
        self.blocks.get(comment)?.get(line)
    }
}

/// Lay out every comment for a diff at a given body width.
pub fn layout(comments: &[ReviewComment], files: &[FileDiff], width: usize) -> CommentRows {
    let index = LineIndex::build(files);
    let mut rows = CommentRows {
        blocks: comments.iter().map(|c| block(c, width)).collect(),
        ..CommentRows::default()
    };
    for (i, comment) in comments.iter().enumerate() {
        match index.anchor(comment) {
            Anchor::Line { file, hunk, line } => {
                rows.at_line.entry((file, hunk, line)).or_default().push(i)
            }
            Anchor::File { file } => rows.at_file.entry(file).or_default().push(i),
            Anchor::Elsewhere => rows.elsewhere += 1,
        }
    }
    rows
}

/// Line number to row position, for every line the diff actually carries.
///
/// Built once per rebuild rather than searched per comment: a review with a
/// few hundred comments over a few thousand lines is not unusual, and the
/// naive version is the product of the two.
struct LineIndex {
    /// (file, side-is-additions, line number) → (hunk, line)
    lines: HashMap<(usize, bool, u32), (usize, usize)>,
    paths: HashMap<String, usize>,
}

impl LineIndex {
    fn build(files: &[FileDiff]) -> Self {
        let mut lines = HashMap::new();
        let mut paths = HashMap::new();
        for (fi, file) in files.iter().enumerate() {
            paths.insert(file.path.clone(), fi);
            for (hi, hunk) in file.hunks.iter().enumerate() {
                for (li, line) in hunk.lines.iter().enumerate() {
                    if let Some(n) = line.new_line {
                        lines.insert((fi, true, n), (hi, li));
                    }
                    if let Some(n) = line.old_line {
                        lines.insert((fi, false, n), (hi, li));
                    }
                }
            }
        }
        LineIndex { lines, paths }
    }

    fn anchor(&self, comment: &ReviewComment) -> Anchor {
        let Some(&file) = self.paths.get(&comment.file_path) else {
            return Anchor::Elsewhere;
        };
        // The *last* anchored line, so a multi-line comment sits under the
        // range it covers rather than in the middle of it.
        let additions = comment.side != "deletions";
        let line = comment.end_line_or_start();
        match self.lines.get(&(file, additions, line)) {
            Some(&(hunk, line)) => Anchor::Line { file, hunk, line },
            None => Anchor::File { file },
        }
    }
}

/// The rail every comment line hangs off, so a block reads as an annotation
/// rather than as more diff. Two cells of indent puts it clear of the `+`/`-`
/// column without losing the code's alignment.
const HEAD_RAIL: &str = "   ┌ ";
const BODY_RAIL: &str = "   │ ";

/// One comment as lines, at `width` cells.
fn block(comment: &ReviewComment, width: usize) -> Vec<CommentLine> {
    // Every line pays for the rail, and a pane can be narrower than the rail
    // is long — `max(8)` keeps the wrap from degenerating rather than
    // pretending the space is there.
    let body_width = width.saturating_sub(BODY_RAIL.chars().count()).max(8);
    let mut lines = vec![CommentLine::Head(format!("{HEAD_RAIL}{}", head(comment)))];
    for line in wrap_columns(&comment.body, body_width) {
        lines.push(CommentLine::Body(format!("{BODY_RAIL}{line}")));
    }
    for reply in &comment.replies {
        // Missing author means a store written before the field existed, and
        // consumers treat that as the agent's (see `types.rs`).
        let who = match reply.author.as_deref() {
            Some("user") => "you",
            _ => "agent",
        };
        let mut first = true;
        for line in wrap_columns(&reply.body, body_width.saturating_sub(who.len() + 4).max(8)) {
            let prefix = if first {
                format!("↳ {who}: ")
            } else {
                " ".repeat(who.len() + 4)
            };
            lines.push(CommentLine::Reply(format!("{BODY_RAIL}{prefix}{line}")));
            first = false;
        }
    }
    lines
}

/// The badge line's text: what state this comment is in, what it is anchored
/// to, and how much conversation is under it.
///
/// Every part of it is a word rather than a color — a resolved comment and an
/// open one have to be distinguishable over SSH into a terminal with eight
/// colors, which is where a review client gets used.
fn head(comment: &ReviewComment) -> String {
    let mut parts = vec![status_label(comment).to_string(), range_label(comment)];
    if comment.suggestion.is_some() {
        parts.push("suggestion".to_string());
    }
    match comment.replies.len() {
        0 => {}
        1 => parts.push("1 reply".to_string()),
        n => parts.push(format!("{n} replies")),
    }
    parts.join("  ")
}

pub fn status_label(comment: &ReviewComment) -> &'static str {
    // Outdated wins the badge: a resolved-but-outdated comment is one whose
    // text moved, and that is the thing to say first.
    if comment.outdated == Some(true) {
        return "outdated";
    }
    match comment.status.as_str() {
        "resolved" => "resolved",
        "queued" => "queued",
        _ => "open",
    }
}

/// `12`, `12–14`, `old 12` — and with a character anchor, `12:4–12:9`.
fn range_label(comment: &ReviewComment) -> String {
    let start = comment.line_number;
    let end = comment.end_line_or_start();
    let side = if comment.side == "deletions" {
        "old "
    } else {
        ""
    };
    match (comment.start_column, comment.end_column) {
        (Some(sc), Some(ec)) => format!("{side}{start}:{sc}–{end}:{ec}"),
        _ if end != start => format!("{side}{start}–{end}"),
        _ => format!("{side}{start}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::parse_patch;
    use krit_core::types::CommentReply;

    const PATCH: &str = "diff --git a/a.rs b/a.rs\n\
                         @@ -10,2 +10,3 @@\n\
                         \x20keep\n\
                         -was\n\
                         +is\n\
                         +also";

    fn comment(line: u32, body: &str) -> ReviewComment {
        ReviewComment {
            id: format!("c{line}"),
            file_path: "a.rs".into(),
            side: "additions".into(),
            line_number: line,
            end_line: None,
            line_content: String::new(),
            body: body.into(),
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

    fn text_of(rows: &CommentRows, comment: usize) -> Vec<String> {
        (0..rows.height(comment))
            .map(|i| rows.line(comment, i).unwrap().text().to_string())
            .collect()
    }

    #[test]
    fn a_comment_attaches_to_the_row_its_line_was_rendered_at() {
        let files = parse_patch(PATCH, &[]);
        // New-side line 11 is the "+is" row: hunk 0, line 2.
        let rows = layout(&[comment(11, "here")], &files, 60);
        assert_eq!(rows.after_line(0, 0, 2), &[0]);
        assert!(rows.after_line(0, 0, 0).is_empty());
        assert_eq!(rows.elsewhere, 0);
    }

    #[test]
    fn a_deletion_side_comment_uses_the_old_line_numbers() {
        // Old 11 is "-was" (hunk 0, line 1); new 11 is "+is" (line 2). Reading
        // the wrong side puts the comment on a different line of code, which
        // looks plausible and is wrong.
        let files = parse_patch(PATCH, &[]);
        let mut c = comment(11, "gone");
        c.side = "deletions".into();
        let rows = layout(&[c], &files, 60);
        assert_eq!(rows.after_line(0, 0, 1), &[0]);
    }

    #[test]
    fn a_range_comment_sits_under_the_end_of_its_range() {
        let files = parse_patch(PATCH, &[]);
        let mut c = comment(11, "these two");
        c.end_line = Some(12);
        let rows = layout(&[c], &files, 60);
        assert_eq!(rows.after_line(0, 0, 3), &[0], "under the last line");
        assert!(text_of(&rows, 0)[0].contains("11–12"));
    }

    #[test]
    fn a_comment_on_a_line_outside_every_hunk_goes_under_the_file_header() {
        // Otherwise it is a comment that exists, is listed by `krit comments`,
        // and cannot be seen — which is worse than showing it in the wrong
        // place, because nothing says it is there at all.
        let files = parse_patch(PATCH, &[]);
        let rows = layout(&[comment(400, "far away")], &files, 60);
        assert_eq!(rows.under_file(0), &[0]);
        assert!(rows.after_line(0, 0, 0).is_empty());
    }

    #[test]
    fn a_comment_on_a_file_this_review_does_not_have_is_counted_not_lost() {
        let files = parse_patch(PATCH, &[]);
        let mut c = comment(1, "elsewhere");
        c.file_path = "gone.rs".into();
        let rows = layout(&[c], &files, 60);
        assert_eq!(rows.elsewhere, 1);
        assert_eq!(rows.height(0), 2, "still laid out, just not placed");
    }

    #[test]
    fn several_comments_on_one_line_keep_the_order_they_came_in() {
        let files = parse_patch(PATCH, &[]);
        let rows = layout(&[comment(11, "first"), comment(11, "second")], &files, 60);
        assert_eq!(rows.after_line(0, 0, 2), &[0, 1]);
    }

    #[test]
    fn a_block_is_a_badge_line_plus_however_many_the_body_wraps_to() {
        let files = parse_patch(PATCH, &[]);
        let rows = layout(
            &[comment(11, "one two three four five six seven")],
            &files,
            30,
        );
        let lines = text_of(&rows, 0);
        assert!(lines[0].starts_with("   ┌ open"), "{lines:?}");
        assert!(lines.len() > 2, "the body wrapped: {lines:?}");
        assert!(
            lines[1..].iter().all(|l| l.starts_with("   │ ")),
            "{lines:?}"
        );
        assert_eq!(rows.height(0), lines.len());
    }

    #[test]
    fn every_state_reads_as_a_word_rather_than_as_a_color() {
        let mut c = comment(11, "x");
        assert_eq!(status_label(&c), "open");
        c.status = "resolved".into();
        assert_eq!(status_label(&c), "resolved");
        c.status = "queued".into();
        assert_eq!(status_label(&c), "queued");
        // Outdated wins: a comment whose text moved is the thing to say first,
        // whatever else is true of it.
        c.outdated = Some(true);
        assert_eq!(status_label(&c), "outdated");
    }

    #[test]
    fn the_badge_says_what_a_reader_needs_to_know_before_the_body() {
        let files = parse_patch(PATCH, &[]);
        let mut c = comment(11, "x");
        c.replies = vec![CommentReply {
            id: "r".into(),
            body: "done".into(),
            created_at: 0,
            author: Some("agent".into()),
        }];
        c.start_column = Some(4);
        c.end_column = Some(9);
        let rows = layout(&[c], &files, 60);
        let head = text_of(&rows, 0)[0].clone();
        assert!(head.contains("11:4–11:9"), "{head}");
        assert!(head.contains("1 reply"), "{head}");
    }

    #[test]
    fn replies_are_labelled_by_who_wrote_them() {
        let files = parse_patch(PATCH, &[]);
        let mut c = comment(11, "why?");
        c.replies = vec![
            CommentReply {
                id: "r1".into(),
                body: "because".into(),
                created_at: 0,
                author: Some("agent".into()),
            },
            CommentReply {
                id: "r2".into(),
                body: "fair".into(),
                created_at: 1,
                author: Some("user".into()),
            },
            // Pre-field data: `types.rs` says consumers read a missing author
            // as the agent's.
            CommentReply {
                id: "r3".into(),
                body: "old".into(),
                created_at: 2,
                author: None,
            },
        ];
        let rows = layout(&[c], &files, 60);
        let all = text_of(&rows, 0).join("\n");
        assert!(all.contains("↳ agent: because"), "{all}");
        assert!(all.contains("↳ you: fair"), "{all}");
        assert!(all.contains("↳ agent: old"), "{all}");
    }

    #[test]
    fn a_pane_too_narrow_for_the_rail_still_lays_out() {
        // Not a hypothetical: the diff pane is whatever is left after the file
        // list, and the file list only disappears below 90 columns.
        let files = parse_patch(PATCH, &[]);
        let rows = layout(
            &[comment(11, "a body long enough to need wrapping")],
            &files,
            3,
        );
        assert!(rows.height(0) > 1);
        assert!(rows.line(0, 1).unwrap().text().starts_with("   │ "));
    }
}
