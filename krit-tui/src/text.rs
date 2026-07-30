//! Turning source text into terminal cells.
//!
//! A terminal is a grid of cells, and `char` is not a cell: CJK and most
//! emoji occupy two, combining marks occupy none, and a tab occupies however
//! many are left before the next tab stop. Everything here counts *columns*,
//! and every offset a caller passes in or gets back is a column offset. The
//! payoff is that horizontal scrolling, truncation and (later) a caret all
//! land where the user sees the character, rather than where its first byte
//! happens to be.

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
    let stop = tab_size.max(1);
    let mut out = String::with_capacity(s.len());
    let mut col = 0;
    for g in s.graphemes(true) {
        if g == "\t" {
            let pad = stop - (col % stop);
            out.extend(std::iter::repeat_n(' ', pad));
            col += pad;
        } else {
            out.push_str(g);
            col += cluster_width(g);
        }
    }
    out
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
}
