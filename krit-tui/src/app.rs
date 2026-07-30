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
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    Files,
    Diff,
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
    pub tab_size: usize,
    pub should_quit: bool,
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
            tab_size: 4,
            should_quit: false,
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
        match action {
            Action::None => {}
            Action::Quit => self.should_quit = true,
            Action::Down(n) => self.cursor = (self.cursor + n).min(last),
            Action::Up(n) => self.cursor = self.cursor.saturating_sub(n),
            Action::HalfPageDown => self.cursor = (self.cursor + viewport / 2).min(last),
            Action::HalfPageUp => self.cursor = self.cursor.saturating_sub(viewport / 2),
            Action::Top => self.cursor = 0,
            Action::Bottom => self.cursor = last,
            Action::NextFile => self.jump(&file_rows(&self.rows), true),
            Action::PrevFile => self.jump(&file_rows(&self.rows), false),
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
            // Handled by the caller, which owns the socket and the terminal.
            Action::Refetch | Action::Suspend => {}
        }
        self.offset = scroll_to_show(self.offset, viewport, self.cursor, self.rows.len());
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
}
