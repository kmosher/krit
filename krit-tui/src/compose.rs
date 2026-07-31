//! Writing: the buffer, its caret, and the form around it.
//!
//! The rule this module exists under is `docs/design/tui.md`'s "no blocking
//! prompts, ever" — the terminal reading of the web UI's ban on `confirm()`.
//! Nothing here waits for a keystroke. The composer is *state*: it is open or
//! it is not, the loop keeps drawing and keeps reading, and a question it
//! needs answered ("discard this?") is a flag that changes what the next key
//! means and a line of text in the strip. Every exit goes through
//! `request_cancel`, which is the same shape `CommentForm.tsx` settled on
//! after a discard path was found that skipped the question.

use crate::comments::CommentAnchor;
use crate::text::{cluster_width, display_width, wrap_spans};
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use unicode_segmentation::UnicodeSegmentation;

/// A text buffer and where the caret is in it.
///
/// One string and one byte offset, rather than a vector of lines: the
/// interesting movements here are *visual* ones, and a wrapped line is not a
/// line of the buffer. Pressing Up in a form full of prose has to go up one
/// row of the screen — going up one paragraph, which is what a line-indexed
/// editor does, is jarring in exactly the case the composer is for. So every
/// vertical movement goes through the same wrap the pane draws with, which
/// means it needs the width, and the buffer may as well be flat.
#[derive(Clone, Debug, Default)]
pub struct Editor {
    text: String,
    /// Byte offset into `text`, always on a grapheme boundary.
    caret: usize,
    /// The display column vertical movement is aiming for. Kept across a run
    /// of up/down so passing through a short line doesn't drag the caret left
    /// permanently — the behavior every editor has and nobody notices until it
    /// is missing.
    goal: Option<usize>,
}

impl Editor {
    pub fn new(text: &str) -> Self {
        // At the end of what it was given: the composer is opened on restored
        // text as often as on nothing, and landing at the top of a paragraph
        // the reviewer already wrote is wrong.
        Editor {
            caret: text.len(),
            text: text.to_string(),
            goal: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_blank(&self) -> bool {
        self.text.trim().is_empty()
    }

    /// Insert at the caret.
    ///
    /// One path for typing and for paste. Bracketed paste arrives as a single
    /// event carrying every line of it — without it, a three-line comment
    /// pasted into the composer is three `Enter`s, which in most terminal
    /// forms submits after the first line and leaves the rest rattling around
    /// in whatever had focus next.
    pub fn insert(&mut self, text: &str) {
        self.goal = None;
        // \r\n and a lone \r both mean a line break here; a terminal paste can
        // carry either, and a literal CR left in the buffer would be sent to
        // the server inside the comment.
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        self.text.insert_str(self.caret, &normalized);
        self.caret += normalized.len();
    }

    pub fn backspace(&mut self) {
        self.goal = None;
        let prev = self.prev_boundary(self.caret);
        self.text.replace_range(prev..self.caret, "");
        self.caret = prev;
    }

    pub fn delete(&mut self) {
        self.goal = None;
        let next = self.next_boundary(self.caret);
        self.text.replace_range(self.caret..next, "");
    }

    /// Ctrl+W: back over any spaces, then back over the word before them —
    /// stopping at the start of the line either way, so it cannot silently
    /// join two paragraphs.
    pub fn delete_word_back(&mut self) {
        self.goal = None;
        let floor = self.text[..self.caret].rfind('\n').map_or(0, |at| at + 1);
        let mut at = self.caret;
        while at > floor && self.text[..at].ends_with(' ') {
            at -= 1;
        }
        while at > floor && !self.text[..at].ends_with(' ') {
            at = self.prev_boundary(at);
        }
        if at == self.caret {
            // Already at the start of a line: take the newline itself, so the
            // key still does something.
            self.backspace();
            return;
        }
        self.text.replace_range(at..self.caret, "");
        self.caret = at;
    }

    /// Ctrl+U: everything on this line before the caret.
    pub fn delete_to_line_start(&mut self) {
        self.goal = None;
        let from = self.text[..self.caret].rfind('\n').map_or(0, |at| at + 1);
        self.text.replace_range(from..self.caret, "");
        self.caret = from;
    }

    pub fn left(&mut self) {
        self.goal = None;
        self.caret = self.prev_boundary(self.caret);
    }

    pub fn right(&mut self) {
        self.goal = None;
        self.caret = self.next_boundary(self.caret);
    }

    pub fn up(&mut self, width: usize) {
        self.vertical(width, true);
    }

    pub fn down(&mut self, width: usize) {
        self.vertical(width, false);
    }

    fn vertical(&mut self, width: usize, up: bool) {
        let spans = wrap_spans(&self.text, width);
        let (row, column) = self.position(&spans);
        let target = if up {
            match row.checked_sub(1) {
                Some(row) => row,
                // Nowhere further up: go to the very start, which is what
                // every editor does and what makes Up-Up-Up reliable.
                None => {
                    self.caret = 0;
                    self.goal = None;
                    return;
                }
            }
        } else if row + 1 < spans.len() {
            row + 1
        } else {
            self.caret = self.text.len();
            self.goal = None;
            return;
        };
        let goal = *self.goal.get_or_insert(column);
        self.caret = column_offset(&self.text, &spans, target, goal);
    }

    pub fn home(&mut self, width: usize) {
        let spans = wrap_spans(&self.text, width);
        let (row, _) = self.position(&spans);
        self.goal = None;
        self.caret = spans[row].start;
    }

    pub fn end(&mut self, width: usize) {
        let spans = wrap_spans(&self.text, width);
        let (row, _) = self.position(&spans);
        self.goal = None;
        self.caret = visible_end(&self.text, &spans, row);
    }

    /// Lay the buffer out at `width` cells: the screen lines, and where the
    /// caret goes on them.
    pub fn layout(&self, width: usize) -> (Vec<String>, (usize, usize)) {
        let spans = wrap_spans(&self.text, width);
        let position = self.position(&spans);
        let lines = spans
            .iter()
            .map(|s| self.text[s.clone()].trim_end_matches(' ').to_string())
            .collect();
        (lines, position)
    }

    /// The caret's screen row and column, given a wrap.
    fn position(&self, spans: &[Range<usize>]) -> (usize, usize) {
        let mut position = (0, 0);
        for (row, span) in spans.iter().enumerate() {
            if self.caret < span.start {
                break;
            }
            // A caret exactly on a boundary belongs to the *later* row: the
            // character it sits in front of was pushed onto the next line by
            // the wrap, and a caret detached from that character is the bug
            // this rule exists to avoid. The loop keeps overwriting, so the
            // last span that can claim it wins.
            if self.caret <= span.end {
                position = (row, display_width(&self.text[span.start..self.caret]));
            }
        }
        position
    }

    fn prev_boundary(&self, at: usize) -> usize {
        self.text[..at]
            .grapheme_indices(true)
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0)
    }

    fn next_boundary(&self, at: usize) -> usize {
        self.text[at..]
            .graphemes(true)
            .next()
            .map(|g| at + g.len())
            .unwrap_or(at)
    }
}

/// Whether a screen row ends because the text ran out of width rather than
/// because the reviewer pressed Enter.
fn soft_wrapped(spans: &[Range<usize>], row: usize) -> bool {
    spans
        .get(row + 1)
        .is_some_and(|next| next.start == spans[row].end)
}

/// The far end of a screen row, as the reviewer sees it.
///
/// One past the last visible character, which on a soft-wrapped row is *not*
/// the span's end: the span keeps the space the wrap broke at, and a caret
/// there is drawn at the start of the next row. End would appear to move down
/// a line.
fn visible_end(text: &str, spans: &[Range<usize>], row: usize) -> usize {
    let span = spans[row].clone();
    if !soft_wrapped(spans, row) {
        return span.end;
    }
    span.start + text[span.clone()].trim_end_matches(' ').len()
}

/// The offset on screen row `row` nearest display column `goal`, rounded back
/// so a column inside a wide character lands on that character.
fn column_offset(text: &str, spans: &[Range<usize>], row: usize, goal: usize) -> usize {
    let span = spans[row].clone();
    let limit = visible_end(text, spans, row);
    let mut col = 0;
    let mut at = span.start;
    for g in text[span].graphemes(true) {
        if at >= limit || col + cluster_width(g) > goal {
            return at;
        }
        col += cluster_width(g);
        at += g.len();
    }
    at.min(limit)
}

/// What an open composer will do when it is submitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A new comment on a marked range.
    Comment(Box<CommentAnchor>),
    /// A reply on an existing comment. `on` is what to call it in the strip —
    /// the id means nothing to the reviewer.
    Reply { id: String, on: String },
    /// The concluding notes of Done reviewing. Optional, and finishing with
    /// none is a normal ending rather than a degenerate one.
    Summary,
}

/// An open form. Not a modal: it is drawn as a pane, the rest of the screen
/// stays live, and the loop never stops redrawing while it is up.
#[derive(Clone, Debug)]
pub struct Composer {
    /// Which form this is, so a write can be matched back to the one that sent
    /// it. `sending` stops one form submitting twice; it cannot stop a *later*
    /// form being closed by an earlier form's answer, and the reviewer can
    /// produce exactly that — Esc out of an in-flight post, open another, and
    /// the first reply lands on the second form and takes its text with it.
    pub id: u64,
    pub target: Target,
    pub editor: Editor,
    /// Esc was pressed on a form with text in it. The strip asks and the next
    /// key answers; nothing waits.
    pub confirm_discard: bool,
    /// A post is in flight. A second `Ctrl+S` while a comment is on its way
    /// would post it twice, and the reviewer has no way to tell the copies
    /// apart afterwards.
    pub sending: bool,
}

/// Handed out by `Composer::new`. Wrapping is not a concern: at one form per
/// keystroke it outlasts the heat death of the review.
static NEXT_COMPOSER_ID: AtomicU64 = AtomicU64::new(1);

impl Composer {
    pub fn new(target: Target, body: &str) -> Self {
        Composer {
            id: NEXT_COMPOSER_ID.fetch_add(1, Ordering::Relaxed),
            target,
            editor: Editor::new(body),
            confirm_discard: false,
            sending: false,
        }
    }

    /// What the reviewer is being asked to write, for the pane's title.
    pub fn title(&self) -> String {
        match &self.target {
            Target::Comment(a) => format!(" Comment on {} ", crate::ui::selection_label(a)),
            Target::Reply { on, .. } => format!(" Reply to “{on}” "),
            Target::Summary => " Done reviewing — any concluding notes? ".to_string(),
        }
    }

    /// Only a new comment can be queued: a reply and a summary are both
    /// answers to something already visible, and withholding one of those from
    /// the agent means holding up a conversation it is waiting on.
    pub fn can_queue(&self) -> bool {
        matches!(self.target, Target::Comment(_))
    }
}

/// What a keystroke means to an open composer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    None,
    /// The buffer changed or the caret moved; redraw.
    Edited,
    Post,
    Queue,
    /// Esc, or the answer to the discard question.
    Cancel,
    /// Anything else while the discard question is up: keep the text.
    KeepEditing,
}

/// Route one key.
///
/// Enter posts. The newline is `Shift+Enter` or `Option+Enter` where the
/// terminal can deliver them, and **`Ctrl+J` everywhere** — which is the only
/// reason the first two are safe to offer. A terminal that does not speak the
/// Kitty keyboard protocol reports `Shift+Enter` as a bare `\r`,
/// indistinguishable from `Enter`, so there it posts rather than breaking the
/// line; without a newline key that needs no protocol at all, that would make
/// a two-line comment impossible to write. `Ctrl+J` is that key, and it is not
/// a lucky accident: raw mode leaves `0x0A` unmapped, so crossterm parses it
/// through the `\x01..=\x1A` arm as `Ctrl+J` rather than as `Enter`, in every
/// terminal there is. `Option+Enter` survives a legacy terminal too whenever
/// it is configured to send Meta as an `ESC` prefix, which is not the default
/// on macOS — so it is an extra, never the fallback.
///
/// The footer therefore promises `Shift+Enter` only where the protocol is up,
/// and `Ctrl+J` otherwise. Do not pick these from the developer's own terminal:
/// the binding that matters is the one that works in the worst terminal, not
/// the best.
///
/// Bracketed paste carries the whole clipboard as one event, which is what
/// keeps a pasted multi-line comment from posting itself after its first line
/// now that Enter submits. `enter_screen` asks for it unconditionally.
///
/// `width` is the pane the text is wrapped to: up, down, home and end are
/// movements on the screen, and a screen row is not a line of the buffer.
pub fn key(composer: &mut Composer, key: KeyEvent, width: usize) -> Intent {
    if key.kind == KeyEventKind::Release {
        return Intent::None;
    }
    // The discard question owns the keyboard while it is up, but it is still
    // not a prompt: the screen is live, the diff still scrolls under it, and
    // any key that is not "yes" puts the reviewer back in their text.
    if composer.confirm_discard {
        return match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Esc => Intent::Cancel,
            _ => Intent::KeepEditing,
        };
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    match (key.code, ctrl, alt) {
        (KeyCode::Char('s'), true, _) => Intent::Post,
        (KeyCode::Enter, true, _) => Intent::Post,
        (KeyCode::Char('q'), true, _) if composer.can_queue() => Intent::Queue,
        // The newline keys, and they have to be matched ahead of the bare
        // `Enter` arm further down rather than beside it, because that arm is
        // what posts now. `Ctrl+J` is the one of the three that no terminal
        // can fail to deliver; the other two are what a reviewer will reach
        // for first, and are silently *not* newlines wherever the modifier
        // never reaches us — see this function's doc.
        (KeyCode::Char('j'), true, _) => {
            composer.editor.insert("\n");
            Intent::Edited
        }
        (KeyCode::Enter, false, true) => {
            composer.editor.insert("\n");
            Intent::Edited
        }
        (KeyCode::Enter, false, false) if shift => {
            composer.editor.insert("\n");
            Intent::Edited
        }
        (KeyCode::Esc, _, _) => Intent::Cancel,
        // Raw mode cleared ISIG, so this is a key like any other and reaching
        // the catch-all would drop it silently — the one key everybody presses
        // when a program looks stuck, doing nothing, in the state most likely
        // to look stuck (`Sending…` against a server that is not answering).
        // It means the same thing Esc does rather than quitting outright:
        // getting out of a form must not be a way to throw away text that
        // exists nowhere else, and the discard question is what asks.
        (KeyCode::Char('c'), true, _) => Intent::Cancel,
        (KeyCode::Char('w'), true, _) => {
            composer.editor.delete_word_back();
            Intent::Edited
        }
        (KeyCode::Char('u'), true, _) => {
            composer.editor.delete_to_line_start();
            Intent::Edited
        }
        (KeyCode::Char('a'), true, _) | (KeyCode::Home, _, _) => {
            composer.editor.home(width);
            Intent::Edited
        }
        (KeyCode::Char('e'), true, _) | (KeyCode::End, _, _) => {
            composer.editor.end(width);
            Intent::Edited
        }
        // Every modified `Enter` was taken above, so this is a bare one.
        (KeyCode::Enter, _, _) => Intent::Post,
        (KeyCode::Backspace, _, _) => {
            composer.editor.backspace();
            Intent::Edited
        }
        (KeyCode::Delete, _, _) => {
            composer.editor.delete();
            Intent::Edited
        }
        (KeyCode::Left, _, _) => {
            composer.editor.left();
            Intent::Edited
        }
        (KeyCode::Right, _, _) => {
            composer.editor.right();
            Intent::Edited
        }
        (KeyCode::Up, _, _) => {
            composer.editor.up(width);
            Intent::Edited
        }
        (KeyCode::Down, _, _) => {
            composer.editor.down(width);
            Intent::Edited
        }
        (KeyCode::Tab, _, _) => {
            // A literal tab, not a focus move: there is one field.
            composer.editor.insert("\t");
            Intent::Edited
        }
        // Alt- and Ctrl-chords we have no meaning for are dropped rather than
        // typed. `Ctrl+c` reaching the buffer as a `c` would be a surprise on
        // the one key everyone expects to interrupt.
        (KeyCode::Char(c), false, false) => {
            composer.editor.insert(&c.to_string());
            Intent::Edited
        }
        _ => Intent::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_of(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, mods)
    }

    fn composer() -> Composer {
        Composer::new(
            Target::Comment(Box::new(CommentAnchor {
                file_path: "a.rs".into(),
                side: "additions",
                start_line: 1,
                end_line: 1,
                line_content: "x".into(),
                columns: None,
            })),
            "",
        )
    }

    fn typed(text: &str) -> Editor {
        let mut editor = Editor::default();
        editor.insert(text);
        editor
    }

    /// Wide enough that nothing wraps, for the tests that are not about that.
    const WIDE: usize = 200;

    #[test]
    fn a_new_editor_starts_at_the_end_of_what_it_was_given() {
        // It is opened on restored text as often as on nothing, and landing at
        // the top of a paragraph the reviewer already wrote is wrong.
        let editor = Editor::new("hello\nthere");
        assert_eq!(editor.text(), "hello\nthere");
        assert_eq!(editor.layout(WIDE).1, (1, 5));
        assert!(Editor::new("").is_blank());
        assert!(Editor::new("  \n\t").is_blank());
    }

    #[test]
    fn a_paste_arrives_as_one_event_and_becomes_several_lines() {
        // Without bracketed paste this is three Enters — the single most
        // likely "obviously broken on day one" bug in the whole design.
        let editor = typed("one\ntwo\nthree");
        assert_eq!(editor.text(), "one\ntwo\nthree");
        assert_eq!(editor.layout(WIDE).1, (2, 5));
    }

    #[test]
    fn a_paste_that_carries_carriage_returns_does_not_smuggle_them_through() {
        // A literal CR in the body would go to the server inside the comment.
        assert_eq!(typed("one\r\ntwo\rthree").text(), "one\ntwo\nthree");
    }

    #[test]
    fn inserting_in_the_middle_keeps_what_came_after_it() {
        let mut editor = typed("hello world");
        editor.home(WIDE);
        editor.right();
        editor.insert("XY");
        assert_eq!(editor.text(), "hXYello world");
        editor.insert("\n");
        assert_eq!(editor.text(), "hXY\nello world");
    }

    #[test]
    fn backspace_joins_lines_and_stops_at_the_start() {
        let mut editor = typed("ab\ncd");
        editor.home(WIDE);
        editor.backspace();
        assert_eq!(editor.text(), "abcd");
        assert_eq!(editor.layout(WIDE).1, (0, 2));
        editor.home(WIDE);
        editor.backspace();
        assert_eq!(editor.text(), "abcd", "nothing before the start");
    }

    #[test]
    fn deleting_moves_by_grapheme_not_by_byte() {
        // A multi-byte character deleted a byte at a time leaves invalid UTF-8
        // — which in Rust is a panic, not a mojibake.
        let mut editor = typed("aé日");
        editor.backspace();
        assert_eq!(editor.text(), "aé");
        editor.backspace();
        assert_eq!(editor.text(), "a");
        // And a cluster is one unit, not its code points.
        let mut editor = typed("e\u{301}");
        editor.backspace();
        assert_eq!(editor.text(), "");
    }

    #[test]
    fn ctrl_w_takes_a_word_and_ctrl_u_takes_the_line_so_far() {
        let mut editor = typed("the quick brown");
        editor.delete_word_back();
        assert_eq!(editor.text(), "the quick ");
        editor.delete_word_back();
        assert_eq!(editor.text(), "the ");

        let mut editor = typed("keep this\nand this");
        editor.delete_to_line_start();
        assert_eq!(editor.text(), "keep this\n");
    }

    #[test]
    fn word_delete_does_not_run_back_into_the_previous_paragraph() {
        // Ctrl+W eating the line break and then the sentence above it is the
        // kind of loss the reviewer cannot see coming.
        let mut editor = typed("first line\nsecond");
        editor.delete_word_back();
        assert_eq!(editor.text(), "first line\n");
        editor.delete_word_back();
        assert_eq!(editor.text(), "first line", "the newline, and no further");
    }

    #[test]
    fn vertical_movement_remembers_the_column_it_was_aiming_for() {
        // Passing through a short line must not drag the caret left for good.
        let mut editor = typed("aaaaaaaa\nbb\ncccccccc");
        editor.up(WIDE);
        editor.up(WIDE);
        assert_eq!(editor.layout(WIDE).1, (0, 8));
        editor.down(WIDE);
        assert_eq!(editor.layout(WIDE).1, (1, 2), "clamped to the short line");
        editor.down(WIDE);
        assert_eq!(editor.layout(WIDE).1, (2, 8), "and back out to the goal");
    }

    #[test]
    fn up_and_down_move_by_screen_row_not_by_paragraph() {
        // The composer is full of prose, so most lines on screen are wrapped
        // ones. Moving by paragraph would skip whole rows the reviewer can see.
        let mut editor = typed("the quick brown fox jumps");
        assert_eq!(editor.layout(10).0.len(), 3);
        editor.up(10);
        assert_eq!(editor.layout(10).1.0, 1, "one row, not to the top");
        editor.up(10);
        assert_eq!(editor.layout(10).1.0, 0);
        editor.down(10);
        assert_eq!(editor.layout(10).1.0, 1);
    }

    #[test]
    fn home_and_end_are_the_ends_of_the_row_the_caret_is_on() {
        let mut editor = typed("the quick brown fox");
        // "the quick " and "brown fox": End on the first row is after
        // "quick", not after the space the wrap broke at — a caret there is
        // drawn at the start of the *next* row, so End would appear to move
        // down a line.
        editor.up(10);
        editor.home(10);
        assert_eq!(editor.layout(10).1, (0, 0));
        editor.end(10);
        assert_eq!(editor.layout(10).1, (0, 9));
    }

    #[test]
    fn the_caret_lands_where_the_wrap_put_the_character_it_is_in_front_of() {
        let mut editor = typed("the quick brown fox");
        let (lines, caret) = editor.layout(10);
        assert_eq!(lines, vec!["the quick", "brown fox"]);
        assert_eq!(caret, (1, 9), "at the end of the second screen line");

        editor.home(10);
        assert_eq!(editor.layout(10).1, (1, 0));
        editor.up(10);
        assert_eq!(editor.layout(10).1, (0, 0));
    }

    #[test]
    fn the_caret_measures_cells_so_wide_text_does_not_drift() {
        let editor = typed("日本語");
        assert_eq!(editor.layout(40).1, (0, 6));
    }

    // ---- the form -------------------------------------------------------

    #[test]
    fn enter_posts_and_three_other_keys_make_a_new_line() {
        let mut c = composer();
        assert_eq!(
            key(&mut c, key_of(KeyCode::Enter, KeyModifiers::NONE), WIDE),
            Intent::Post,
            "a bare Enter is the submit"
        );
        assert_eq!(c.editor.text(), "", "and it typed nothing on the way");
        for (name, event) in [
            ("ctrl-j", key_of(KeyCode::Char('j'), KeyModifiers::CONTROL)),
            ("alt-enter", key_of(KeyCode::Enter, KeyModifiers::ALT)),
            ("shift-enter", key_of(KeyCode::Enter, KeyModifiers::SHIFT)),
        ] {
            let mut c = composer();
            assert_eq!(key(&mut c, event, WIDE), Intent::Edited, "{name}");
            assert_eq!(c.editor.text(), "\n", "{name}");
        }
        // Ctrl+S survives as the binding this form shipped with, and where the
        // Kitty protocol is live the web UI's chord works too.
        for chord in [
            key_of(KeyCode::Char('s'), KeyModifiers::CONTROL),
            key_of(KeyCode::Enter, KeyModifiers::CONTROL),
        ] {
            assert_eq!(key(&mut composer(), chord, WIDE), Intent::Post);
        }
    }

    #[test]
    fn ctrl_j_is_the_new_line_that_needs_no_keyboard_protocol() {
        // The load-bearing one. A terminal that does not speak the Kitty
        // protocol reports shift-enter and ctrl-enter alike as a bare `\r`,
        // which now posts — so without a newline key that survives that, a
        // two-line comment would be impossible to write there. Ctrl+J is it:
        // raw mode leaves 0x0A unmapped, so crossterm parses it as Ctrl+J
        // rather than as Enter. This asserts the *legacy* shape deliberately —
        // a bare Enter standing in for the shift-enter that never arrived.
        let mut c = composer();
        key(&mut c, key_of(KeyCode::Char('o'), KeyModifiers::NONE), WIDE);
        assert_eq!(
            key(&mut c, key_of(KeyCode::Enter, KeyModifiers::NONE), WIDE),
            Intent::Post,
            "what shift-enter degrades to"
        );
        assert_eq!(
            key(
                &mut c,
                key_of(KeyCode::Char('j'), KeyModifiers::CONTROL),
                WIDE
            ),
            Intent::Edited
        );
        key(&mut c, key_of(KeyCode::Char('k'), KeyModifiers::NONE), WIDE);
        assert_eq!(
            c.editor.text(),
            "o\nk",
            "two lines, on a terminal with no protocol at all"
        );
    }

    #[test]
    fn only_a_new_comment_can_be_queued() {
        // A reply and a summary are answers to something already visible;
        // withholding one holds up a conversation the agent is waiting on.
        let mut c = composer();
        assert_eq!(
            key(
                &mut c,
                key_of(KeyCode::Char('q'), KeyModifiers::CONTROL),
                WIDE
            ),
            Intent::Queue
        );
        let mut reply = Composer::new(
            Target::Reply {
                id: "i".into(),
                on: "why?".into(),
            },
            "",
        );
        assert!(!reply.can_queue());
        assert_eq!(
            key(
                &mut reply,
                key_of(KeyCode::Char('q'), KeyModifiers::CONTROL),
                WIDE
            ),
            Intent::None,
            "not typed as a `q` either"
        );
    }

    #[test]
    fn the_discard_question_is_answered_by_a_key_not_waited_on() {
        // The terminal reading of the ban on `confirm()`: this is a flag and a
        // line of text, and the loop keeps drawing the whole time.
        let mut c = composer();
        key(&mut c, key_of(KeyCode::Char('x'), KeyModifiers::NONE), WIDE);
        c.confirm_discard = true;
        assert_eq!(
            key(&mut c, key_of(KeyCode::Char('j'), KeyModifiers::NONE), WIDE),
            Intent::KeepEditing
        );
        assert_eq!(
            key(&mut c, key_of(KeyCode::Char('y'), KeyModifiers::NONE), WIDE),
            Intent::Cancel
        );
        assert_eq!(
            c.editor.text(),
            "x",
            "still there until the caller drops it"
        );
    }

    #[test]
    fn a_control_chord_with_no_meaning_here_is_not_typed_into_the_body() {
        // A chord landing in the buffer as its bare letter is a surprise the
        // reviewer only finds later, in the posted comment.
        let mut c = composer();
        assert_eq!(
            key(
                &mut c,
                key_of(KeyCode::Char('g'), KeyModifiers::CONTROL),
                WIDE
            ),
            Intent::None
        );
        assert_eq!(c.editor.text(), "");
    }

    #[test]
    fn ctrl_c_asks_the_discard_question_rather_than_doing_nothing() {
        // ISIG is off in raw mode, so this is an ordinary key here. Dropping it
        // meant the one key everybody presses when a program looks stuck did
        // nothing at all for as long as a form was up. It gets Esc's meaning,
        // not the program's: leaving a form must not be a way to lose text.
        let mut c = composer();
        c.editor.insert("half a thought");
        assert_eq!(
            key(
                &mut c,
                key_of(KeyCode::Char('c'), KeyModifiers::CONTROL),
                WIDE
            ),
            Intent::Cancel
        );
        assert_eq!(c.editor.text(), "half a thought", "nothing thrown away yet");
    }

    #[test]
    fn tab_types_a_tab_because_there_is_only_one_field() {
        let mut c = composer();
        key(&mut c, key_of(KeyCode::Tab, KeyModifiers::NONE), WIDE);
        assert_eq!(c.editor.text(), "\t");
    }
}
