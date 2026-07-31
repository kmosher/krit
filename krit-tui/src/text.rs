//! Turning source text into terminal cells.
//!
//! A terminal is a grid of cells, and `char` is not a cell: CJK and most
//! emoji occupy two, combining marks occupy none, and a tab occupies however
//! many are left before the next tab stop. Everything here counts *columns*,
//! and every offset a caller passes in or gets back is a column offset. The
//! payoff is that horizontal scrolling, truncation and (later) a caret all
//! land where the user sees the character, rather than where its first byte
//! happens to be.

use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Zero-width joiner. Its whole job is to fuse several emoji into one glyph,
/// so the parts after it are not separate cells.
const ZWJ: char = '\u{200d}';

/// How many cells one grapheme cluster occupies.
///
/// Summing `unicode_width` over the cluster is wrong for ZWJ sequences: a
/// three-person family emoji is one glyph in two cells, but sums to six. So
/// the width is that of the leading segment — everything before the first
/// ZWJ. Sequences joined *without* a ZWJ (regional-indicator flag pairs) do
/// sum correctly, which is why this cuts at the joiner rather than at the
/// first character.
pub fn cluster_width(cluster: &str) -> usize {
    match cluster.find(ZWJ) {
        Some(cut) => cluster[..cut].width(),
        None => cluster.width(),
    }
}

/// Display width of a string, in cells.
pub fn display_width(s: &str) -> usize {
    s.graphemes(true).map(cluster_width).sum()
}

/// Expand tabs to the next tab stop. A tab is not `tab_size` spaces — it is
/// however many spaces reach the next multiple of `tab_size`, which is why
/// this has to know the column it starts at, and why it cannot be done with
/// `str::replace`.
pub fn expand_tabs(s: &str, tab_size: usize) -> String {
    let mut out = String::with_capacity(s.len());
    let mut col = 0;
    for g in s.graphemes(true) {
        let advance = cluster_advance(g, col, tab_size);
        if g == "\t" {
            out.extend(std::iter::repeat_n(' ', advance));
        } else {
            out.push_str(g);
        }
        col += advance;
    }
    out
}

/// How many cells `g` occupies when it starts at column `col`.
///
/// Only a tab depends on `col`, and that dependency is the whole reason this
/// is a shared function rather than two copies of the same arithmetic. The
/// renderer walks a line through `expand_tabs` while `highlight` walks the
/// same line to put syntax runs in column space; a tab rule that differed
/// between them would not fail, it would tint the wrong characters, and only
/// on lines that happen to contain a tab.
pub fn cluster_advance(g: &str, col: usize, tab_size: usize) -> usize {
    if g == "\t" {
        let stop = tab_size.max(1);
        stop - (col % stop)
    } else {
        cluster_width(g)
    }
}

/// The part of `s` visible in a window `width` cells wide starting at column
/// `start`, as a string whose display width is at most `width`.
///
/// A double-width cluster straddling either edge becomes a space per visible
/// column: half a character is not a character, but dropping it silently
/// would shift everything after it left by one and misalign the whole line.
pub fn slice_columns(s: &str, start: usize, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let end = start.saturating_add(width);
    let mut out = String::new();
    let mut col = 0;

    for g in s.graphemes(true) {
        if col >= end {
            break;
        }
        let w = cluster_width(g);
        let next = col + w;
        if next <= start {
            col = next;
            continue;
        }
        if col >= start && next <= end {
            out.push_str(g);
        } else {
            // Straddles an edge: emit a space for each column of it that is
            // actually inside the window.
            let visible = next.min(end).saturating_sub(col.max(start));
            out.extend(std::iter::repeat_n(' ', visible));
        }
        col = next;
    }
    out
}

/// `s` padded with spaces to exactly `width` cells, or sliced down to it.
/// Used for the fixed-width gutters, where a short field would drag the
/// column after it out of line.
pub fn fit_columns(s: &str, width: usize) -> String {
    let mut out = slice_columns(s, 0, width);
    let w = display_width(&out);
    out.extend(std::iter::repeat_n(' ', width.saturating_sub(w)));
    out
}

/// Break `s` into lines of at most `width` cells, at spaces where there is
/// one.
///
/// Newlines already in the text are kept — a comment body is prose the
/// reviewer wrote, and its paragraphs are theirs. A word wider than the
/// window is broken mid-word rather than allowed to overflow: a 200-character
/// URL in a comment would otherwise be clipped by the pane and read as if the
/// comment stopped there.
pub fn wrap_columns(s: &str, width: usize) -> Vec<String> {
    wrap_spans(s, width)
        .into_iter()
        // Only spaces, and only the ones the wrap itself put on the end, so a
        // line of pasted code keeps whatever else is on it.
        .map(|r| s[r].trim_end_matches(' ').to_string())
        .collect()
}

/// The same wrap, as byte ranges of `s`.
///
/// Separate from `wrap_columns` because the composer needs to put a caret in
/// the wrapped text, which means knowing where each screen line came from —
/// and two wrap implementations that disagree would put the caret one place
/// and the character it is in front of somewhere else.
///
/// Ranges are in order and cover the whole string; the newline between two
/// paragraphs belongs to neither.
pub fn wrap_spans(s: &str, width: usize) -> Vec<Range<usize>> {
    // Nowhere to wrap to, but a caller still needs a span to look a caret up
    // in — an empty answer would make every position row 0, column 0. (Written
    // as a collect because clippy reads `vec![a..b]` as a mistyped range.)
    if width == 0 {
        return std::iter::once(0..s.len()).collect();
    }
    let mut out = Vec::new();
    let mut base = 0usize;
    for para in s.split('\n') {
        let mut start = 0usize;
        let mut col = 0usize;
        let mut at = 0usize;
        // Byte offset just past the most recent space, which is where this
        // line would rather be cut than mid-word.
        let mut wrap_at: Option<usize> = None;
        for g in para.graphemes(true) {
            let w = cluster_width(g);
            // `at > start` guarantees progress: a cluster wider than the whole
            // window overflows one line rather than looping forever.
            if col + w > width && at > start {
                let cut = wrap_at.filter(|&at| at > start).unwrap_or(at);
                out.push(base + start..base + cut);
                start = cut;
                col = display_width(&para[start..at]);
                wrap_at = None;
            }
            at += g.len();
            col += w;
            if g == " " {
                wrap_at = Some(at);
            }
        }
        out.push(base + start..base + para.len());
        base += para.len() + 1; // the '\n' that split consumed
    }
    out
}

/// A position in a line's source text, in the two units that matter.
///
/// `byte` indexes the Rust string for slicing here; `utf16` is what goes on
/// the wire. Columns are UTF-16 code units because that is what the browser
/// measures them in (`Range.toString().length`, and `edits.rs` converts back
/// with `utf16_col_to_byte`), and a comment anchored by one client has to mean
/// the same span to the other.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourcePos {
    pub byte: usize,
    pub utf16: usize,
}

/// The source range covered by display column `column` of `s`, rendered with
/// tabs expanded to `tab_size`.
///
/// Half-open: the first position is the start of the cluster drawn in that
/// cell, the second is its end. A terminal selection is made of *cells*, not
/// of caret positions — the cell under the pointer is in the selection, so a
/// drag that starts and ends on one column covers one character rather than
/// nothing. That is the one place this deliberately differs from the browser,
/// where each endpoint is an insertion point between characters.
///
/// Past the end of the line both positions are the end of it, so a drag into
/// the blank right-hand side of the pane selects to end-of-line.
pub fn cluster_at_column(s: &str, tab_size: usize, column: usize) -> (SourcePos, SourcePos) {
    let stop = tab_size.max(1);
    let mut col = 0usize;
    let mut at = SourcePos::default();
    for g in s.graphemes(true) {
        let w = if g == "\t" {
            stop - (col % stop)
        } else {
            cluster_width(g)
        };
        let next = SourcePos {
            byte: at.byte + g.len(),
            utf16: at.utf16 + g.chars().map(char::len_utf16).sum::<usize>(),
        };
        // A tab is one source character occupying several cells; a pointer
        // anywhere in it selects the tab.
        if column < col + w.max(1) {
            return (at, next);
        }
        col += w;
        at = next;
    }
    (at, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cjk_character_is_two_cells_and_a_combining_mark_is_none() {
        assert_eq!(display_width("abc"), 3);
        assert_eq!(display_width("日本語"), 6);
        // e + combining acute is one cluster, one cell.
        assert_eq!(display_width("e\u{301}"), 1);
    }

    #[test]
    fn a_zwj_sequence_is_one_glyph_in_two_cells() {
        // Summing the parts gives 6, which would push everything after this
        // emoji four cells to the right of where the terminal draws it.
        let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
        assert_eq!(cluster_width(family), 2);
        assert_eq!(display_width(family), 2);
    }

    #[test]
    fn a_flag_is_a_pair_that_does_sum() {
        // Regional indicators are joined without a ZWJ, so the leading-segment
        // rule must not cut them down to one.
        assert_eq!(display_width("\u{1f1f8}\u{1f1ea}"), 2);
    }

    #[test]
    fn tabs_expand_to_the_next_stop_not_to_a_fixed_width() {
        assert_eq!(expand_tabs("\tx", 4), "    x");
        assert_eq!(expand_tabs("ab\tx", 4), "ab  x");
        assert_eq!(expand_tabs("abcd\tx", 4), "abcd    x");
        // Two tabs in a row each reach their own stop.
        assert_eq!(expand_tabs("a\t\tb", 4), "a       b");
    }

    #[test]
    fn tab_stops_count_cells_so_a_wide_character_shifts_them() {
        // "日" is two cells, so the tab after it has two columns left to fill,
        // not three. Counting characters instead of cells gets this wrong.
        assert_eq!(expand_tabs("日\tx", 4), "日  x");
    }

    #[test]
    fn slicing_takes_a_window_measured_in_cells() {
        assert_eq!(slice_columns("abcdef", 0, 3), "abc");
        assert_eq!(slice_columns("abcdef", 2, 3), "cde");
        assert_eq!(slice_columns("abcdef", 4, 10), "ef");
        assert_eq!(slice_columns("abcdef", 10, 3), "");
        assert_eq!(slice_columns("abcdef", 0, 0), "");
    }

    #[test]
    fn a_wide_character_cut_by_an_edge_becomes_a_space_per_visible_column() {
        // Scrolling one column into "日本" shows the right half of 日, which
        // is not a character — but it is still a cell, and dropping it would
        // slide 本 left and misalign every line that scrolled differently.
        assert_eq!(slice_columns("日本", 1, 3), " 本");
        // Same at the trailing edge.
        assert_eq!(slice_columns("日本", 0, 3), "日 ");
        assert_eq!(display_width(&slice_columns("日本語", 1, 4)), 4);
    }

    #[test]
    fn fitting_pads_short_and_truncates_long() {
        assert_eq!(fit_columns("42", 5), "42   ");
        assert_eq!(fit_columns("abcdef", 3), "abc");
        // Padding is measured in cells too, so a wide field still lands right.
        assert_eq!(display_width(&fit_columns("日", 5)), 5);
    }

    #[test]
    fn wrapping_breaks_at_spaces_and_keeps_the_authors_paragraphs() {
        assert_eq!(
            wrap_columns("the quick brown fox", 10),
            vec!["the quick", "brown fox"]
        );
        assert_eq!(
            wrap_columns("one\n\ntwo", 10),
            vec!["one", "", "two"],
            "a blank line the reviewer typed is a blank line"
        );
        assert_eq!(wrap_columns("short", 10), vec!["short"]);
        assert_eq!(wrap_columns("", 10), vec![""]);
    }

    #[test]
    fn a_word_wider_than_the_window_is_broken_rather_than_clipped() {
        // Clipping would read as the comment stopping there.
        assert_eq!(
            wrap_columns("aaaaaaaaaa", 4),
            vec!["aaaa", "aaaa", "aa"],
            "no line is wider than the window"
        );
        // And it still makes progress when a single cluster does not fit.
        assert_eq!(wrap_columns("日本", 1), vec!["日", "本"]);
    }

    #[test]
    fn wrapping_measures_cells_not_characters() {
        // Six cells of CJK in a five-cell window is two lines, not one.
        assert_eq!(wrap_columns("日本語", 5), vec!["日本", "語"]);
        for line in wrap_columns("日本語 and some ascii too", 8) {
            assert!(display_width(&line) <= 8, "{line:?}");
        }
    }

    #[test]
    fn wrapped_spans_cover_the_whole_string_and_agree_with_the_lines() {
        // The composer puts a caret in the wrapped text by looking up the span
        // it lands in, so a span that disagreed with the line drawn from it
        // would put the caret in front of the wrong character.
        let s = "the quick brown fox\njumps over";
        let spans = wrap_spans(s, 10);
        let lines = wrap_columns(s, 10);
        assert_eq!(spans.len(), lines.len());
        for (span, line) in spans.iter().zip(&lines) {
            assert_eq!(s[span.clone()].trim_end_matches(' '), line);
        }
        // Contiguous, skipping exactly the newline.
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans.last().unwrap().end, s.len());
        for pair in spans.windows(2) {
            let gap = pair[1].start - pair[0].end;
            assert!(gap <= 1, "{pair:?}");
        }
    }

    #[test]
    fn a_column_resolves_to_the_character_drawn_in_it() {
        let (start, end) = cluster_at_column("abc", 4, 1);
        assert_eq!(start.byte, 1);
        assert_eq!(end.byte, 2);
        // The cell under the pointer is *in* the selection, so one column is
        // one character rather than an empty range.
        assert_eq!(&"abc"[start.byte..end.byte], "b");
    }

    #[test]
    fn a_tab_is_one_character_however_many_cells_it_takes() {
        // Anywhere in the whitespace a tab drew selects the tab itself; the
        // column offsets that go on the wire are offsets into the source, and
        // the source has one character there.
        for column in 0..4 {
            let (start, end) = cluster_at_column("\tx", 4, column);
            assert_eq!((start.byte, end.byte), (0, 1), "column {column}");
        }
        let (start, _) = cluster_at_column("\tx", 4, 4);
        assert_eq!(start.byte, 1, "the character after the tab");
    }

    #[test]
    fn columns_on_the_wire_are_utf16_units_the_browser_agrees_with() {
        // An emoji is one cluster, two cells, and two UTF-16 units — three
        // different numbers for the same character, and only one of them is
        // what the other client means by a column.
        let (start, end) = cluster_at_column("a🙂b", 4, 1);
        assert_eq!((start.utf16, end.utf16), (1, 3));
        assert_eq!((start.byte, end.byte), (1, 5));
        // The cell after it is the second half of the same emoji.
        assert_eq!(cluster_at_column("a🙂b", 4, 2).0.utf16, 1);
        assert_eq!(cluster_at_column("a🙂b", 4, 3).0.utf16, 3);
    }

    #[test]
    fn a_column_past_the_end_of_the_line_is_the_end_of_the_line() {
        // Dragging into the blank right-hand side of the pane selects to the
        // end of the line, rather than to nowhere.
        let (start, end) = cluster_at_column("abc", 4, 99);
        assert_eq!((start.byte, end.byte), (3, 3));
        assert_eq!(
            cluster_at_column("", 4, 0),
            (SourcePos::default(), SourcePos::default())
        );
    }
}
