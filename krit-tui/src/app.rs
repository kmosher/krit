//! Viewer state, and every transition it can make.
//!
//! Keys map to an `Action` and actions apply to an `App`; neither step
//! touches a terminal. That is the same split the web UI keeps for the same
//! reason — the interesting behavior (where the cursor lands, what the view
//! scrolls to, what survives a refetch) is testable without a screen, and
//! what's left in `ui.rs` is drawing.

use crate::client::DiffPayload;
use crate::patch::{FileDiff, parse_patch};
use crate::rows::{Row, build_rows, file_rows, hunk_rows, next_stop, scroll_to_show};
use ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    Files,
    Diff,
}

/// Where the last frame put things, so a click can be turned back into the
/// thing under it.
///
/// Written by `ui::draw` and read by `App::mouse_action`. Hit-testing against
/// anything else — a remembered constant, a recomputed layout — is a second
/// opinion about the screen, and the two will disagree the first time a pane
/// is hidden or the terminal is resized.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Panes {
    /// The rows the diff occupies, and the row index drawn at its top.
    pub diff: Rect,
    pub diff_top_row: usize,
    /// `None` when the file list is hidden — by the `f` toggle or because the
    /// terminal is too narrow for it.
    pub files: Option<Rect>,
    /// Index of the first file drawn in that list; the list scrolls with the
    /// cursor, so this is not always 0.
    pub files_top: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Quit,
    Down(usize),
    Up(usize),
    HalfPageDown,
    HalfPageUp,
    Top,
    Bottom,
    NextFile,
    PrevFile,
    NextHunk,
    PrevHunk,
    ScrollLeft(usize),
    ScrollRight(usize),
    ResetHScroll,
    ToggleFocus,
    ToggleCollapse,
    Refetch,
    ToggleHelp,
    Suspend,
    ToggleFiles,
    /// Release the mouse back to the terminal (or take it again).
    ToggleMouse,
    /// Move the *view* without moving the cursor — what a wheel does. Every
    /// other movement drags the view along behind the cursor; this one is the
    /// exception, and keeping it a separate action is what stops the next
    /// `scroll_to_show` from immediately undoing it.
    ScrollViewDown(usize),
    ScrollViewUp(usize),
    /// Put the cursor on a row, or on a file's header. From a click.
    FocusRow(usize),
    FocusFile(usize),
}

/// A line of feedback under the diff. Not a modal, and never a prompt: the
/// web UI's ban on blocking dialogs is really a ban on the program refusing
/// to redraw until someone answers, and a terminal can break that rule just
/// as easily as a browser can.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Idle,
    Note(String),
    Error(String),
    /// The review is over; the viewer stays up so the diff is still readable.
    Ended(String),
}

pub struct App {
    pub files: Vec<FileDiff>,
    pub rows: Vec<Row>,
    pub collapsed: HashSet<String>,
    pub cursor: usize,
    pub offset: usize,
    pub h_scroll: usize,
    pub focus: Focus,
    pub repo: String,
    pub branch: String,
    pub custom_mode: bool,
    pub status: Status,
    pub show_help: bool,
    pub show_files: bool,
    /// Whether we are holding the mouse. On, the wheel scrolls and a click
    /// moves the cursor; off, the terminal gets its own selection back so the
    /// reviewer can copy a line the ordinary way.
    pub mouse: bool,
    pub tab_size: usize,
    pub should_quit: bool,
    pub panes: Panes,
}

impl Default for App {
    fn default() -> Self {
        Self {
            files: Vec::new(),
            rows: Vec::new(),
            collapsed: HashSet::new(),
            cursor: 0,
            offset: 0,
            h_scroll: 0,
            focus: Focus::Diff,
            repo: String::new(),
            branch: String::new(),
            custom_mode: false,
            status: Status::Idle,
            show_help: false,
            show_files: true,
            mouse: true,
            tab_size: 4,
            should_quit: false,
            panes: Panes::default(),
        }
    }
}

impl App {
    /// Take a fresh diff, keeping the reader where they were.
    ///
    /// A refetch happens on every save, so landing back at the top would make
    /// the file the reviewer is reading unreadable while they edit it. The
    /// anchor is the file, not the row index: rows above it shift by however
    /// much the edit changed.
    pub fn load(&mut self, payload: &DiffPayload) {
        let anchor = self.cursor_path();
        self.repo = payload.repo_name.clone();
        self.branch = payload.branch.clone();
        self.custom_mode = payload.custom_mode;
        self.files = parse_patch(&payload.patch, &payload.untracked_files);
        self.rebuild();
        self.cursor = match anchor.and_then(|p| self.row_of_path(&p)) {
            Some(row) => row,
            None => self.cursor.min(self.rows.len().saturating_sub(1)),
        };
    }

    pub fn rebuild(&mut self) {
        self.rows = build_rows(&self.files, &self.collapsed);
        if self.cursor >= self.rows.len() {
            self.cursor = self.rows.len().saturating_sub(1);
        }
    }

    pub fn cursor_path(&self) -> Option<String> {
        self.rows
            .get(self.cursor)
            .and_then(|r| r.file())
            .and_then(|f| self.files.get(f))
            .map(|f| f.path.clone())
    }

    fn row_of_path(&self, path: &str) -> Option<usize> {
        let index = self.files.iter().position(|f| f.path == path)?;
        self.rows
            .iter()
            .position(|r| matches!(r, Row::File { file } if *file == index))
    }

    /// Index of the file the cursor is in — what the file list highlights.
    pub fn current_file(&self) -> Option<usize> {
        if self.rows.is_empty() {
            return None;
        }
        // A gap row belongs to no file, so look back for the last one that
        // does rather than letting the highlight blink off between files.
        let end = self.cursor.min(self.rows.len() - 1);
        self.rows[..=end].iter().rev().find_map(|r| r.file())
    }

    pub fn apply(&mut self, action: Action, viewport: usize) {
        let last = self.rows.len().saturating_sub(1);

        // Wheel scrolling moves the view out from under the cursor on purpose,
        // so it must not fall through to the `scroll_to_show` below — that
        // call exists to drag the view *to* the cursor and would undo this
        // before the frame was drawn. The cursor is picked up again by the
        // next movement key, which is what scrolling ahead to read and then
        // carrying on should feel like.
        let max_offset = self.rows.len().saturating_sub(viewport);
        match action {
            Action::ScrollViewDown(n) => {
                self.offset = (self.offset + n).min(max_offset);
                return;
            }
            Action::ScrollViewUp(n) => {
                self.offset = self.offset.saturating_sub(n);
                return;
            }
            _ => {}
        }

        match action {
            Action::None => {}
            Action::Quit => self.should_quit = true,
            Action::Down(n) => self.cursor = (self.cursor + n).min(last),
            Action::Up(n) => self.cursor = self.cursor.saturating_sub(n),
            Action::HalfPageDown => self.cursor = (self.cursor + viewport / 2).min(last),
            Action::HalfPageUp => self.cursor = self.cursor.saturating_sub(viewport / 2),
            Action::Top => self.cursor = 0,
            Action::Bottom => self.cursor = last,
            Action::NextFile => {
                self.jump(&file_rows(&self.rows), true);
                self.reveal_at_top(viewport);
            }
            Action::PrevFile => {
                self.jump(&file_rows(&self.rows), false);
                self.reveal_at_top(viewport);
            }
            Action::NextHunk => self.jump(&hunk_rows(&self.rows), true),
            Action::PrevHunk => self.jump(&hunk_rows(&self.rows), false),
            Action::ScrollRight(n) => self.h_scroll += n,
            Action::ScrollLeft(n) => self.h_scroll = self.h_scroll.saturating_sub(n),
            Action::ResetHScroll => self.h_scroll = 0,
            Action::ToggleFocus => {
                self.focus = match self.focus {
                    Focus::Diff => Focus::Files,
                    Focus::Files => Focus::Diff,
                }
            }
            Action::ToggleCollapse => self.toggle_collapse(),
            Action::ToggleHelp => self.show_help = !self.show_help,
            Action::ToggleFiles => {
                self.show_files = !self.show_files;
                // Focus cannot stay on a pane that is no longer drawn.
                if !self.show_files {
                    self.focus = Focus::Diff;
                }
            }
            Action::ToggleMouse => self.mouse = !self.mouse,
            Action::FocusRow(row) => {
                self.cursor = row.min(last);
                self.focus = Focus::Diff;
            }
            Action::FocusFile(index) => {
                if let Some(file) = self.files.get(index)
                    && let Some(row) = self.row_of_path(&file.path.clone())
                {
                    self.cursor = row;
                    self.reveal_at_top(viewport);
                }
                self.focus = Focus::Files;
            }
            // Returned above.
            Action::ScrollViewDown(_) | Action::ScrollViewUp(_) => {}
            // Handled by the caller, which owns the socket and the terminal.
            Action::Refetch | Action::Suspend => {}
        }
        self.offset = scroll_to_show(self.offset, viewport, self.cursor, self.rows.len());
    }

    /// What a mouse event means, given where the last frame put things.
    ///
    /// Returns `None` for anything outside a pane or that we don't act on, so
    /// the caller can tell "not for us" from "do nothing" — a drag across the
    /// screen is a stream of moves, and treating each as a click would drag
    /// the cursor with it.
    pub fn mouse_action(&self, event: MouseEvent) -> Action {
        if !self.mouse {
            return Action::None;
        }
        let (col, row) = (event.column, event.row);
        match event.kind {
            // Three lines a notch, the same as most pagers. The wheel is for
            // reading ahead, so it does not disturb the cursor.
            MouseEventKind::ScrollDown => Action::ScrollViewDown(3),
            MouseEventKind::ScrollUp => Action::ScrollViewUp(3),
            // Terminals that report horizontal wheels (or shift+wheel) send
            // these; the diff is the only thing that scrolls sideways.
            MouseEventKind::ScrollRight => Action::ScrollRight(4),
            MouseEventKind::ScrollLeft => Action::ScrollLeft(4),
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(files) = self.files_pane_hit(col, row) {
                    return files;
                }
                self.diff_hit(col, row)
            }
            _ => Action::None,
        }
    }

    fn files_pane_hit(&self, col: u16, row: u16) -> Option<Action> {
        let area = self.panes.files?;
        if !contains(area, col, row) {
            return None;
        }
        let index = self.panes.files_top + (row - area.y) as usize;
        // Below the last file is still inside the pane — clicking the empty
        // part of a short list should do nothing, not select the last file.
        (index < self.files.len()).then_some(Action::FocusFile(index))
    }

    fn diff_hit(&self, col: u16, row: u16) -> Action {
        let area = self.panes.diff;
        if !contains(area, col, row) {
            return Action::None;
        }
        let index = self.panes.diff_top_row + (row - area.y) as usize;
        if index >= self.rows.len() {
            return Action::None;
        }
        Action::FocusRow(index)
    }

    /// Put the cursor's row at the top of the view.
    ///
    /// Only for *going to a file* — clicking one in the list, or `]`/`[`.
    /// Minimal scrolling is right when the cursor is walking, but a jump
    /// under it lands the file header on the last visible row, so arriving
    /// at a file means looking at the end of the one before it. Asking to go
    /// somewhere and being shown where you came from is the wrong answer.
    /// Hunk jumps keep the minimal behavior: consecutive hunks are usually
    /// already on screen, and re-topping for each would make `n` lurch.
    fn reveal_at_top(&mut self, viewport: usize) {
        let max_offset = self.rows.len().saturating_sub(viewport);
        self.offset = self.cursor.min(max_offset);
    }

    fn jump(&mut self, stops: &[usize], forward: bool) {
        if let Some(next) = next_stop(stops, self.cursor, forward) {
            self.cursor = next;
        } else if !forward {
            // Going back from inside the first file lands on its header
            // rather than refusing to move.
            if let Some(&first) = stops.first()
                && first < self.cursor
            {
                self.cursor = first;
            }
        }
    }

    fn toggle_collapse(&mut self) {
        let Some(path) = self.current_file().map(|i| self.files[i].path.clone()) else {
            return;
        };
        if !self.collapsed.remove(&path) {
            self.collapsed.insert(path.clone());
        }
        self.rebuild();
        // Collapsing pulls the body out from under the cursor; put it on the
        // header of the file that was just folded, which is where the eye is.
        if let Some(row) = self.row_of_path(&path) {
            self.cursor = row;
        }
    }
}

/// `Rect::contains` wants a `Position`; this is the same test against the two
/// numbers a mouse event actually carries.
fn contains(area: Rect, col: u16, row: u16) -> bool {
    col >= area.x && col < area.right() && row >= area.y && row < area.bottom()
}

/// Keys to actions. `pending_g` carries the half-typed `gg`; it is returned
/// rather than stored so this stays a function of its inputs.
pub fn action_for(key: KeyEvent, pending_g: bool) -> (Action, bool) {
    // Windows terminals report press *and* release; acting on both makes
    // every key move twice.
    if key.kind == KeyEventKind::Release {
        return (Action::None, pending_g);
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

    if pending_g {
        // Any key other than the second `g` abandons the prefix rather than
        // swallowing itself, so a mistyped `g` costs nothing.
        if let KeyCode::Char('g') = key.code {
            return (Action::Top, false);
        }
        return resolve(key, ctrl);
    }
    if let KeyCode::Char('g') = key.code
        && !ctrl
    {
        return (Action::None, true);
    }
    resolve(key, ctrl)
}

fn resolve(key: KeyEvent, ctrl: bool) -> (Action, bool) {
    let action = match (key.code, ctrl) {
        (KeyCode::Char('q'), false) | (KeyCode::Esc, _) => Action::Quit,
        (KeyCode::Char('c'), true) => Action::Quit,
        (KeyCode::Char('z'), true) => Action::Suspend,
        (KeyCode::Char('d'), true) => Action::HalfPageDown,
        (KeyCode::Char('u'), true) => Action::HalfPageUp,
        (KeyCode::Char('j'), false) | (KeyCode::Down, false) => Action::Down(1),
        (KeyCode::Char('k'), false) | (KeyCode::Up, false) => Action::Up(1),
        (KeyCode::PageDown, _) | (KeyCode::Char(' '), false) => Action::HalfPageDown,
        (KeyCode::PageUp, _) | (KeyCode::Char('b'), false) => Action::HalfPageUp,
        (KeyCode::Char('G'), false) | (KeyCode::End, _) => Action::Bottom,
        (KeyCode::Home, _) => Action::Top,
        (KeyCode::Char(']'), false) => Action::NextFile,
        (KeyCode::Char('['), false) => Action::PrevFile,
        (KeyCode::Char('n'), false) => Action::NextHunk,
        (KeyCode::Char('p'), false) => Action::PrevHunk,
        (KeyCode::Char('h'), false) | (KeyCode::Left, false) => Action::ScrollLeft(4),
        (KeyCode::Char('l'), false) | (KeyCode::Right, false) => Action::ScrollRight(4),
        (KeyCode::Char('0'), false) => Action::ResetHScroll,
        (KeyCode::Tab, _) => Action::ToggleFocus,
        (KeyCode::Char('z'), false) | (KeyCode::Enter, _) => Action::ToggleCollapse,
        (KeyCode::Char('r'), false) => Action::Refetch,
        (KeyCode::Char('f'), false) => Action::ToggleFiles,
        (KeyCode::Char('m'), false) => Action::ToggleMouse,
        (KeyCode::Char('?'), false) => Action::ToggleHelp,
        _ => Action::None,
    };
    (action, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rows::Row;

    const PATCH: &str = "diff --git a/a.rs b/a.rs\n\
                         @@ -1,2 +1,2 @@\n\
                         -x\n\
                         +y\n\
                         \x20z\n\
                         diff --git a/b.rs b/b.rs\n\
                         @@ -5 +5 @@\n\
                         -p\n\
                         +q\n\
                         @@ -20 +20 @@\n\
                         -m\n\
                         +n";

    fn payload(patch: &str) -> DiffPayload {
        DiffPayload {
            patch: patch.to_string(),
            repo_name: "krit".into(),
            branch: "main".into(),
            custom_mode: false,
            untracked_files: Vec::new(),
        }
    }

    fn app() -> App {
        let mut app = App::default();
        app.load(&payload(PATCH));
        app
    }

    fn key(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    #[test]
    fn loading_a_diff_builds_rows_and_labels() {
        let app = app();
        assert_eq!(app.files.len(), 2);
        assert_eq!(app.repo, "krit");
        assert_eq!(app.branch, "main");
        assert_eq!(app.rows[0], Row::File { file: 0 });
    }

    #[test]
    fn the_cursor_stops_at_both_ends_rather_than_wrapping() {
        let mut app = app();
        app.apply(Action::Up(1), 10);
        assert_eq!(app.cursor, 0, "up from the top stays");
        app.apply(Action::Bottom, 10);
        let last = app.rows.len() - 1;
        app.apply(Action::Down(1), 10);
        assert_eq!(app.cursor, last, "down from the bottom stays");
    }

    #[test]
    fn hunk_and_file_jumps_use_different_stops() {
        let mut app = app();
        // a.rs has one hunk, b.rs has two — and the jump crosses the file
        // boundary without needing to know about files at all.
        assert_eq!(hunk_rows(&app.rows).len(), 3);
        app.apply(Action::NextHunk, 10);
        assert_eq!(app.rows[app.cursor], Row::Hunk { file: 0, hunk: 0 });
        app.apply(Action::NextHunk, 10);
        assert_eq!(app.rows[app.cursor], Row::Hunk { file: 1, hunk: 0 });
        app.apply(Action::NextHunk, 10);
        assert_eq!(app.rows[app.cursor], Row::Hunk { file: 1, hunk: 1 });
        app.apply(Action::NextHunk, 10);
        assert_eq!(
            app.rows[app.cursor],
            Row::Hunk { file: 1, hunk: 1 },
            "no wrap past the last hunk"
        );

        app.apply(Action::Top, 10);
        app.apply(Action::NextFile, 10);
        assert_eq!(app.rows[app.cursor], Row::File { file: 1 });
    }

    #[test]
    fn going_back_from_inside_the_first_file_lands_on_its_header() {
        let mut app = app();
        app.apply(Action::Down(3), 10);
        app.apply(Action::PrevFile, 10);
        assert_eq!(app.rows[app.cursor], Row::File { file: 0 });
        // And from the header itself there is nowhere further back.
        app.apply(Action::PrevFile, 10);
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn the_file_highlight_does_not_blink_off_over_the_gap_between_files() {
        let mut app = app();
        let gap = app
            .rows
            .iter()
            .position(|r| matches!(r, Row::Gap))
            .expect("two files means a gap");
        app.cursor = gap;
        assert_eq!(
            app.current_file(),
            Some(0),
            "the gap keeps the file above it lit"
        );
    }

    #[test]
    fn a_refetch_keeps_the_reader_in_the_file_they_were_reading() {
        // This is the case that matters: every save triggers a refetch, and
        // resetting to the top would fight the reviewer editing the file.
        let mut app = app();
        app.apply(Action::NextFile, 10);
        assert_eq!(app.cursor_path().as_deref(), Some("b.rs"));

        // A new hunk appears in the *first* file, shifting every row below it.
        let grown = "diff --git a/a.rs b/a.rs\n\
                     @@ -1,2 +1,2 @@\n\
                     -x\n\
                     +y\n\
                     \x20z\n\
                     @@ -40 +40 @@\n\
                     -e\n\
                     +f\n\
                     diff --git a/b.rs b/b.rs\n\
                     @@ -5 +5 @@\n\
                     -p\n\
                     +q";
        app.load(&payload(grown));
        assert_eq!(
            app.cursor_path().as_deref(),
            Some("b.rs"),
            "the anchor is the file, not the row index"
        );
    }

    #[test]
    fn a_refetch_that_drops_the_current_file_clamps_instead_of_panicking() {
        let mut app = app();
        app.apply(Action::Bottom, 10);
        app.load(&payload("diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-x\n+y"));
        assert!(app.cursor < app.rows.len());
    }

    #[test]
    fn an_empty_diff_is_navigable_without_panicking() {
        let mut app = App::default();
        app.load(&payload(""));
        assert!(app.rows.is_empty());
        for action in [
            Action::Down(1),
            Action::Bottom,
            Action::NextHunk,
            Action::ToggleCollapse,
        ] {
            app.apply(action, 10);
        }
        assert_eq!(app.cursor, 0);
        assert_eq!(app.current_file(), None);
    }

    #[test]
    fn collapsing_hides_the_body_and_leaves_the_cursor_on_the_header() {
        let mut app = app();
        app.apply(Action::Down(2), 10); // into a.rs's body
        app.apply(Action::ToggleCollapse, 10);
        assert_eq!(app.rows[app.cursor], Row::File { file: 0 });
        assert!(
            !app.rows
                .iter()
                .any(|r| matches!(r, Row::Code { file: 0, .. }))
        );
        // And back.
        app.apply(Action::ToggleCollapse, 10);
        assert!(
            app.rows
                .iter()
                .any(|r| matches!(r, Row::Code { file: 0, .. }))
        );
    }

    #[test]
    fn collapsed_state_survives_a_refetch() {
        // It is keyed by path, not by index, so a file appearing above it
        // must not silently unfold it.
        let mut app = app();
        app.apply(Action::NextFile, 10);
        app.apply(Action::ToggleCollapse, 10);
        assert!(app.collapsed.contains("b.rs"));
        app.load(&payload(PATCH));
        assert!(app.collapsed.contains("b.rs"));
        assert!(
            !app.rows
                .iter()
                .any(|r| matches!(r, Row::Code { file: 1, .. }))
        );
    }

    #[test]
    fn gg_goes_to_the_top_and_a_stray_g_does_not_eat_the_next_key() {
        let (action, pending) = action_for(key('g'), false);
        assert_eq!(action, Action::None);
        assert!(pending);
        assert_eq!(action_for(key('g'), true).0, Action::Top);
        // `g` then `j` is a plain `j`, not a swallowed keystroke.
        let (action, pending) = action_for(key('j'), true);
        assert_eq!(action, Action::Down(1));
        assert!(!pending);
    }

    #[test]
    fn a_key_release_does_nothing_so_movement_is_not_doubled() {
        let mut released = key('j');
        released.kind = KeyEventKind::Release;
        assert_eq!(action_for(released, false).0, Action::None);
    }

    #[test]
    fn ctrl_z_is_a_key_here_not_a_signal() {
        // Raw mode turns off ISIG, so Ctrl+Z never becomes SIGTSTP on its own.
        assert_eq!(action_for(ctrl('z'), false).0, Action::Suspend);
        assert_eq!(action_for(key('z'), false).0, Action::ToggleCollapse);
    }

    #[test]
    fn half_page_movement_scales_with_the_viewport() {
        let mut app = app();
        app.apply(Action::HalfPageDown, 20);
        assert_eq!(app.cursor, 10);
        app.apply(Action::HalfPageUp, 20);
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn horizontal_scroll_never_goes_negative() {
        let mut app = app();
        app.apply(Action::ScrollLeft(4), 10);
        assert_eq!(app.h_scroll, 0);
        app.apply(Action::ScrollRight(4), 10);
        app.apply(Action::ScrollRight(4), 10);
        assert_eq!(app.h_scroll, 8);
        app.apply(Action::ResetHScroll, 10);
        assert_eq!(app.h_scroll, 0);
    }

    #[test]
    fn the_view_follows_the_cursor_as_actions_apply() {
        let mut app = app();
        app.apply(Action::Bottom, 5);
        assert_eq!(app.offset, app.rows.len().saturating_sub(5));
        app.apply(Action::Top, 5);
        assert_eq!(app.offset, 0);
    }

    // ---- hiding the file list ------------------------------------------

    #[test]
    fn hiding_the_file_list_takes_focus_with_it() {
        // Focus on a pane that is not drawn is focus nothing can move or
        // show, and tab would appear to do nothing.
        let mut app = app();
        app.apply(Action::ToggleFocus, 10);
        assert_eq!(app.focus, Focus::Files);
        app.apply(Action::ToggleFiles, 10);
        assert!(!app.show_files);
        assert_eq!(app.focus, Focus::Diff);
        app.apply(Action::ToggleFiles, 10);
        assert!(app.show_files);
    }

    #[test]
    fn f_hides_the_files_and_m_releases_the_mouse() {
        assert_eq!(action_for(key('f'), false).0, Action::ToggleFiles);
        assert_eq!(action_for(key('m'), false).0, Action::ToggleMouse);
    }

    // ---- mouse ---------------------------------------------------------

    fn with_panes(app: &mut App) {
        // A plausible frame: header on row 0, footer on the last row, file
        // list 34 wide on the left.
        app.panes = Panes {
            diff: Rect::new(34, 1, 66, 20),
            diff_top_row: 0,
            files: Some(Rect::new(1, 2, 32, 18)),
            files_top: 0,
        };
    }

    fn mouse(kind: MouseEventKind, col: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column: col,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn click(col: u16, row: u16) -> MouseEvent {
        mouse(MouseEventKind::Down(MouseButton::Left), col, row)
    }

    #[test]
    fn the_wheel_moves_the_view_and_leaves_the_cursor_behind() {
        // Reading ahead without losing your place is the whole point of a
        // wheel; a wheel that dragged the cursor would be a slow `j`.
        let mut app = app();
        with_panes(&mut app);
        let before = app.cursor;
        app.apply(
            app.mouse_action(mouse(MouseEventKind::ScrollDown, 40, 5)),
            5,
        );
        assert_eq!(app.offset, 3);
        assert_eq!(app.cursor, before, "the cursor stayed put");

        // And the next movement key snaps the view back to the cursor.
        app.apply(Action::Down(1), 5);
        assert!(app.offset <= app.cursor);
    }

    #[test]
    fn the_view_does_not_scroll_past_either_end() {
        let mut app = app();
        with_panes(&mut app);
        app.apply(Action::ScrollViewUp(3), 5);
        assert_eq!(app.offset, 0);
        for _ in 0..50 {
            app.apply(Action::ScrollViewDown(3), 5);
        }
        assert_eq!(app.offset, app.rows.len().saturating_sub(5));
    }

    #[test]
    fn a_click_in_the_diff_lands_on_the_row_that_was_drawn_there() {
        let mut app = app();
        with_panes(&mut app);
        // Row 1 of the pane, with the view scrolled to 4, is row 5.
        app.panes.diff_top_row = 4;
        app.apply(app.mouse_action(click(50, 5)), 20);
        assert_eq!(app.cursor, 8);
        assert_eq!(app.focus, Focus::Diff);
    }

    #[test]
    fn a_click_past_the_last_row_does_nothing() {
        // The pane is taller than a short diff; the empty part is not row -1.
        let mut app = app();
        with_panes(&mut app);
        let before = app.cursor;
        assert_eq!(app.mouse_action(click(50, 19)), Action::None);
        app.apply(app.mouse_action(click(50, 19)), 20);
        assert_eq!(app.cursor, before);
    }

    #[test]
    fn going_to_a_file_puts_it_at_the_top_not_at_the_bottom() {
        // Minimal scrolling would land the header on the last visible row, so
        // arriving at a file would mean looking at the end of the one before
        // it. Found by clicking one in a real terminal and reading the
        // previous file.
        let mut app = app();
        let viewport = 4;
        app.apply(Action::NextFile, viewport);
        assert_eq!(app.rows[app.cursor], Row::File { file: 1 });
        assert_eq!(
            app.offset, app.cursor,
            "the file being opened is the first row on screen"
        );

        // Same for a click in the list.
        app.apply(Action::Top, viewport);
        with_panes(&mut app);
        app.apply(app.mouse_action(click(10, 3)), viewport);
        assert_eq!(app.offset, app.cursor);
        assert_eq!(app.cursor_path().as_deref(), Some("b.rs"));
    }

    #[test]
    fn walking_by_line_still_scrolls_as_little_as_possible() {
        // The counterpart to the above: a cursor moving one row at a time
        // must not re-top the view, or reading is a slideshow.
        let mut app = app();
        app.apply(Action::Bottom, 4);
        let settled = app.offset;
        app.apply(Action::Up(1), 4);
        assert_eq!(app.offset, settled, "still visible, so nothing moved");
    }

    #[test]
    fn a_click_in_the_file_list_jumps_to_that_file() {
        let mut app = app();
        with_panes(&mut app);
        app.apply(app.mouse_action(click(10, 3)), 20);
        assert_eq!(app.cursor_path().as_deref(), Some("b.rs"));
        assert_eq!(app.focus, Focus::Files);
        // And below the list, nothing.
        assert_eq!(app.mouse_action(click(10, 15)), Action::None);
    }

    #[test]
    fn a_scrolled_file_list_still_hits_the_right_file() {
        // The list follows the cursor, so its first drawn row is not always
        // file 0 — hit-testing has to use what the frame actually drew.
        let mut app = app();
        with_panes(&mut app);
        app.panes.files_top = 1;
        app.apply(app.mouse_action(click(10, 2)), 20);
        assert_eq!(app.cursor_path().as_deref(), Some("b.rs"));
    }

    #[test]
    fn a_click_between_the_panes_belongs_to_neither() {
        let mut app = app();
        with_panes(&mut app);
        // Column 33 is the file pane's border, outside both inner rects.
        assert_eq!(app.mouse_action(click(33, 5)), Action::None);
        // The header row is above both.
        assert_eq!(app.mouse_action(click(50, 0)), Action::None);
    }

    #[test]
    fn a_hidden_file_list_cannot_be_clicked() {
        let mut app = app();
        with_panes(&mut app);
        app.panes.files = None;
        assert_eq!(app.mouse_action(click(10, 3)), Action::None);
    }

    #[test]
    fn releasing_the_mouse_makes_every_mouse_event_a_no_op() {
        // Capture is off at the terminal too, but a stray event queued before
        // the toggle must not still move the cursor.
        let mut app = app();
        with_panes(&mut app);
        app.apply(Action::ToggleMouse, 20);
        assert!(!app.mouse);
        assert_eq!(app.mouse_action(click(50, 5)), Action::None);
        assert_eq!(
            app.mouse_action(mouse(MouseEventKind::ScrollDown, 50, 5)),
            Action::None
        );
    }

    #[test]
    fn a_drag_does_not_pull_the_cursor_along_with_it() {
        let mut app = app();
        with_panes(&mut app);
        assert_eq!(
            app.mouse_action(mouse(MouseEventKind::Drag(MouseButton::Left), 50, 8)),
            Action::None
        );
        assert_eq!(
            app.mouse_action(mouse(MouseEventKind::Moved, 50, 8)),
            Action::None
        );
        assert_eq!(
            app.mouse_action(mouse(MouseEventKind::Up(MouseButton::Left), 50, 8)),
            Action::None
        );
    }
}
