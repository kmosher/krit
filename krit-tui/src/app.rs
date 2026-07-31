//! Viewer state, and every transition it can make.
//!
//! Keys map to an `Action` and actions apply to an `App`; neither step
//! touches a terminal. That is the same split the web UI keeps for the same
//! reason — the interesting behavior (where the cursor lands, what the view
//! scrolls to, what survives a refetch) is testable without a screen, and
//! what's left in `ui.rs` is drawing.

use crate::client::DiffPayload;
use crate::comments::{CommentAnchor, CommentRows, layout};
use crate::compose::Composer;
use crate::patch::{FileDiff, parse_patch};
use crate::rows::{
    GapRange, MARKER_COLS, Opened, Row, build_rows, comment_rows, file_rows, gaps_of, gutter_width,
    hunk_rows, next_stop, scroll_to_show, split_half_width, split_side_prefix,
};
use crate::text::{cluster_at_column, display_width, expand_tabs};
use krit_core::types::ReviewComment;
use ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;
use std::collections::{HashMap, HashSet};

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
    /// The rows the diff occupies.
    pub diff: Rect,
    /// The row index drawn on the diff pane's first line — what turns a click
    /// at a screen row back into a row of the model.
    pub diff_top_row: usize,
    /// `None` when the file list is not drawn — because the `f` toggle hid it,
    /// or because the terminal is too narrow for it. `App` knows only about
    /// the first of those, which is why focus is reconciled against this
    /// rather than against `show_files`.
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
    /// Back out of the innermost thing that is up: the help overlay, then a
    /// selection. Never quits — see the note on the `Esc` binding.
    Escape,
    /// Start line-wise selection at the cursor, or end it.
    ToggleVisual,
    /// Begin, extend and finish a character-level selection. From a drag: a
    /// terminal reports the cell under the pointer, so the column comes free.
    SelectStart {
        row: usize,
        column: usize,
        /// Which code column of a split row the press landed in; `None` in
        /// unified view.
        side: Option<bool>,
    },
    SelectExtend {
        row: usize,
        column: usize,
    },
    SelectEnd {
        row: usize,
        column: usize,
    },
    Suspend,
    ToggleFiles,
    /// Release the mouse back to the terminal (or take it again).
    ToggleMouse,
    /// Open the composer on the selection, or on the cursor's own line.
    Comment,
    /// Open the composer on the comment under the cursor.
    Reply,
    /// Resolve the comment under the cursor, or reopen it.
    ToggleResolved,
    /// Post every queued comment.
    PostQueued,
    /// Done reviewing: opens the composer for concluding notes.
    Submit,
    /// Move to the next comment in the review, or the previous one.
    NextComment,
    PrevComment,
    /// Move the *view* without moving the cursor — what a wheel does. Every
    /// other movement drags the view along behind the cursor; this one is the
    /// exception, and keeping it a separate action is what stops the next
    /// `scroll_to_show` from immediately undoing it.
    ScrollViewDown(usize),
    ScrollViewUp(usize),
    /// The same, for the file list. A separate action because the two panes
    /// scroll independently — the wheel belongs to whichever one the pointer
    /// is over, which is the only thing that says which the reviewer meant.
    ScrollFilesDown(usize),
    ScrollFilesUp(usize),
    /// Side-by-side, or unified. A preference: on a pane too narrow to carry
    /// two code columns it is remembered and not obeyed.
    ToggleSplit,
    /// Open or fold the unchanged run under the cursor by a few lines. Does
    /// nothing anywhere else, which is why the keys are announced on the row
    /// itself rather than in the footer — they are only live where they mean
    /// something. All-at-once is `z`, the same key that folds a file.
    Expand(Step),
    /// Put the cursor on a file's header. From a click in the file list; a
    /// click in the diff arrives as `SelectStart`, which moves the cursor as
    /// part of starting the gesture.
    FocusFile(usize),
}

/// Narrowest diff pane that still makes two code columns worth having.
///
/// Each side spends `gutter + 3` on its own numbers and marker, and the two are
/// separated by a divider — so at a typical gutter of 3 this leaves about 38
/// columns of code per side. Below it the fallback is unified, which is a
/// readable diff at any width; a split view that fits four words per line is
/// not.
pub const SPLIT_MIN_COLS: usize = 90;

/// Lines opened per `+`, from each edge — so a press yields twice this many.
/// Enough to see what a hunk's own three lines of context cut off, small enough
/// that walking into a long gap takes deliberate presses rather than one.
pub const EXPAND_STEP: u32 = 5;

/// How far to open, or close, the gap under the cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// A few lines in from each edge — the common case, reading around a hunk.
    More(u32),
    /// Give a few lines back from each edge.
    Less(u32),
    /// The whole gap. Anchored at the top rather than split between the edges,
    /// because once it is all open there is no middle left to keep.
    All,
    /// Fold it all back up. Named for the *state* it leaves the gap in, not for
    /// a step of zero — `Action::None` in this same module means do nothing,
    /// and a reader who takes this for the same thing deletes the only way to
    /// close a gap in one keystroke.
    Closed,
}

/// What the reviewer has marked, and what a comment posted from it would be
/// anchored to.
///
/// Two ends and no ordering: `anchor` is where it started and `head` is where
/// it is now, so dragging back past the start reverses without the range ever
/// being empty. Ordering is imposed by the two accessors rather than by the
/// field — `rows()` for the row pair, `columns_in_order()` for the columns —
/// and they are separate because rows and columns do not order together: a
/// backwards drag within one line reverses only the columns. The case neither
/// can settle is a multi-row drag that collapses onto a single anchored line,
/// which is `narrow`'s to fix and is documented there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub anchor: usize,
    pub head: usize,
    /// Display columns at the two ends. `None` is line-wise, which is what
    /// `v` produces: a keyboard has no caret to put in the middle of a line,
    /// and a line-level comment is a shape the wire and the browser already
    /// have. A mouse hands us `(row, column)` for free, which is the one thing
    /// a terminal makes easier than a browser — `selectionMapping.ts` is 400
    /// lines of hit-testing to recover what arrives here in the event.
    pub columns: Option<(usize, usize)>,
    /// Keyboard visual mode: movement extends the selection rather than
    /// leaving it behind.
    pub visual: bool,
    /// Which code column of a split row the drag happened in — `true` for the
    /// new side. `None` in unified view, and for `v`, where the row itself is
    /// the side.
    ///
    /// Carried rather than derived, because in split view a row holds both
    /// sides at once: deriving would read a drag over a deleted line as a
    /// comment on its replacement, which is a comment on text the reviewer
    /// never pointed at and no error anywhere.
    pub side: Option<bool>,
}

impl Selection {
    /// First and last row, in order.
    pub fn rows(&self) -> (usize, usize) {
        (self.anchor.min(self.head), self.anchor.max(self.head))
    }

    pub fn contains(&self, row: usize) -> bool {
        let (first, last) = self.rows();
        (first..=last).contains(&row)
    }

    /// Start and end display column, in the order the rows are in — so a drag
    /// that went right-to-left within one line still reads left-to-right.
    fn columns_in_order(&self) -> Option<(usize, usize)> {
        let (a, h) = self.columns?;
        if self.head < self.anchor || (self.head == self.anchor && h < a) {
            Some((h, a))
        } else {
            Some((a, h))
        }
    }
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
    /// Every comment on the review, queued ones included, exactly as the
    /// server holds them. Never edited in place: a write goes to the server
    /// and the list is refetched, so what is on screen is what an agent would
    /// read. Optimistic local edits would be two sources of truth for a value
    /// the whole point of which is that both sides agree.
    pub comments: Vec<ReviewComment>,
    /// Those comments laid out at `wrap_width`, and indexed by where they
    /// attach. Rebuilt with `rows`, since the rows are built from it.
    pub comment_rows: CommentRows,
    /// The width comment bodies were wrapped to — the diff pane's, as the last
    /// frame drew it.
    pub wrap_width: usize,
    pub collapsed: HashSet<String>,
    pub cursor: usize,
    /// What the reviewer has marked, if anything. A comment is posted against
    /// this when it is set and against the cursor's own line when it is not,
    /// so there is one anchor path rather than two.
    pub selection: Option<Selection>,
    pub offset: usize,
    pub h_scroll: usize,
    pub focus: Focus,
    pub repo: String,
    pub branch: String,
    pub custom_mode: bool,
    pub status: Status,
    /// The open form, if there is one. Not a modal: the diff is still drawn,
    /// still scrolls under it, and the loop never stops reading.
    pub compose: Option<Composer>,
    pub show_help: bool,
    pub show_files: bool,
    /// Whether the reviewer wants side-by-side. What they get is `split()`,
    /// which also has to fit.
    pub split_pref: bool,
    /// Whether we are holding the mouse. On, the wheel scrolls and a click
    /// moves the cursor; off, the terminal gets its own selection back so the
    /// reviewer can copy a line the ordinary way.
    pub mouse: bool,
    pub tab_size: usize,
    /// How many subscribers could receive a `submitted` — the `state` event's
    /// `watcherCount` **and** `agentCount` added together. Deliberately not
    /// named `watchers`: that is a narrower field on the same frame (the
    /// `role=cli` count alone), and a reader grepping for it in the server or
    /// the browser would conclude agents are not counted. Done reviewing means
    /// nothing with nobody listening; the browser greys its button out on the
    /// same predicate, spelled `watcherCount > 0 || agentCount > 0`.
    pub listeners: usize,
    pub should_quit: bool,
    /// First file drawn in the list. Owned rather than derived from the cursor,
    /// for the same reason the diff's `offset` is: a position recomputed from
    /// the cursor every frame cannot be moved by a wheel, because the next
    /// frame puts it back. The list follows the cursor when the cursor changes
    /// file, and otherwise stays where it was put.
    pub files_offset: usize,
    /// The new side of every file, by path, so the space between hunks can be
    /// opened without another request. Bundled in every `/api/diff` response.
    pub file_text: HashMap<String, Vec<String>>,
    /// Why a file's new side carries no text, when it doesn't — reported on the
    /// row that would otherwise offer to expand, since a gap that refuses to
    /// open looks identical to one that is broken.
    pub file_text_refusal: HashMap<String, &'static str>,
    /// The unchanged runs between hunks, by path. Derived in `load` rather than
    /// per frame: it walks every hunk of every file.
    pub gaps: HashMap<String, Vec<GapRange>>,
    /// How much of each gap is open, keyed by path and gap index so it survives
    /// a refetch the way `collapsed` does.
    pub expanded: HashMap<(String, usize), Opened>,
    pub panes: Panes,
    /// Height of the last diff pane that was actually drawn — the basis
    /// `set_panes` compares against to decide whether the viewport resized.
    /// Not `panes.diff.height`, which the help overlay zeroes so that clicks
    /// cannot reach through it; taking that at face value would make closing
    /// the overlay look like a resize and jerk the view back to the cursor.
    pub reconciled_height: u16,
    /// Aggregates over the whole review, recomputed in `rebuild` rather than
    /// per frame. The draw loop runs ten times a second and each of these
    /// walks every line of every hunk.
    pub gutter: usize,
    pub totals: (usize, usize),
    /// Widest expanded line, which is how far sideways there is anything to
    /// see. Without it `h_scroll` runs off into blank space with no way back
    /// but a key the footer never mentions.
    pub widest_line: usize,
}

impl Default for App {
    fn default() -> Self {
        Self {
            files: Vec::new(),
            rows: Vec::new(),
            comments: Vec::new(),
            comment_rows: CommentRows::default(),
            // A plausible pane, so the first layout — built before any frame
            // has reported a width — is not wrapped to nothing.
            wrap_width: 80,
            collapsed: HashSet::new(),
            cursor: 0,
            selection: None,
            offset: 0,
            h_scroll: 0,
            focus: Focus::Diff,
            repo: String::new(),
            branch: String::new(),
            custom_mode: false,
            status: Status::Idle,
            compose: None,
            show_help: false,
            show_files: true,
            split_pref: true,
            mouse: true,
            tab_size: 4,
            listeners: 0,
            should_quit: false,
            files_offset: 0,
            file_text: HashMap::new(),
            file_text_refusal: HashMap::new(),
            gaps: HashMap::new(),
            expanded: HashMap::new(),
            panes: Panes::default(),
            reconciled_height: 0,
            gutter: 2,
            totals: (0, 0),
            widest_line: 0,
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
    pub fn load(&mut self, payload: &DiffPayload, viewport: usize) {
        let anchor = self.cursor_path();
        self.repo = payload.repo_name.clone();
        self.branch = payload.branch.clone();
        self.custom_mode = payload.custom_mode;
        self.files = parse_patch(&payload.patch, &payload.untracked_files);
        self.take_file_text(payload);
        self.rebuild();
        self.cursor = match anchor.and_then(|p| self.row_of_path(&p)) {
            Some(row) => row,
            None => self.cursor.min(self.rows.len().saturating_sub(1)),
        };
        // `offset` needs clamping as much as `cursor` does, and nothing else
        // on this path does it: a refetch that shrinks the diff would
        // otherwise leave the view scrolled past the end, and `row_window`
        // answers that with an empty range — a blank pane, a valid cursor, and
        // nothing on screen to say what happened.
        self.offset = scroll_to_show(self.offset, viewport, self.cursor, self.rows.len());
        // A selection is row indices, and this path is the diff itself changing
        // — an agent's edit can rewrite the marked text or move it to another
        // hunk entirely. There is no re-anchoring to do: the marked range is a
        // claim about lines that may no longer say what the reviewer read, and
        // keeping it means `c` posts a character anchor into text nobody chose.
        self.selection = None;
    }

    /// Replace the comment list, keeping the cursor on whatever it was on.
    ///
    /// A comment arriving mid-session inserts rows, and every row below it
    /// shifts. Anchoring on the row's *identity* rather than its index is what
    /// stops a reply landing in another pane from walking the reviewer's
    /// cursor down the file.
    pub fn set_comments(&mut self, comments: Vec<ReviewComment>, viewport: usize) {
        let at = self.rows.get(self.cursor).copied();
        // The marked range shifts for exactly the same reason the cursor does,
        // and it is the more expensive one to get wrong: the cursor merely
        // looks wrong, while a stale selection is what `c` posts against. The
        // diff has not changed here, so a `Row::Code` still means the same line
        // of the same file and both ends can be re-found by identity.
        let marked = self
            .selection
            .and_then(|sel| Some((sel, *self.rows.get(sel.anchor)?, *self.rows.get(sel.head)?)));
        self.comments = comments;
        self.rebuild();
        if let Some(row) = at.and_then(|r| self.rows.iter().position(|x| *x == r)) {
            self.cursor = row;
        }
        self.selection = marked.and_then(|(sel, anchor, head)| {
            Some(Selection {
                anchor: self.rows.iter().position(|r| *r == anchor)?,
                head: self.rows.iter().position(|r| *r == head)?,
                ..sel
            })
        });
        self.offset = scroll_to_show(self.offset, viewport, self.cursor, self.rows.len());
    }

    /// Take the whole-file text the diff came with, and work out where the
    /// gaps between hunks are.
    ///
    /// Done on load rather than per frame because it walks every hunk of every
    /// file. The expansion state is *not* cleared: a refetch happens on every
    /// save, and a reviewer who opened a gap to read around a change should not
    /// have it fold up under them each time the agent writes. It is keyed by
    /// path and gap index, so the worst an edit can do is move which lines a
    /// still-open gap shows — and the row model rebuilds from the new gaps
    /// either way, so an expansion wider than a gap that shrank is clamped
    /// rather than left dangling.
    fn take_file_text(&mut self, payload: &DiffPayload) {
        self.file_text.clear();
        self.file_text_refusal.clear();
        self.gaps.clear();
        for file in &self.files {
            let Some(sides) = payload.file_contents.get(&file.path) else {
                continue;
            };
            // `refusal` answers for the shapes we know; anything else with no
            // text is treated the same way rather than falling through to the
            // `continue` below, which would drop the file's gap rows entirely —
            // a diff whose hidden context has silently vanished, indistinguish-
            // able from one that has none. The wire will grow more of these.
            let refused = sides
                .new
                .refusal()
                .or_else(|| sides.new.contents.is_none().then_some("text unavailable"));
            if let Some(why) = refused {
                self.file_text_refusal.insert(file.path.clone(), why);
                // Gaps are still worked out, and still drawn — the row is where
                // the reason gets said. Told nothing, the reviewer cannot tell a
                // file too large to expand from a key that does not work. Only
                // the interior gaps, though: the run after the last hunk is
                // bounded by the file's length, and that is what we don't have.
                self.gaps.insert(file.path.clone(), gaps_of(file, 0));
                continue;
            }
            let lines = sides.new.lines();
            if lines.is_empty() {
                continue;
            }
            // A trailing newline makes `split` yield one empty last element
            // that is not a line of the file. Counting it would offer to expand
            // a line that does not exist, and render it blank.
            let total = match lines.last() {
                Some(last) if last.is_empty() => lines.len() - 1,
                _ => lines.len(),
            };
            self.gaps
                .insert(file.path.clone(), gaps_of(file, total as u32));
            self.file_text.insert(file.path.clone(), lines);
        }
    }

    /// The text of one expanded line, and its old-side number.
    pub fn context_line(&self, file: usize, gap: usize, line: u32) -> Option<(&str, Option<u32>)> {
        let path = &self.files.get(file)?.path;
        let range = self.gaps.get(path)?.get(gap)?;
        // `checked_sub`, not `- 1`: a new-file line number is 1-based, and a
        // zero would underflow to `usize::MAX` — a blank row in release, a
        // panic in debug. `gaps_of` no longer emits one, and this is the second
        // lock on that door rather than a reason to trust the first.
        let text = self
            .file_text
            .get(path)?
            .get((line as usize).checked_sub(1)?)?;
        Some((text.as_str(), range.old_line(line)))
    }

    /// How many lines of a gap are still folded away, and why it might not
    /// open at all.
    pub fn gap_state(&self, file: usize, gap: usize) -> Option<(u32, Option<&'static str>)> {
        let path = &self.files.get(file)?.path;
        let range = self.gaps.get(path)?.get(gap)?;
        let (from_start, from_end) = self
            .expanded
            .get(&(path.clone(), gap))
            .copied()
            .unwrap_or((0, 0));
        let open = (from_start + from_end).min(range.len());
        Some((
            range.len() - open,
            self.file_text_refusal.get(path).copied(),
        ))
    }

    /// Open more of the gap the cursor is on, or fold it back.
    ///
    /// Both edges move together by design: a gap sits *between* two hunks, and
    /// the reviewer reading either one wants the lines nearest it. Stepping one
    /// edge at a time would need two more keys to say which, for a distinction
    /// nobody has yet asked to make.
    pub fn expand_gap(&mut self, by: Step) -> bool {
        let (file, gap) = match self.rows.get(self.cursor).copied() {
            Some(Row::Expand { file, gap }) | Some(Row::Context { file, gap, .. }) => (file, gap),
            _ => return false,
        };
        let Some(path) = self.files.get(file).map(|f| f.path.clone()) else {
            return false;
        };
        let Some(range) = self.gaps.get(&path).and_then(|g| g.get(gap)).copied() else {
            return false;
        };
        if !self.file_text.contains_key(&path) {
            return false;
        }
        let len = range.len();
        let entry = self.expanded.entry((path, gap)).or_insert((0, 0));
        let (from_start, from_end) = *entry;
        *entry = match by {
            Step::All => (len, 0),
            Step::Closed => (0, 0),
            Step::More(n) => (
                (from_start + n).min(len),
                (from_end + n).min(len.saturating_sub((from_start + n).min(len))),
            ),
            Step::Less(n) => (from_start.saturating_sub(n), from_end.saturating_sub(n)),
        };
        self.rebuild();
        true
    }

    pub fn rebuild(&mut self) {
        self.comment_rows = layout(&self.comments, &self.files, self.wrap_width);
        self.rows = build_rows(
            &self.files,
            &self.collapsed,
            &self.comment_rows,
            &self.gaps,
            &self.expanded,
            self.split(),
        );
        if self.cursor >= self.rows.len() {
            self.cursor = self.rows.len().saturating_sub(1);
        }
        // Both of these walk the whole review, so they are computed when the
        // review changes rather than when a frame is drawn.
        self.gutter = gutter_width(&self.files);
        self.totals = (
            self.files.iter().map(|f| f.additions).sum(),
            self.files.iter().map(|f| f.deletions).sum(),
        );
        self.widest_line = self
            .files
            .iter()
            .flat_map(|f| &f.hunks)
            .flat_map(|h| &h.lines)
            .map(|l| display_width(&expand_tabs(&l.text, self.tab_size)))
            .max()
            .unwrap_or(0);
    }

    /// Take the geometry the last frame reported, and reconcile anything that
    /// depends on what was actually drawn. Returns whether that reconciliation
    /// invalidated the frame it came from.
    ///
    /// Focus is the case that matters: the file pane can be missing because
    /// the reviewer hid it *or* because the terminal is too narrow, and only
    /// the frame knows which. Focus left on a pane nobody drew erases the
    /// cursor's reverse-video bar — the one indicator that survives NO_COLOR —
    /// with no message and no obvious way back.
    ///
    /// Comment bodies wrap to the diff pane's width, and a wrapped body is a
    /// number of *rows* — so a resize changes the row model, not just the
    /// picture. Rebuilding here rather than in the resize handler is what
    /// makes hiding the file list (which widens the pane without resizing the
    /// terminal) rewrap too.
    pub fn set_panes(&mut self, panes: Panes) -> bool {
        self.panes = panes;
        if panes.files.is_none() {
            self.focus = Focus::Diff;
        }
        // Opening the composer takes rows away from the diff, and the row the
        // reviewer is commenting on must not be one of them. Nothing else
        // re-runs this: `apply` scrolls for actions, and a pane shrinking is
        // not one.
        //
        // Only when the height *changed*, though, and never against a height of
        // zero. This runs after every frame, so pulling the view back to the
        // cursor unconditionally would undo `ScrollViewDown`/`ScrollViewUp` on
        // the very next frame and the view could never leave the cursor — which
        // is the one thing a wheel is for. And zero is the help overlay saying
        // it covered the diff, not a viewport with no room in it: reconciling
        // against that sends `scroll_to_show` to 0, so `?` would silently lose
        // the reviewer's place. Clamping is still every frame, because a
        // refetch can shrink the review under a view that is already past its
        // new end.
        let height = panes.diff.height as usize;
        let mut moved = false;
        if height > 0 {
            let clamped = self.offset.min(self.rows.len().saturating_sub(height));
            let scrolled = if panes.diff.height == self.reconciled_height {
                clamped
            } else {
                scroll_to_show(clamped, height, self.cursor, self.rows.len())
            };
            self.reconciled_height = panes.diff.height;
            moved = scrolled != self.offset;
            self.offset = scrolled;
        }

        let width = panes.diff.width as usize;
        if width > 0 && width != self.wrap_width {
            let was_split = self.split();
            self.wrap_width = width;
            // A width change can flip the *view*, not just the wrapping — the
            // file list is 34 fixed columns, so `f` alone crosses
            // `SPLIT_MIN_COLS` on an ordinary terminal. `ToggleSplit` drops the
            // selection for this exact reason and the implicit path has to as
            // well: its rows are indices into the other model, and its `side`
            // was measured in the other column frame, so `c` would anchor
            // against lines and characters the reviewer never marked. Only on
            // a flip, so an ordinary resize inside one view keeps it.
            if self.split() != was_split {
                self.selection = None;
            }
            self.rebuild();
            return true;
        }
        moved
    }

    /// The comment the cursor is inside, if it is inside one. What `R` and
    /// `X` act on.
    pub fn comment_under_cursor(&self) -> Option<&ReviewComment> {
        let index = self.rows.get(self.cursor)?.comment()?;
        self.comments.get(index)
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
        let before = self.cursor;
        let file_before = self.current_file();

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
            Action::ScrollFilesDown(n) => {
                let max = self.files.len().saturating_sub(self.files_viewport());
                self.files_offset = (self.files_offset + n).min(max);
                return;
            }
            Action::ScrollFilesUp(n) => {
                self.files_offset = self.files_offset.saturating_sub(n);
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
            // Clamped against the widest line there is, the same way vertical
            // movement is clamped against the row count. Scrolling into blank
            // space leaves a pane of bare gutters, and the way back (`0`) is
            // in the `?` overlay only.
            Action::ScrollRight(n) => {
                self.h_scroll = (self.h_scroll + n).min(self.widest_line.saturating_sub(1))
            }
            Action::ScrollLeft(n) => self.h_scroll = self.h_scroll.saturating_sub(n),
            Action::ResetHScroll => self.h_scroll = 0,
            Action::ToggleFocus => {
                self.focus = match self.focus {
                    // Refused when there is no list on screen to move to —
                    // otherwise Tab appears to do nothing while quietly
                    // hiding the cursor.
                    Focus::Diff if self.panes.files.is_some() => Focus::Files,
                    Focus::Diff => Focus::Diff,
                    Focus::Files => Focus::Diff,
                }
            }
            Action::ToggleCollapse => self.toggle_collapse(),
            Action::ToggleSplit => {
                self.split_pref = !self.split_pref;
                // The row model *is* the view here — a pair is one row and a
                // unified line is one row, so the same file is a different
                // number of rows in each. The cursor therefore has to be
                // re-found by what the row *says* rather than by what it is:
                // `set_comments` can compare `Row`s because the diff has not
                // changed under it, and a view toggle is precisely the case
                // where that does not hold — a `Row::Code` never equals a
                // `Row::Split`, so an identity lookup misses every code row and
                // leaves the raw index pointing at a different line.
                let at = self
                    .rows
                    .get(self.cursor)
                    .copied()
                    .and_then(|r| self.leading_line(r));
                self.rebuild();
                if let Some(target) = at
                    && let Some(row) = self
                        .rows
                        .iter()
                        .position(|r| self.leading_line(*r) == Some(target))
                {
                    self.cursor = row;
                }
                self.selection = None;
            }
            Action::Expand(step) => {
                self.expand_gap(step);
            }
            Action::ToggleHelp => self.show_help = !self.show_help,
            // One key, innermost first. The reviewer's model of Esc is "get me
            // out of whatever this is", and it must never reach "out of krit"
            // — see the binding for why.
            Action::Escape => {
                if self.show_help {
                    self.show_help = false;
                } else {
                    self.selection = None;
                }
            }
            Action::ToggleVisual => {
                self.selection = match self.selection {
                    Some(sel) if sel.visual => None,
                    // A mouse selection is replaced rather than adopted:
                    // extending someone else's character range with `j` would
                    // have to decide what the columns now mean.
                    _ => Some(Selection {
                        anchor: self.cursor,
                        head: self.cursor,
                        columns: None,
                        visual: true,
                        // Line-wise, so the row decides the side the way it
                        // does in unified view.
                        side: None,
                    }),
                }
            }
            Action::SelectStart { row, column, side } => {
                self.cursor = row.min(last);
                self.focus = Focus::Diff;
                self.selection = Some(Selection {
                    anchor: row,
                    head: row,
                    columns: Some((column, column)),
                    visual: false,
                    side,
                });
            }
            Action::SelectExtend { row, column } | Action::SelectEnd { row, column } => {
                if let Some(sel) = &mut self.selection {
                    sel.head = row.min(last);
                    if let Some((start, _)) = sel.columns {
                        sel.columns = Some((start, column));
                    }
                }
                // The cursor follows the pointer, so releasing leaves it at
                // the end of what was marked rather than back at the start.
                self.cursor = row.min(last);
            }
            Action::ToggleFiles => {
                self.show_files = !self.show_files;
                // Moving focus off a list we just hid. This is not the whole
                // invariant — the pane also disappears on a narrow terminal,
                // which `App` cannot see — so `set_panes` is what actually
                // enforces "focus follows what was drawn", every frame.
                if !self.show_files {
                    self.focus = Focus::Diff;
                }
            }
            Action::ToggleMouse => self.mouse = !self.mouse,
            Action::NextComment => self.jump(&comment_rows(&self.rows), true),
            Action::PrevComment => self.jump(&comment_rows(&self.rows), false),
            Action::FocusFile(index) => {
                if let Some(file) = self.files.get(index)
                    && let Some(row) = self.row_of_path(&file.path)
                {
                    self.cursor = row;
                    self.reveal_at_top(viewport);
                }
                self.focus = Focus::Files;
            }
            // Returned above.
            Action::ScrollViewDown(_)
            | Action::ScrollViewUp(_)
            | Action::ScrollFilesDown(_)
            | Action::ScrollFilesUp(_) => {}
            // Handled by the caller, which owns the socket and the terminal.
            // Everything that talks to the server is in that group: `App` is
            // the model, and a model that could post a comment would need to
            // know how to fail at it too.
            Action::Refetch
            | Action::Suspend
            | Action::Comment
            | Action::Reply
            | Action::ToggleResolved
            | Action::PostQueued
            | Action::Submit => {}
        }

        self.reconcile_selection(action, before);
        // The file list follows the cursor across a *file* boundary, not on
        // every movement: within one file there is nothing for it to do, and
        // doing it anyway would undo a wheel scroll on the next keystroke.
        if self.current_file() != file_before {
            self.files_offset = scroll_to_show(
                self.files_offset,
                self.files_viewport(),
                self.current_file().unwrap_or(0),
                self.files.len(),
            );
        }
        // Follow the cursor only when the cursor moved. `?`, `f` and `m` change
        // what is on screen without moving it, and dragging the view back for
        // them threw away a wheel scroll the instant the reviewer pressed
        // anything at all — the same "the view can never leave the cursor"
        // failure `set_panes` had, reached by the other road. The clamp still
        // runs either way: collapsing a file removes rows from under a view
        // that may already be at the end.
        self.offset = if self.cursor != before {
            scroll_to_show(self.offset, viewport, self.cursor, self.rows.len())
        } else {
            self.offset.min(max_offset)
        };
    }

    /// Bring the marked range back into agreement with the cursor, after an
    /// action has moved one or the other.
    ///
    /// Three rules, and each of them is about the same thing: what is
    /// highlighted must be what `c` would comment on, because the highlight is
    /// the only thing the reviewer can check that against.
    fn reconcile_selection(&mut self, action: Action, cursor_before: usize) {
        let dragging = matches!(
            action,
            Action::SelectStart { .. } | Action::SelectExtend { .. } | Action::SelectEnd { .. }
        );
        let moved = self.cursor != cursor_before;
        let cursor = self.cursor;
        match &mut self.selection {
            // Visual mode: the head follows the cursor, so every movement key
            // there is doubles as a way to extend — including `]`, `n` and
            // `G`, which is most of the value of doing it this way.
            Some(sel) if sel.visual => sel.head = cursor,
            // A mouse selection is dropped the moment the cursor leaves it.
            // Letting it linger means the reviewer can be looking at one line
            // and about to comment on another.
            Some(_) if moved && !dragging => self.selection = None,
            // A drag that never left its cell is a click, not a one-character
            // selection: the two are the same pair of events, and a click is
            // what the reviewer meant far more often.
            Some(sel)
                if matches!(action, Action::SelectEnd { .. })
                    && sel.anchor == sel.head
                    && sel.columns.map(|(a, h)| a == h) == Some(true) =>
            {
                self.selection = None;
            }
            _ => {}
        }
    }

    /// The display columns of `row` that are inside the selection, half-open.
    ///
    /// `usize::MAX` for "to the end of the line": a row in the middle of a
    /// multi-line selection has no right-hand limit, and clamping it to the
    /// text's width here would mean measuring the text twice.
    pub fn selected_columns(&self, row: usize) -> Option<(usize, usize)> {
        let sel = self.selection?;
        if !sel.contains(row) {
            return None;
        }
        let (first, last) = sel.rows();
        let Some((start, end)) = sel.columns_in_order() else {
            return Some((0, usize::MAX));
        };
        // The cell under the pointer is inside the selection, hence `end + 1`
        // — see `text::cluster_at_column` for why a terminal counts cells and
        // a browser counts insertion points.
        Some(match (row == first, row == last) {
            (true, true) => (start, end + 1),
            (true, false) => (start, usize::MAX),
            (false, true) => (0, end + 1),
            (false, false) => (0, usize::MAX),
        })
    }

    /// The column of a line's text under a mouse column, and in split view
    /// which of the two code columns it landed in.
    ///
    /// The prefix arithmetic here is the mirror image of what `ui` draws, and
    /// the two agreeing is load-bearing in a way nothing catches: a mismatch
    /// does not fail, it anchors the comment a few characters off. Unified
    /// spends `gutter * 2 + MARKER_COLS` before the text; split spends
    /// `gutter + MARKER_COLS - 1` per side, twice, with one column of divider
    /// between — which is why both come from `rows::split_side_prefix` and
    /// `rows::split_half_width` rather than being worked out again here.
    ///
    /// The side is `None` in unified view, where a row *is* a side — and also
    /// for a row that has no sides at all. `row` is what was pressed, so a
    /// header, a comment or a gap answers "no side" rather than whichever half
    /// of the pane it happened to land in: an accidental side overrides the one
    /// `comment_anchor` would derive, and over an addition-only run it leaves
    /// no line to anchor to at all, so `c` reports nothing to comment on where
    /// unified would have worked.
    ///
    /// `held` is the side a drag has already committed to. Once a gesture has
    /// one, a pointer that wanders across the divider is still selecting the
    /// text it began in, so the column keeps being read in that half's frame —
    /// otherwise it restarts from zero in the other half and the stored range
    /// reverses, or collapses far enough to be taken for a click.
    fn text_column_at(
        &self,
        col: u16,
        row: Option<Row>,
        held: Option<bool>,
    ) -> (usize, Option<bool>) {
        let within = col.saturating_sub(self.panes.diff.x) as usize;
        // Only a `Row::Split` is drawn in two columns. An expanded gap keeps the
        // unified shape even in split view — its text is the same on both sides,
        // so there is nothing to put beside it — and must therefore be decoded
        // with the unified prefix, or a press on one resolves a gutter's width
        // off and picks up a side it does not have.
        let two_sided = matches!(row, Some(Row::Split { .. }));
        if !self.split() || !(two_sided || held.is_some()) {
            return (
                self.h_scroll + within.saturating_sub(self.gutter * 2 + MARKER_COLS),
                None,
            );
        }
        let prefix = split_side_prefix(self.gutter);
        let half = split_half_width(self.wrap_width, self.gutter);
        let divider = prefix + half;
        let side = held.unwrap_or(within > divider);
        let into_side = if side {
            within.saturating_sub(divider + 1)
        } else {
            // Past the divider while holding the left column: the pointer has
            // run off the end of this side, which means end of line — not
            // column zero of the other one.
            within.min(divider)
        };
        (
            self.h_scroll + into_side.saturating_sub(prefix).min(half),
            Some(side),
        )
    }

    /// What a comment posted right now would be anchored to: the selection if
    /// there is one, the cursor's own line if there is not.
    ///
    /// `None` when there is no line of code in range — the cursor is on a file
    /// header, a hunk header, the gap, or inside another comment. Better to
    /// say so than to invent an anchor: a comment stored against a defaulted
    /// one is durable garbage that no UI can place, which is why the server
    /// refuses to default it either.
    pub fn comment_anchor(&self) -> Option<CommentAnchor> {
        let (first, last) = match self.selection {
            Some(sel) => sel.rows(),
            None => (self.cursor, self.cursor),
        };
        // Clamped once and reused below: two spellings of the same range invite
        // the reader to work out whether they can differ, and the second would
        // start underflowing the day this early return moves.
        let marked = self
            .rows
            .get(first..=last.min(self.rows.len().saturating_sub(1)))?;
        // The *file* comes from the first line of code in range. The **side**
        // comes from the drag when there was one — see `Selection::side` — and
        // from that same line otherwise. Either way it is one side: a selection
        // across a deletion and its replacement can only be one or the other,
        // because line numbers on the wire belong to a side, and everything in
        // range that disagrees is simply not part of the anchor.
        let dragged_side = self.selection.and_then(|s| s.side);
        let (file, additions) = marked.iter().find_map(|row| {
            let (file, hunk, line) = self.leading_line(*row)?;
            let l = &self.files[file].hunks[hunk].lines[line];
            Some((file, dragged_side.unwrap_or(l.new_line.is_some())))
        })?;

        let mut numbers: Vec<(u32, &str)> = Vec::new();
        for row in marked {
            let Some((f, hunk, line)) = self.line_on_side(*row, additions) else {
                continue;
            };
            if f != file {
                continue;
            }
            let l = &self.files[file].hunks[hunk].lines[line];
            let number = if additions { l.new_line } else { l.old_line };
            if let Some(n) = number {
                numbers.push((n, l.text.as_str()));
            }
        }
        let (&(start_line, _), &(end_line, _)) = (numbers.first()?, numbers.last()?);
        let texts: Vec<&str> = numbers.iter().map(|(_, t)| *t).collect();

        let columns = self
            .selection
            .and_then(|s| s.columns_in_order())
            .map(|(start, end)| self.narrow(&texts, start, end));

        Some(CommentAnchor {
            file_path: self.files[file].path.clone(),
            side: if additions { "additions" } else { "deletions" },
            start_line,
            end_line,
            line_content: texts.join("\n"),
            columns,
        })
    }

    /// Whether the diff is actually being drawn side by side.
    ///
    /// The reviewer's preference *and* enough room to honour it. Measured on
    /// the diff pane rather than the terminal, because the file list takes a
    /// fixed 34 columns off the front — a 120-column terminal showing the list
    /// has 86 to split, and two 36-column code columns are not a diff anyone
    /// can read. Hiding the list is therefore a way to get split view back on a
    /// narrow terminal, which is the behaviour you want and would be impossible
    /// to explain if the threshold were on the window.
    pub fn split(&self) -> bool {
        self.split_pref && self.wrap_width >= SPLIT_MIN_COLS
    }

    /// The hunk line a row leads with, whichever view drew it.
    ///
    /// This and `line_on_side` are what keep one anchoring path for unified and
    /// split. A split row carries two lines where a unified row carries one, and
    /// without a shared answer to "what does this row say" the two views would
    /// each grow their own anchor logic — and a disagreement between them is a
    /// comment that lands on a different line depending on which view the
    /// reviewer happened to be in, with nothing on screen to say so.
    ///
    /// A pair leads with its **new** side when it has one. That matches the
    /// unified rule (an addition or a context line reports as additions) and it
    /// is the side a reviewer means by default.
    fn leading_line(&self, row: Row) -> Option<(usize, usize, usize)> {
        match row {
            Row::Code { file, hunk, line } => Some((file, hunk, line)),
            Row::Split { file, hunk, pair } => pair.right.or(pair.left).map(|l| (file, hunk, l)),
            _ => None,
        }
    }

    /// The hunk line a row contributes to one side of the anchor.
    ///
    /// In split view a pair holds both sides at once, so "the deletions side of
    /// this row" is a real question with a real answer; in unified it is the row
    /// itself or nothing, which is what the old code said by matching on
    /// `Row::Code` alone.
    fn line_on_side(&self, row: Row, additions: bool) -> Option<(usize, usize, usize)> {
        match row {
            Row::Code { file, hunk, line } => Some((file, hunk, line)),
            Row::Split { file, hunk, pair } => {
                let side = if additions { pair.right } else { pair.left };
                side.map(|l| (file, hunk, l))
            }
            _ => None,
        }
    }

    /// Turn two display columns into the wire's character anchor: UTF-16
    /// offsets into the first and last anchored lines, and the exact text
    /// between them.
    ///
    /// The columns belong to the rows the drag started and ended on, which are
    /// not always the rows that survived into `texts` — a drag across a
    /// deletion and its replacement keeps only one side. Applying them to the
    /// first and last line that *did* survive is the answer that stays inside
    /// the range the reviewer marked.
    ///
    /// That collapse is also the only thing `columns_in_order` cannot settle,
    /// and why the pair is ordered here rather than there: it orders by *row*,
    /// which decides nothing once two rows have become one line. A drag that
    /// went down and to the left then arrives still in gesture order, and an
    /// unswapped pair is stored durably — the server clamps `endLine` and never
    /// the columns, and the browser normalises the same case in
    /// `mapRangeToAnchor`, so the two clients would disagree about an invariant
    /// only one of them keeps. Ordered before the lookup, never after: swapping
    /// resolved endpoints would move each to the far side of its own character
    /// and exclude both.
    fn narrow(&self, texts: &[&str], start: usize, end: usize) -> (u32, u32, String) {
        let first = texts.first().copied().unwrap_or_default();
        let last = texts.last().copied().unwrap_or_default();
        let (start, end) = if texts.len() == 1 && end < start {
            (end, start)
        } else {
            (start, end)
        };
        let from = cluster_at_column(first, self.tab_size, start).0;
        // Inclusive of the cell the pointer was over, so the end is the far
        // side of that character.
        let to = cluster_at_column(last, self.tab_size, end).1;
        let selected = if texts.len() == 1 {
            first[from.byte..to.byte].to_string()
        } else {
            let mut out = vec![first[from.byte..].to_string()];
            out.extend(texts[1..texts.len() - 1].iter().map(|t| t.to_string()));
            out.push(last[..to.byte].to_string());
            out.join("\n")
        };
        (from.utf16 as u32, to.utf16 as u32, selected)
    }

    /// What a mouse event means, given where the last frame put things.
    ///
    /// `Action::None` for anything outside a pane. A press in the diff starts
    /// a selection rather than only moving the cursor: the two are the same
    /// gesture until the pointer moves, and `apply` settles which it was when
    /// the button comes back up.
    pub fn mouse_action(&self, event: MouseEvent) -> Action {
        if !self.mouse {
            return Action::None;
        }
        let (col, row) = (event.column, event.row);
        match event.kind {
            // Three lines a notch, the same as most pagers. The wheel is for
            // reading ahead, so it does not disturb the cursor — and it scrolls
            // whichever pane the pointer is over, since that is the only thing
            // in the gesture that says which one the reviewer meant.
            MouseEventKind::ScrollDown if self.over_files(col, row) => Action::ScrollFilesDown(3),
            MouseEventKind::ScrollUp if self.over_files(col, row) => Action::ScrollFilesUp(3),
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
                match self.diff_row_at(col, row) {
                    Some(index) => {
                        let (column, side) =
                            self.text_column_at(col, self.rows.get(index).copied(), None);
                        Action::SelectStart {
                            row: index,
                            column,
                            side,
                        }
                    }
                    None => Action::None,
                }
            }
            // Only while a selection of our own is open: a drag that started
            // outside the pane, or after `v`, is not ours to extend.
            MouseEventKind::Drag(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left) => {
                let open = self.selection.is_some_and(|s| !s.visual);
                // The pointer leaving the pane during a drag is normal —
                // clamp to the pane's rows rather than dropping the event, or
                // a selection stops growing halfway down the screen.
                let Some(index) = open.then(|| self.diff_row_clamped(row)).flatten() else {
                    return Action::None;
                };
                // The side is fixed by where the drag *started*, and handing it
                // back in is what keeps the column in that side's frame: a
                // pointer wandering across the divider is still selecting the
                // text it began in.
                let held = self.selection.and_then(|s| s.side);
                let (column, _) = self.text_column_at(col, self.rows.get(index).copied(), held);
                if matches!(event.kind, MouseEventKind::Up(_)) {
                    Action::SelectEnd { row: index, column }
                } else {
                    Action::SelectExtend { row: index, column }
                }
            }
            _ => Action::None,
        }
    }

    fn over_files(&self, col: u16, row: u16) -> bool {
        self.panes
            .files
            .is_some_and(|area| contains(area, col, row))
    }

    /// How many files the list can show, from the last frame. 1 until one has
    /// been drawn, which only bounds a scroll that cannot have happened yet.
    fn files_viewport(&self) -> usize {
        self.panes.files.map_or(1, |a| (a.height as usize).max(1))
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

    /// The model row drawn under a point, or `None` if the point is outside
    /// the diff pane or past the last row.
    fn diff_row_at(&self, col: u16, row: u16) -> Option<usize> {
        let area = self.panes.diff;
        if !contains(area, col, row) {
            return None;
        }
        let index = self.panes.diff_top_row + (row - area.y) as usize;
        (index < self.rows.len()).then_some(index)
    }

    /// The same, for a drag: the column is ignored and a row above or below
    /// the pane is pulled back to its nearest edge, so a selection dragged off
    /// the top of the screen keeps growing.
    fn diff_row_clamped(&self, row: u16) -> Option<usize> {
        let area = self.panes.diff;
        if area.height == 0 || self.rows.is_empty() {
            return None;
        }
        let within = row.clamp(area.y, area.bottom().saturating_sub(1));
        let index = self.panes.diff_top_row + (within - area.y) as usize;
        Some(index.min(self.rows.len() - 1))
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
        // On a gap, the same key means the same thing one level down: fold or
        // unfold the run under the cursor rather than the file around it. A
        // reviewer who has opened a gap to read it wants a way to put it back
        // that isn't pressing `-` eleven times.
        match self.rows.get(self.cursor) {
            Some(Row::Expand { .. }) => {
                self.expand_gap(Step::All);
                return;
            }
            Some(Row::Context { .. }) => {
                self.expand_gap(Step::Closed);
                return;
            }
            _ => {}
        }
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
        (KeyCode::Char('q'), false) => Action::Quit,
        (KeyCode::Char('c'), true) => Action::Quit,
        // Esc backs out of whatever is up — the overlay, then a selection —
        // and otherwise does nothing. It deliberately does not quit: crossterm
        // reports a lone `\x1b` it cannot resolve into a longer sequence as
        // `Esc`, and terminals emit sequences it does not model, so quitting
        // on it means a stray report can end the session mid-review. `q` and
        // Ctrl+C already cover leaving.
        (KeyCode::Esc, _) => Action::Escape,
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
        (KeyCode::Char('c'), false) => Action::Comment,
        // Capitals for the verbs that act on someone else's comment, so a
        // mistyped lowercase key cannot post or resolve anything.
        (KeyCode::Char('R'), false) => Action::Reply,
        (KeyCode::Char('X'), false) => Action::ToggleResolved,
        (KeyCode::Char('P'), false) => Action::PostQueued,
        (KeyCode::Char('S'), false) => Action::Submit,
        (KeyCode::Char('}'), false) => Action::NextComment,
        (KeyCode::Char('{'), false) => Action::PrevComment,
        (KeyCode::Char('f'), false) => Action::ToggleFiles,
        (KeyCode::Char('m'), false) => Action::ToggleMouse,
        // `V` too, because in vim the two differ by whether the selection is
        // line-wise — and here it always is.
        (KeyCode::Char('v'), false) | (KeyCode::Char('V'), false) => Action::ToggleVisual,
        (KeyCode::Char('?'), false) => Action::ToggleHelp,
        (KeyCode::Char('s'), false) => Action::ToggleSplit,
        // Same physical key shifted and unshifted, so they mean the same thing;
        // binding them differently is how a reviewer expands twice by accident.
        (KeyCode::Char('+'), false) | (KeyCode::Char('='), false) => {
            Action::Expand(Step::More(EXPAND_STEP))
        }
        (KeyCode::Char('-'), false) => Action::Expand(Step::Less(EXPAND_STEP)),
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
            file_contents: Default::default(),
            untracked_files: Vec::new(),
        }
    }

    fn app() -> App {
        let mut app = App::default();
        app.load(&payload(PATCH), 10);
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
        app.load(&payload(grown), 10);
        assert_eq!(
            app.cursor_path().as_deref(),
            Some("b.rs"),
            "the anchor is the file, not the row index"
        );
    }

    #[test]
    fn a_refetch_that_drops_the_current_file_clamps_both_indices() {
        // Both, not just the cursor: an offset left past the end makes
        // `row_window` empty, and the pane renders blank with a perfectly
        // valid cursor and nothing to say why.
        let mut app = app();
        app.apply(Action::Bottom, 10);
        app.load(
            &payload("diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-x\n+y"),
            10,
        );
        assert!(app.cursor < app.rows.len());
        assert!(app.offset <= app.rows.len().saturating_sub(10));
        assert!(
            !crate::rows::row_window(app.rows.len(), app.offset, 10).is_empty(),
            "a shorter diff must still have something on screen"
        );
    }

    #[test]
    fn a_refetch_that_shrinks_the_diff_under_a_scrolled_view_still_shows_it() {
        // The case the clamp is for: reading the bottom of a long diff when an
        // agent finishes and most of it goes away.
        let long: String = (0..80)
            .map(|n| format!("diff --git a/f{n}.rs b/f{n}.rs\n@@ -1 +1 @@\n-a\n+b\n"))
            .collect();
        let mut app = App::default();
        app.load(&payload(&long), 10);
        app.apply(Action::Bottom, 10);
        assert!(app.offset > 100);

        app.load(
            &payload("diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-x\n+y"),
            10,
        );
        assert!(
            !crate::rows::row_window(app.rows.len(), app.offset, 10).is_empty(),
            "offset {} is past a {}-row diff",
            app.offset,
            app.rows.len()
        );
    }

    #[test]
    fn an_empty_diff_is_navigable_without_panicking() {
        let mut app = App::default();
        app.load(&payload(""), 10);
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
        app.load(&payload(PATCH), 10);
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
    fn horizontal_scroll_stops_at_both_ends_of_what_there_is_to_read() {
        // A long line to have somewhere to scroll to. Both ends are clamped:
        // left at zero, and right at the widest line there is — scrolling past
        // that leaves a pane of bare gutters, and the way back (`0`) is in the
        // help overlay only.
        let long = "x".repeat(200);
        let patch = format!("diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-short\n+{long}");
        let mut app = App::default();
        app.load(&payload(&patch), 10);
        assert_eq!(app.widest_line, 200);

        app.apply(Action::ScrollLeft(4), 10);
        assert_eq!(app.h_scroll, 0, "left of column zero is nothing");
        app.apply(Action::ScrollRight(4), 10);
        app.apply(Action::ScrollRight(4), 10);
        assert_eq!(app.h_scroll, 8);

        for _ in 0..200 {
            app.apply(Action::ScrollRight(4), 10);
        }
        assert_eq!(app.h_scroll, 199, "never past the widest line");

        app.apply(Action::ResetHScroll, 10);
        assert_eq!(app.h_scroll, 0);
    }

    #[test]
    fn a_review_with_nothing_in_it_cannot_be_scrolled_sideways() {
        let mut app = App::default();
        app.load(&payload(""), 10);
        app.apply(Action::ScrollRight(4), 10);
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
        with_panes(&mut app);
        app.apply(Action::ToggleFocus, 10);
        assert_eq!(app.focus, Focus::Files);
        app.apply(Action::ToggleFiles, 10);
        assert!(!app.show_files);
        assert_eq!(app.focus, Focus::Diff);
        app.apply(Action::ToggleFiles, 10);
        assert!(app.show_files);
    }

    #[test]
    fn f_and_m_are_bound_to_the_files_and_mouse_toggles() {
        assert_eq!(action_for(key('f'), false).0, Action::ToggleFiles);
        assert_eq!(action_for(key('m'), false).0, Action::ToggleMouse);
    }

    // ---- mouse ---------------------------------------------------------

    fn with_panes(app: &mut App) {
        frame_of(app, 20);
    }

    /// Report a frame the way the draw loop does — through `set_panes`, not by
    /// assigning `app.panes`. Anything that asserts about the offset has to go
    /// this way: the loop reconciles after *every* draw, so a test that skips
    /// it is testing a program nobody runs.
    fn frame_of(app: &mut App, height: u16) -> Panes {
        // A plausible frame: header on row 0, footer on the last row, file
        // list 34 wide on the left.
        let panes = Panes {
            diff: Rect::new(34, 1, 66, height),
            diff_top_row: 0,
            files: Some(Rect::new(1, 2, 32, height.saturating_sub(2))),
            files_top: 0,
        };
        app.set_panes(panes);
        panes
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
        frame_of(&mut app, 5);
        let before = app.cursor;
        app.apply(
            app.mouse_action(mouse(MouseEventKind::ScrollDown, 40, 5)),
            5,
        );
        assert_eq!(app.offset, 3);
        assert_eq!(app.cursor, before, "the cursor stayed put");

        // And it has to survive the next frame. The loop reconciles panes after
        // every draw, so a scroll that only lasts until the redraw is a scroll
        // the reviewer never sees.
        frame_of(&mut app, 5);
        assert_eq!(app.offset, 3, "the redraw did not drag the view back");

        // A movement key is what snaps the view back to the cursor.
        app.apply(Action::Down(1), 5);
        assert!(app.offset <= app.cursor);
    }

    #[test]
    fn the_view_does_not_scroll_past_either_end() {
        let mut app = app();
        frame_of(&mut app, 5);
        app.apply(Action::ScrollViewUp(3), 5);
        assert_eq!(app.offset, 0);
        for _ in 0..50 {
            app.apply(Action::ScrollViewDown(3), 5);
        }
        assert_eq!(app.offset, app.rows.len().saturating_sub(5));
        frame_of(&mut app, 5);
        assert_eq!(
            app.offset,
            app.rows.len().saturating_sub(5),
            "the redraw left the view at the end"
        );
    }

    /// An app with more files than the list can show at once.
    fn many_files() -> App {
        let mut patch = String::new();
        for i in 0..40 {
            patch.push_str(&format!(
                "diff --git a/f{i:02}.rs b/f{i:02}.rs\n@@ -1 +1 @@\n-old{i}\n+new{i}\n"
            ));
        }
        let mut app = App::default();
        app.load(&payload(&patch), 20);
        app.set_panes(Panes {
            diff: Rect::new(34, 1, 66, 20),
            diff_top_row: 0,
            files: Some(Rect::new(1, 2, 32, 10)),
            files_top: 0,
        });
        assert_eq!(app.files.len(), 40);
        app
    }

    #[test]
    fn the_wheel_scrolls_whichever_pane_it_is_over() {
        // The file list is a scrollable pane; pointing at it and scrolling has
        // to scroll *it*. Sending both to the diff left a review with more
        // files than rows no way to show the rest short of walking the cursor
        // into them.
        let mut app = many_files();
        let over_files = mouse(MouseEventKind::ScrollDown, 10, 5);
        let over_diff = mouse(MouseEventKind::ScrollDown, 60, 5);
        assert_eq!(app.mouse_action(over_files), Action::ScrollFilesDown(3));
        assert_eq!(app.mouse_action(over_diff), Action::ScrollViewDown(3));

        let diff_before = app.offset;
        app.apply(Action::ScrollFilesDown(3), 20);
        assert_eq!(app.files_offset, 3, "the list moved");
        assert_eq!(app.offset, diff_before, "and the diff did not");
    }

    #[test]
    fn a_scrolled_file_list_stays_put_until_the_cursor_changes_file() {
        // Same rule as the diff: the wheel is for looking ahead, so nothing but
        // a move to another file may pull the list back.
        let mut app = many_files();
        app.apply(Action::ScrollFilesDown(6), 20);
        assert_eq!(app.files_offset, 6);

        // Moving within the first file leaves it alone...
        app.apply(Action::Down(1), 20);
        assert_eq!(app.files_offset, 6, "still where the wheel put it");

        // ...and stepping to another file brings it back into view.
        app.apply(Action::NextFile, 20);
        let current = app.current_file().expect("on a file");
        assert!(
            (app.files_offset..app.files_offset + 10).contains(&current),
            "file {current} outside {}..{}",
            app.files_offset,
            app.files_offset + 10
        );
    }

    #[test]
    fn the_file_list_does_not_scroll_past_its_end() {
        let mut app = many_files();
        for _ in 0..50 {
            app.apply(Action::ScrollFilesDown(3), 20);
        }
        assert_eq!(app.files_offset, 40 - 10);
        for _ in 0..50 {
            app.apply(Action::ScrollFilesUp(3), 20);
        }
        assert_eq!(app.files_offset, 0);
    }

    #[test]
    fn the_help_overlay_does_not_move_the_view() {
        // Driven the way the loop drives it — action, then the frame that
        // action produced — because the two roads back to the cursor are in
        // different functions and a test that takes only one of them passes
        // with the other fully broken. This one did: reported through
        // `set_panes` alone it was green while `?` still snapped the view home.
        let mut app = app();
        frame_of(&mut app, 5);
        app.apply(Action::ScrollViewDown(3), 5);
        assert_eq!(app.offset, 3);

        // `ui::draw` reports a zero-height diff pane while the overlay is up,
        // so a click cannot reach through it. That is not a viewport.
        app.apply(Action::ToggleHelp, 5);
        app.set_panes(Panes::default());
        assert_eq!(app.offset, 3, "the overlay kept the reviewer's place");

        app.apply(Action::ToggleHelp, 5);
        frame_of(&mut app, 5);
        assert_eq!(app.offset, 3, "and closing it did not move them either");
    }

    #[test]
    fn a_key_that_moves_nothing_leaves_the_view_where_it_was() {
        // Hiding the file list, taking the mouse back — neither is a movement,
        // and neither should cost the reviewer the place they scrolled to.
        for action in [Action::ToggleFiles, Action::ToggleMouse] {
            let mut app = app();
            frame_of(&mut app, 5);
            app.apply(Action::ScrollViewDown(3), 5);
            app.apply(action, 5);
            assert_eq!(app.offset, 3, "{action:?} moved the view");
        }
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
        // The counterpart to `walking_by_line_still_scrolls_as_little_as
        // _possible`: this pins the jump case, which tops the file instead.
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
    fn focus_follows_what_was_drawn_not_what_was_asked_for() {
        // The pane also disappears on a narrow terminal, which `App` cannot
        // see — so the frame is what settles it. Focus left on an undrawn pane
        // erases the cursor bar, which on a monochrome terminal is the only
        // cursor there is.
        let mut app = app();
        with_panes(&mut app);
        app.apply(Action::ToggleFocus, 10);
        assert_eq!(app.focus, Focus::Files);

        app.set_panes(Panes {
            files: None,
            ..app.panes
        });
        assert_eq!(app.focus, Focus::Diff, "the frame drew no list");

        // And Tab cannot put it back while there is nothing to put it on.
        app.apply(Action::ToggleFocus, 10);
        assert_eq!(app.focus, Focus::Diff);
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
    fn a_drag_that_is_not_ours_is_not_a_selection() {
        // Nothing open: the press happened somewhere else, or the reviewer is
        // in visual mode and the pointer is incidental.
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
        app.apply(Action::ToggleVisual, 20);
        assert_eq!(
            app.mouse_action(mouse(MouseEventKind::Drag(MouseButton::Left), 50, 8)),
            Action::None,
            "a keyboard selection is not extended by the pointer"
        );
    }

    // ---- selection ------------------------------------------------------

    /// Drag from one point to another, as a terminal reports it.
    fn drag(app: &mut App, from: (u16, u16), to: (u16, u16)) {
        for event in [
            mouse(MouseEventKind::Down(MouseButton::Left), from.0, from.1),
            mouse(MouseEventKind::Drag(MouseButton::Left), to.0, to.1),
            mouse(MouseEventKind::Up(MouseButton::Left), to.0, to.1),
        ] {
            let action = app.mouse_action(event);
            app.apply(action, 20);
        }
    }

    /// A patch whose lines have text worth selecting parts of.
    const TEXTY: &str = "diff --git a/a.rs b/a.rs\n\
                         @@ -1,3 +1,3 @@\n\
                         \x20alpha bravo\n\
                         -charlie delta\n\
                         +echo foxtrot";

    fn texty() -> App {
        let mut app = App::default();
        app.load(&payload(TEXTY), 20);
        app.panes = Panes {
            diff: Rect::new(0, 1, 80, 20),
            diff_top_row: 0,
            files: None,
            files_top: 0,
        };
        app
    }

    #[test]
    fn a_click_is_a_click_and_a_drag_is_a_selection() {
        // They are the same pair of events until the pointer moves, so the
        // press cannot decide — only the release can.
        let mut app = texty();
        // Row 2 of the model (" alpha bravo") is screen row 3.
        drag(&mut app, (10, 3), (10, 3));
        assert_eq!(app.selection, None, "a press and release in one cell");
        assert_eq!(app.cursor, 2, "but it still moved the cursor");

        drag(&mut app, (10, 3), (14, 3));
        assert!(app.selection.is_some(), "the pointer moved");
    }

    #[test]
    fn a_drag_across_one_line_anchors_the_characters_under_it() {
        // The payoff of doing this in a terminal: the column arrives in the
        // event, where the browser needs 400 lines of caret hit-testing.
        let mut app = texty();
        // Row 4 is "+echo foxtrot"; the code starts after two 2-wide gutters
        // and the 4-column marker field, so column 6 of the pane is column 0
        // of the text.
        let text_x = 8u16;
        drag(&mut app, (text_x, 5), (text_x + 3, 5));
        let anchor = app.comment_anchor().expect("a line of code was marked");
        assert_eq!(anchor.file_path, "a.rs");
        assert_eq!(anchor.side, "additions");
        assert_eq!((anchor.start_line, anchor.end_line), (2, 2));
        let (start, end, text) = anchor.columns.expect("a character anchor");
        assert_eq!((start, end), (0, 4));
        assert_eq!(text, "echo", "the cell under the pointer is included");
    }

    #[test]
    fn a_drag_back_the_way_it_came_still_reads_left_to_right() {
        let mut app = texty();
        let text_x = 8u16;
        drag(&mut app, (text_x + 3, 5), (text_x, 5));
        let (start, end, text) = app.comment_anchor().unwrap().columns.unwrap();
        assert_eq!((start, end), (0, 4));
        assert_eq!(text, "echo");
    }

    #[test]
    fn a_drag_down_the_screen_spans_lines_and_keeps_both_columns() {
        let mut app = texty();
        let text_x = 8u16;
        // From "alpha bravo" column 6 down to "echo foxtrot" column 4.
        drag(&mut app, (text_x + 6, 3), (text_x + 3, 5));
        let anchor = app.comment_anchor().unwrap();
        // The deletion row in between contributes nothing: line numbers on the
        // wire belong to a side, and this range is the additions side.
        assert_eq!(anchor.side, "additions");
        assert_eq!((anchor.start_line, anchor.end_line), (1, 2));
        assert_eq!(anchor.line_content, "alpha bravo\necho foxtrot");
        let (start, end, text) = anchor.columns.unwrap();
        assert_eq!((start, end), (6, 4));
        assert_eq!(text, "bravo\necho");
    }

    #[test]
    fn a_selection_that_starts_on_a_deletion_is_anchored_on_that_side() {
        let mut app = texty();
        // Row 3 (screen row 4) is "-charlie delta".
        drag(&mut app, (8, 4), (14, 4));
        let anchor = app.comment_anchor().unwrap();
        assert_eq!(anchor.side, "deletions");
        assert_eq!((anchor.start_line, anchor.end_line), (2, 2));
        assert_eq!(anchor.columns.unwrap().2, "charlie");
    }

    fn note_on(line: u32) -> ReviewComment {
        ReviewComment {
            id: format!("c{line}"),
            file_path: "a.rs".into(),
            side: "additions".into(),
            line_number: line,
            end_line: None,
            line_content: String::new(),
            body: "a note".into(),
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

    /// `PATCH` with b.rs's text attached, so its two hunks have real gaps
    /// around them.
    fn payload_with_text(patch: &str) -> DiffPayload {
        let lines: Vec<String> = (1..=40).map(|n| format!("line {n}")).collect();
        let mut payload = payload(patch);
        payload.file_contents.insert(
            "b.rs".into(),
            crate::client::FileSides {
                new: crate::client::SideText {
                    contents: Some(lines.join("\n")),
                    ..Default::default()
                },
            },
        );
        payload
    }

    #[test]
    fn an_opened_gap_survives_the_refetch_that_follows_every_save() {
        // The TUI refetches on every write and on every file the agent
        // touches, so an expansion that reset each time would be unusable —
        // the reviewer would be reading a gap that folded up under them.
        let mut app = App::default();
        app.load(&payload_with_text(PATCH), 20);
        let expand = app
            .rows
            .iter()
            .position(|r| matches!(r, Row::Expand { .. }))
            .expect("b.rs has gaps around its hunks");
        app.cursor = expand;
        assert!(app.expand_gap(Step::More(3)));
        let opened = app
            .rows
            .iter()
            .filter(|r| matches!(r, Row::Context { .. }))
            .count();
        assert!(opened > 0, "the gap opened");

        app.load(&payload_with_text(PATCH), 20);
        assert_eq!(
            app.rows
                .iter()
                .filter(|r| matches!(r, Row::Context { .. }))
                .count(),
            opened,
            "the refetch folded it back up"
        );
    }

    #[test]
    fn a_gap_with_no_text_behind_it_says_so_rather_than_doing_nothing() {
        // An oversize or binary side is a refusal, not an error — but a row
        // that silently declines to open looks exactly like a broken key.
        let mut app = App::default();
        let mut payload = payload(PATCH);
        payload.file_contents.insert(
            "b.rs".into(),
            crate::client::FileSides {
                new: crate::client::SideText {
                    oversize: true,
                    ..Default::default()
                },
            },
        );
        app.load(&payload, 20);
        let expand = app
            .rows
            .iter()
            .position(|r| matches!(r, Row::Expand { .. }))
            .expect("the row is still drawn — it is where the reason is said");
        let Some(Row::Expand { file, gap }) = app.rows.get(expand).copied() else {
            unreachable!()
        };
        assert_eq!(
            app.gap_state(file, gap).unwrap().1,
            Some("file too large to expand")
        );
        // And the key declines rather than pretending.
        app.cursor = expand;
        assert!(!app.expand_gap(Step::More(3)));
        assert!(!app.rows.iter().any(|r| matches!(r, Row::Context { .. })));
    }

    #[test]
    fn a_comment_arriving_above_the_marked_range_does_not_move_it() {
        // The reviewer's marked range is what `c` posts against, so a shift it
        // cannot see is worse than a cursor that jumps: the comment lands on
        // lines nobody chose, and nothing about it looks wrong afterwards.
        let mut app = texty();
        let text_x = 8u16;
        drag(&mut app, (text_x, 4), (text_x + 6, 4));
        let before = app.comment_anchor().expect("a line of code was marked");

        // Anchored on " alpha bravo", one line above — its rows push every
        // index below it down.
        app.set_comments(vec![note_on(1)], 20);

        let after = app.comment_anchor().expect("the marked range survived");
        assert_eq!(
            (after.start_line, after.end_line),
            (before.start_line, before.end_line)
        );
        assert_eq!(after.line_content, before.line_content);
        assert_eq!(after.columns, before.columns);
    }

    #[test]
    fn a_diff_that_changed_underneath_drops_the_marked_range() {
        // The other half: here the rows themselves mean something new, so
        // re-finding them by identity would be re-anchoring onto text the
        // reviewer never read.
        let mut app = texty();
        drag(&mut app, (8, 4), (14, 4));
        assert!(app.selection.is_some(), "the drag marked something");
        app.load(&payload(TEXTY), 20);
        assert_eq!(
            app.selection, None,
            "a reload drops it rather than moving it"
        );
    }

    /// `texty()` in split view, on a pane wide enough to carry it.
    fn split_texty() -> App {
        let mut app = App::default();
        app.load(&payload(TEXTY), 20);
        app.split_pref = true;
        app.set_panes(Panes {
            diff: Rect::new(0, 1, 120, 20),
            diff_top_row: 0,
            files: None,
            files_top: 0,
        });
        assert!(app.split(), "120 columns is room for two");
        app
    }

    #[test]
    fn toggling_the_view_keeps_the_cursor_on_the_same_line_of_code() {
        // A Row::Code never equals a Row::Split, so identity cannot survive the
        // toggle — the cursor has to be re-found by what the row says. Without
        // that the raw index carries over into a list of a different length and
        // silently lands on another line.
        let mut app = split_texty();
        app.apply(Action::Down(3), 20);
        let before = app.leading_line(app.rows[app.cursor]);
        assert!(before.is_some(), "parked on a line of code");

        app.apply(Action::ToggleSplit, 20);
        assert!(!app.split(), "now unified");
        assert_eq!(app.leading_line(app.rows[app.cursor]), before);

        app.apply(Action::ToggleSplit, 20);
        assert!(app.split(), "and back");
        assert_eq!(app.leading_line(app.rows[app.cursor]), before);
    }

    #[test]
    fn a_drag_that_wanders_past_the_divider_extends_to_end_of_line() {
        // The pointer leaving the column it started in does not mean the
        // reviewer changed their mind about which line they are selecting. Read
        // in the other half's frame, the column restarts from zero — which
        // reverses the stored range, or collapses it far enough to be taken for
        // a click and dropped.
        let mut app = split_texty();
        let text_x = split_side_prefix(app.gutter) as u16;
        let half = split_half_width(app.wrap_width, app.gutter);
        let far_right = (split_side_prefix(app.gutter) * 2 + half + 20) as u16;
        drag(&mut app, (text_x, 4), (far_right, 4));
        let anchor = app.comment_anchor().expect("still a selection");
        assert_eq!(anchor.side, "deletions");
        let (start, end, text) = anchor.columns.expect("a character anchor");
        assert!(start <= end, "columns came back {start}..{end}");
        assert_eq!(text, "charlie delta", "extended to the end of its own line");
    }

    #[test]
    fn a_press_on_a_row_with_no_sides_does_not_invent_one() {
        // Which half of the pane a hunk header happens to sit under is not a
        // statement about additions or deletions, and letting it become one
        // overrides the side comment_anchor would have derived.
        let app = split_texty();
        let far_right = (split_side_prefix(app.gutter) * 2
            + split_half_width(app.wrap_width, app.gutter)
            + 4) as u16;
        // Screen row 2 is the hunk header; row 1 the file header.
        let action = app.mouse_action(mouse(MouseEventKind::Down(MouseButton::Left), far_right, 2));
        match action {
            Action::SelectStart { side, .. } => assert_eq!(side, None),
            other => panic!("expected a SelectStart, got {other:?}"),
        }
    }

    #[test]
    fn a_pane_too_narrow_for_two_columns_falls_back_to_unified() {
        // Remembered, not forgotten: hiding the file list or widening the
        // terminal has to bring it back without the reviewer asking twice.
        let mut app = split_texty();
        app.set_panes(Panes {
            diff: Rect::new(0, 1, 60, 20),
            diff_top_row: 0,
            files: None,
            files_top: 0,
        });
        assert!(!app.split(), "60 columns is not");
        assert!(app.split_pref, "but the preference survived");
        assert!(
            app.rows.iter().any(|r| matches!(r, Row::Code { .. })),
            "and the rows are unified ones again"
        );
    }

    #[test]
    fn a_drag_in_the_old_column_anchors_on_the_deletions_side() {
        // The row holds both sides at once, so nothing but the drag itself can
        // say which one the reviewer meant (`Selection::side`).
        let mut app = split_texty();
        let gutter = app.gutter;
        let left_text = split_side_prefix(gutter) as u16;
        // Row 3 of the model pairs "-charlie delta" with "+echo foxtrot";
        // screen row 4 with the diff pane starting at y=1.
        drag(&mut app, (left_text, 4), (left_text + 6, 4));
        let anchor = app.comment_anchor().expect("a line of code was marked");
        assert_eq!(anchor.side, "deletions");
        assert_eq!(anchor.columns.unwrap().2, "charlie");
    }

    #[test]
    fn a_drag_in_the_new_column_anchors_on_the_additions_side() {
        let mut app = split_texty();
        let half = split_half_width(app.wrap_width, app.gutter);
        let right_text = split_side_prefix(app.gutter) * 2 + half + 1;
        drag(&mut app, (right_text as u16, 4), (right_text as u16 + 3, 4));
        let anchor = app.comment_anchor().expect("a line of code was marked");
        assert_eq!(anchor.side, "additions");
        assert_eq!(
            anchor.columns.unwrap().2,
            "echo",
            "the same drag, one column over, is the other line"
        );
    }

    #[test]
    fn a_drag_down_and_left_onto_a_dropped_side_still_reads_left_to_right() {
        // The one case row order cannot settle. Starting on the deletion picks
        // that side, so the addition row below contributes no line number and
        // the range collapses to a single line — with the two columns still in
        // the order the gesture produced them. Stored unswapped, `startColumn >
        // endColumn` survives on the wire (the server clamps `endLine` and
        // never the columns) and slices to nothing wherever it is read.
        let mut app = texty();
        let text_x = 8u16;
        // "-charlie delta" column 10, down and left to "+echo foxtrot" column 2.
        drag(&mut app, (text_x + 10, 4), (text_x + 2, 5));
        let anchor = app.comment_anchor().unwrap();
        assert_eq!(anchor.side, "deletions");
        assert_eq!((anchor.start_line, anchor.end_line), (2, 2));
        let (start, end, text) = anchor.columns.unwrap();
        assert!(start <= end, "columns came back as {start}..{end}");
        assert_eq!((start, end), (2, 11));
        assert_eq!(text, "arlie del");
    }

    #[test]
    fn with_no_selection_a_comment_goes_on_the_cursors_own_line() {
        // One anchor path rather than two: `c` on a line and `c` on a marked
        // range have to produce the same shape, or the two disagree the first
        // time one of them is changed.
        let mut app = texty();
        app.apply(Action::Down(2), 20);
        let anchor = app.comment_anchor().expect("the cursor is on code");
        assert_eq!((anchor.start_line, anchor.end_line), (1, 1));
        assert_eq!(anchor.line_content, "alpha bravo");
        assert_eq!(anchor.columns, None, "a whole line, like a browser's");
    }

    #[test]
    fn there_is_nothing_to_comment_on_from_a_header_or_a_gap() {
        // Rather than inventing an anchor: the server refuses a defaulted one
        // for the same reason, since a comment nothing can place is durable
        // garbage.
        let mut app = texty();
        assert_eq!(app.rows[app.cursor], Row::File { file: 0 });
        assert!(app.comment_anchor().is_none());
        app.apply(Action::Down(1), 20);
        assert!(matches!(app.rows[app.cursor], Row::Hunk { .. }));
        assert!(app.comment_anchor().is_none());
    }

    #[test]
    fn visual_mode_extends_with_every_movement_key_there_is() {
        let mut app = texty();
        app.apply(Action::Down(2), 20); // onto " alpha bravo"
        app.apply(Action::ToggleVisual, 20);
        app.apply(Action::Bottom, 20);
        let anchor = app.comment_anchor().unwrap();
        assert_eq!((anchor.start_line, anchor.end_line), (1, 2));
        assert_eq!(
            anchor.columns, None,
            "line-wise: a keyboard has no caret to put mid-line"
        );

        // And `v` again puts it away.
        app.apply(Action::ToggleVisual, 20);
        assert_eq!(app.selection, None);
    }

    #[test]
    fn escape_backs_out_of_one_thing_at_a_time_and_never_out_of_krit() {
        let mut app = texty();
        app.show_help = true;
        app.apply(Action::ToggleVisual, 20);
        app.apply(Action::Escape, 20);
        assert!(!app.show_help);
        assert!(app.selection.is_some(), "the overlay went first");
        app.apply(Action::Escape, 20);
        assert_eq!(app.selection, None);
        app.apply(Action::Escape, 20);
        assert!(!app.should_quit, "and never the session");
    }

    #[test]
    fn moving_off_a_mouse_selection_drops_it() {
        // What is marked is what `c` would comment on. A selection left behind
        // by the cursor means looking at one line and commenting on another.
        let mut app = texty();
        drag(&mut app, (8, 5), (12, 5));
        assert!(app.selection.is_some());
        app.apply(Action::Up(1), 20);
        assert_eq!(app.selection, None);
    }

    #[test]
    fn a_drag_off_the_edge_of_the_pane_keeps_going() {
        // The pointer leaving the pane mid-drag is normal; dropping the event
        // would stop the selection growing halfway down the screen.
        let mut app = texty();
        app.apply(Action::Bottom, 20);
        drag(&mut app, (8, 5), (8, 0));
        let (first, _) = app.selection.expect("still selecting").rows();
        assert_eq!(first, 0, "clamped to the pane's first row");
    }

    #[test]
    fn the_marked_columns_of_each_row_describe_what_to_underline() {
        let mut app = texty();
        drag(&mut app, (8 + 6, 3), (8 + 3, 5));
        // First row: from the start column to the end of the line. Middle:
        // all of it. Last: up to and including the cell under the pointer.
        assert_eq!(app.selected_columns(2), Some((6, usize::MAX)));
        assert_eq!(app.selected_columns(3), Some((0, usize::MAX)));
        assert_eq!(app.selected_columns(4), Some((0, 4)));
        assert_eq!(app.selected_columns(1), None);
    }

    #[test]
    fn a_tab_indented_line_selects_the_characters_it_looks_like() {
        // Columns on screen are not columns in the file: the anchor has to
        // come back through the tab expansion or every comment on indented
        // code is off by however many tabs precede it.
        let patch = "diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-x\n+\tlet x = 1;";
        let mut app = App {
            tab_size: 4,
            ..App::default()
        };
        app.load(&payload(patch), 20);
        app.panes = Panes {
            diff: Rect::new(0, 1, 80, 20),
            diff_top_row: 0,
            files: None,
            files_top: 0,
        };
        // "\tlet x = 1;" draws as "    let x = 1;", so screen column 4 is the
        // `l` — source offset 1, not 4.
        drag(&mut app, (8 + 4, 4), (8 + 6, 4));
        let (start, end, text) = app.comment_anchor().unwrap().columns.unwrap();
        assert_eq!((start, end), (1, 4));
        assert_eq!(text, "let");
    }
}
