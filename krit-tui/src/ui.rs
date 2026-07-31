//! Drawing. This module owns geometry and presentation — whether the file
//! list fits, where the list is scrolled, whether the terminal gets colors —
//! and reports those decisions back through `Panes` so hit-testing resolves
//! against what was actually drawn. What it never does is mutate `App`.
//!
//! The rule the whole module is shaped by: **no state may be color-only.**
//! `NO_COLOR` is honored, terminals still exist that have eight colors, and
//! people review diffs over SSH into things nobody has heard of. So change
//! type is a sigil, an added line starts with `+`, and the cursor is drawn
//! with reverse video — an attribute, not a hue.

use crate::app::{App, Focus, Panes, Status};
use crate::comments::{CommentAnchor, CommentLine};
use crate::compose::Composer;
use crate::patch::{ChangeKind, LineKind};
use crate::rows::{
    MARKER_COLS, Note, Row, Side, comments_in, line_marker, row_window, split_half_width,
    split_side_prefix, stat_label,
};
use crate::text::{display_width, expand_tabs, fit_columns, slice_columns};
use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

/// Narrower than this and the file list costs more than it gives — the code
/// column is what the reviewer came for.
const FILE_PANE_MIN_TOTAL: u16 = 90;
const FILE_PANE_WIDTH: u16 = 34;

pub struct Theme {
    pub color: bool,
}

impl Theme {
    /// `NO_COLOR` is a promise, not a preference: any value at all means off.
    /// `TERM=dumb` means the terminal cannot be trusted with attributes
    /// either, but reverse video is the last thing to go.
    pub fn detect() -> Self {
        let no_color = std::env::var_os("NO_COLOR").is_some();
        let dumb = std::env::var("TERM").map(|t| t == "dumb").unwrap_or(false);
        Theme {
            color: !no_color && !dumb,
        }
    }

    fn fg(&self, color: Color) -> Style {
        if self.color {
            Style::default().fg(color)
        } else {
            Style::default()
        }
    }

    fn dim(&self) -> Style {
        Style::default().add_modifier(Modifier::DIM)
    }
}

/// Draw a frame, and report where things ended up so a click can be resolved
/// against the same geometry that produced the picture.
pub fn draw(frame: &mut Frame, app: &App, theme: &Theme, enhanced: bool) -> Panes {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(area);

    frame.render_widget(header(app, theme), chunks[0]);

    let body = chunks[1];
    // Two independent reasons the list can be absent: the reviewer hid it,
    // or it does not fit. Either way the diff gets the whole body.
    let mut panes = Panes::default();
    let files_pane_drawn = app.show_files && area.width >= FILE_PANE_MIN_TOTAL;
    let diff_area = if files_pane_drawn {
        let split = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(FILE_PANE_WIDTH), Constraint::Min(20)])
            .split(body);
        let (pane, inner, top) = file_pane(app, theme, split[0]);
        frame.render_widget(pane, split[0]);
        panes.files = Some(inner);
        panes.files_top = top;
        split[1]
    } else {
        body
    };
    // The composer takes rows off the bottom of the diff rather than covering
    // it: what is being commented on has to stay readable while it is being
    // written about. `App::set_panes` scrolls the cursor back into what is
    // left.
    let diff_area = match &app.compose {
        Some(composer) => {
            let height = compose_height(composer, diff_area);
            let split = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(1), Constraint::Length(height)])
                .split(diff_area);
            let (widget, caret) = compose_pane(composer, theme, split[1], enhanced);
            frame.render_widget(widget, split[1]);
            frame.set_cursor_position(caret);
            split[0]
        }
        None => diff_area,
    };
    frame.render_widget(diff_pane(app, theme, diff_area), diff_area);
    panes.diff = diff_area;
    panes.diff_top_row = app.offset.min(app.rows.len());

    frame.render_widget(footer(app, theme), chunks[2]);

    if app.show_help {
        // Sized from the keys themselves. Hard-coding it meant adding a
        // binding silently clipped the overlay — and it already was: the
        // longest line was one column wider than the box.
        let (widget, width, height) = help();
        let overlay = centered(area, width, height);
        frame.render_widget(Clear, overlay);
        frame.render_widget(widget, overlay);
        // The overlay covers the panes, so a click while it is up must not
        // reach whatever it is sitting on top of.
        panes = Panes {
            diff: Rect::default(),
            ..Panes::default()
        };
    }
    panes
}

fn header<'a>(app: &App, theme: &Theme) -> Paragraph<'a> {
    let (adds, dels) = app.totals;
    let scope = if app.custom_mode {
        " (custom range)"
    } else {
        ""
    };
    // Comments are counted here rather than left to be discovered by scrolling:
    // a review with three of them and a review with none look identical until
    // you reach one.
    let comments = match app.comments.len() {
        0 => String::new(),
        1 => "  1 comment".to_string(),
        n => format!("  {n} comments"),
    };
    // Two counts, because the header's number would otherwise be a promise the
    // screen does not keep: a comment on a file this range no longer carries is
    // in `app.comments` and in no row, so `}` steps past it and nothing says it
    // is there. Saying how many is the least that keeps the two honest.
    let mut aside = Vec::new();
    match app.comments.iter().filter(|c| c.status == "queued").count() {
        0 => {}
        n => aside.push(format!("{n} queued")),
    }
    match app.comment_rows.elsewhere {
        0 => {}
        n => aside.push(format!("{n} elsewhere")),
    }
    let aside = if aside.is_empty() {
        String::new()
    } else {
        format!(" ({})", aside.join(", "))
    };
    let text = format!(
        " krit  {}  {}{}   {} file{}  +{} −{}{}{}",
        app.repo,
        app.branch,
        scope,
        app.files.len(),
        if app.files.len() == 1 { "" } else { "s" },
        adds,
        dels,
        comments,
        aside,
    );
    Paragraph::new(Line::from(Span::styled(
        text,
        theme.fg(Color::Cyan).add_modifier(Modifier::BOLD),
    )))
}

fn footer<'a>(app: &App, theme: &Theme) -> Paragraph<'a> {
    // A selection displaces the key hints, because it is a mode: what the
    // next keystroke does has changed, and the strip is the only place that
    // can say so.
    if app.selection.is_some() && matches!(app.status, Status::Idle) {
        let text = match app.comment_anchor() {
            Some(a) => format!(" {}  ·  c comment  ·  Esc clear", selection_label(&a)),
            // Marked, but over nothing that can carry a comment — a gap, a
            // file header, someone else's comment. Saying so beats a `c` that
            // appears to do nothing.
            None => " nothing to comment on here  ·  Esc clear".to_string(),
        };
        return Paragraph::new(Line::from(Span::styled(
            text,
            theme.fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )));
    }
    let (text, style) = match &app.status {
        Status::Idle => (
            format!(
                " j/k move · n/p hunk · ]/[ file · v select · c comment · z collapse · f files{} · ? keys · q quit",
                // Only worth a cell when it is off, because that is the state
                // someone needs telling how to undo.
                if app.mouse { "" } else { " · m mouse off" },
            ),
            theme.dim(),
        ),
        Status::Note(msg) => (format!(" {msg}"), theme.fg(Color::Cyan)),
        // Reverse video, so an error is still obviously an error with no
        // colors at all.
        Status::Error(msg) => (
            format!(" {msg}"),
            theme
                .fg(Color::Red)
                .add_modifier(Modifier::REVERSED | Modifier::BOLD),
        ),
        Status::Ended(msg) => (
            format!(" {msg}"),
            theme.fg(Color::Yellow).add_modifier(Modifier::BOLD),
        ),
    };
    Paragraph::new(Line::from(Span::styled(text, style)))
}

/// Everything in the composer pane that is not the reviewer's text: two border
/// rows and the line of keys under it. Named because four places subtract it —
/// the height, the pane, the scroll window and `run`'s key handler — and a
/// chrome row added without finding all four draws the caret one row off, which
/// is a picture rather than an error.
const COMPOSE_CHROME_ROWS: u16 = 3;
/// The composer's left and right border columns, subtracted to get the width
/// text wraps to. The same width has to be used to draw and to move the caret,
/// or up and down land somewhere the reviewer did not put them.
const COMPOSE_BORDER_COLS: u16 = 2;

/// Rows the composer needs: its border, what it holds, and a line for the
/// keys — but never more than half the pane, since the point of putting it
/// below the diff is that the diff stays readable.
fn compose_height(composer: &Composer, area: Rect) -> u16 {
    let text_width = compose_text_width(area);
    let wrapped = composer.editor.layout(text_width).0.len() as u16;
    // The trailing `max` is not a second floor: it stops `clamp` from panicking
    // when the computed ceiling falls below the floor, which any diff pane
    // under ten rows produces. A panic here wrecks the terminal — the panic
    // path is what restores it — so this is load-bearing rather than redundant.
    (wrapped + COMPOSE_CHROME_ROWS).clamp(5, (area.height / 2).max(5))
}

/// The width the composer's text wraps to inside `area`.
pub fn compose_text_width(area: Rect) -> usize {
    area.width.saturating_sub(COMPOSE_BORDER_COLS).max(1) as usize
}

/// The form, and where the terminal's own caret goes.
///
/// A real caret rather than a drawn one: it blinks, it is where the terminal
/// puts the IME, and a screen reader follows it. That is the whole reason the
/// editor's layout reports a position instead of the pane inventing one.
fn compose_pane<'a>(
    composer: &Composer,
    theme: &Theme,
    area: Rect,
    enhanced: bool,
) -> (Paragraph<'a>, (u16, u16)) {
    let text_width = compose_text_width(area);
    let (mut lines, (caret_row, caret_col)) = composer.editor.layout(text_width);
    let visible = area.height.saturating_sub(COMPOSE_CHROME_ROWS) as usize;
    // Scroll the buffer, not the caret: a comment longer than the pane still
    // has to be typeable, and the line being typed is the one to keep.
    let top = caret_row.saturating_sub(visible.saturating_sub(1));
    let shown: Vec<Line> = lines
        .drain(..)
        .skip(top)
        .take(visible)
        .map(|l| Line::from(Span::raw(l)))
        .collect();

    let keys = if composer.confirm_discard {
        // The terminal's answer to `confirm()`: a line of text and a flag, with
        // the screen still live and still redrawing behind it.
        " Discard what you have written?  y to discard  ·  any other key to keep it".to_string()
    } else if composer.sending {
        " Sending…".to_string()
    } else {
        let post = if enhanced {
            "ctrl-s / ctrl-enter post"
        } else {
            "ctrl-s post"
        };
        let queue = if composer.can_queue() {
            "  ·  ctrl-q queue"
        } else {
            ""
        };
        format!(" {post}{queue}  ·  enter newline  ·  esc cancel")
    };
    let style = if composer.confirm_discard {
        theme
            .fg(Color::Yellow)
            .add_modifier(Modifier::REVERSED | Modifier::BOLD)
    } else {
        theme.dim()
    };

    let mut body = shown;
    body.push(Line::from(Span::styled(keys, style)));
    let widget = Paragraph::new(body).block(
        Block::default()
            .borders(Borders::ALL)
            .title(composer.title())
            .border_style(theme.fg(Color::Cyan)),
    );
    let caret = (
        area.x + 1 + caret_col.min(text_width.saturating_sub(1)) as u16,
        area.y + 1 + (caret_row - top) as u16,
    );
    (widget, caret)
}

/// What the marked range covers, as the reviewer would describe it.
///
/// The selected text itself for a short character range, because that is the
/// thing being asked about and it fits; the line count otherwise.
/// Longest selected text quoted back in a label, in **display cells** — this
/// one shares a footer with the key hints, so what matters is the space it
/// takes rather than how many characters it is. Past it the label says
/// "(part)". `main::TITLE_CHARS` is a different budget in a different unit.
const QUOTED_LABEL_CELLS: usize = 40;

pub fn selection_label(anchor: &CommentAnchor) -> String {
    let lines = (anchor.end_line - anchor.start_line + 1) as usize;
    let where_ = if lines == 1 {
        format!("{} line {}", anchor.file_path, anchor.start_line)
    } else {
        format!(
            "{} lines {}–{}",
            anchor.file_path, anchor.start_line, anchor.end_line
        )
    };
    match &anchor.columns {
        Some((_, _, text))
            if lines == 1 && display_width(text) <= QUOTED_LABEL_CELLS && !text.is_empty() =>
        {
            format!("{where_}  “{text}”")
        }
        Some(_) => format!("{where_}  (part)"),
        None => where_,
    }
}

fn kind_color(kind: ChangeKind) -> Color {
    match kind {
        ChangeKind::Added | ChangeKind::Untracked => Color::Green,
        ChangeKind::Deleted => Color::Red,
        ChangeKind::Renamed => Color::Magenta,
        ChangeKind::Modified => Color::Yellow,
    }
}

/// Decoration only — `comments::status_label` puts the same distinction in
/// words on the badge line, which is what a monochrome terminal reads.
fn comment_color(comment: &krit_core::types::ReviewComment) -> Color {
    match crate::comments::status_label(comment) {
        "resolved" => Color::Green,
        "queued" => Color::Magenta,
        "outdated" => Color::Yellow,
        _ => Color::Cyan,
    }
}

/// The list widget, the rect its rows occupy (inside the border), and the
/// index of the file drawn on its first row. The last two are what make a
/// click resolvable — computed here because here is where they are decided.
fn file_pane<'a>(app: &App, theme: &Theme, area: Rect) -> (Paragraph<'a>, Rect, usize) {
    let current = app.current_file();
    let text_cols = FILE_PANE_WIDTH.saturating_sub(2) as usize;
    let visible = area.height.saturating_sub(2) as usize;
    // `App` owns this, and the pane only clamps it. Recomputing it here from
    // the current file — which is what this did — meant the wheel could not
    // move the list at all: whatever a scroll set, the next frame put straight
    // back, so a review with more files than rows had no way to show the rest
    // short of walking the cursor into them.
    let start = app
        .files_offset
        .min(app.files.len().saturating_sub(visible));
    let rows = Rect {
        x: area.x + 1,
        y: area.y + 1,
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(2),
    };

    let mut lines: Vec<Line> = Vec::new();
    for (i, file) in app.files.iter().enumerate().skip(start).take(visible) {
        let stats = stat_label(file);
        let room = text_cols.saturating_sub(display_width(&stats) + 3);
        let name = elide_left(&file.path, room);
        let mut style = Style::default();
        if Some(i) == current {
            style = style.add_modifier(Modifier::REVERSED);
        }
        if app.collapsed.contains(&file.path) {
            style = style.add_modifier(Modifier::DIM);
        }
        lines.push(Line::from(vec![
            Span::styled(
                format!("{} ", file.kind.sigil()),
                theme.fg(kind_color(file.kind)).patch(style),
            ),
            Span::styled(fit_columns(&name, room), style),
            Span::styled(format!(" {stats}"), theme.dim().patch(style)),
        ]));
    }

    let title = if app.focus == Focus::Files {
        " Files ▸ "
    } else {
        " Files "
    };
    let pane = Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(title));
    (pane, rows, start)
}

fn diff_pane<'a>(app: &App, theme: &Theme, area: Rect) -> Paragraph<'a> {
    if app.files.is_empty() {
        return Paragraph::new(Line::from(Span::styled(
            "  No changes in this review.",
            theme.dim(),
        )));
    }
    let width = area.width as usize;
    let window = row_window(app.rows.len(), app.offset, area.height as usize);

    let mut lines: Vec<Line> = Vec::new();
    for index in window {
        let selected = index == app.cursor && app.focus == Focus::Diff;
        lines.push(render_row(app, theme, index, width, selected));
    }
    Paragraph::new(lines)
}

/// How a marked range is drawn: an attribute, not a hue, because the cursor
/// already owns reverse video and both have to survive `NO_COLOR`. Underline
/// is the one remaining attribute every terminal worth supporting renders.
fn marked() -> Style {
    Style::default().add_modifier(Modifier::UNDERLINED)
}

fn render_row<'a>(
    app: &App,
    theme: &Theme,
    index: usize,
    pane_width: usize,
    selected: bool,
) -> Line<'a> {
    let cursor = if selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    };
    let marks = app.selected_columns(index);
    // A non-code row caught in a visual range is marked whole: there is no
    // text of its own to narrow to, and leaving it plain would make a
    // selection spanning a hunk boundary look like two selections.
    let whole = if marks.is_some() {
        marked()
    } else {
        Style::default()
    };
    // old │ new │ marker │ text — a fixed prefix, so the code column never
    // moves as you scroll between files.
    let gutter = app.gutter;
    let text_width = pane_width.saturating_sub(gutter * 2 + MARKER_COLS);

    match app.rows[index] {
        // Padded and styled like every other row: a cursor parked on the gap
        // between two files would otherwise be invisible, since reverse video
        // over an empty string covers nothing.
        Row::Gap => Line::from(Span::styled(
            fit_columns("", pane_width),
            whole.patch(cursor),
        )),
        Row::File { file } => {
            let f = &app.files[file];
            let text = format!(" {} {}  {}", f.kind.sigil(), f.path, stat_label(f));
            Line::from(Span::styled(
                fit_columns(&text, pane_width),
                theme
                    .fg(kind_color(f.kind))
                    .add_modifier(Modifier::BOLD)
                    .patch(whole)
                    .patch(cursor),
            ))
        }
        Row::Comment {
            comment, line: at, ..
        } => {
            // Unreachable while the two agree: `build_rows` emits exactly
            // `comment_rows.height(comment)` of these, from the same layout
            // this reads. A miss therefore means they have drifted, and a blank
            // row keeps the scroll arithmetic — which counts rows, not
            // comments — intact rather than panicking mid-frame and taking the
            // terminal's cooked mode with it.
            let Some(line) = app.comment_rows.line(comment, at) else {
                return Line::from(Span::styled(
                    fit_columns("", pane_width),
                    whole.patch(cursor),
                ));
            };
            // The badge line carries the status word, so the color is
            // decoration on top of text that already says it.
            let style = match line {
                CommentLine::Head(_) => theme
                    .fg(comment_color(&app.comments[comment]))
                    .add_modifier(Modifier::BOLD),
                CommentLine::Body(_) => Style::default(),
                CommentLine::Reply(_) => theme.dim(),
            };
            Line::from(Span::styled(
                fit_columns(line.text(), pane_width),
                style.patch(whole).patch(cursor),
            ))
        }
        Row::Meta { file, note } => {
            let f = &app.files[file];
            let text = match note {
                Note::RenamedFrom => {
                    format!("   renamed from {}", f.old_path.as_deref().unwrap_or("?"))
                }
                Note::Binary => "   binary file — not shown".to_string(),
                Note::Mode => match &f.mode {
                    Some((from, to)) => format!("   mode {from} → {to}"),
                    None => "   mode changed".to_string(),
                },
                Note::Collapsed => {
                    let n = f.hunks.len();
                    // The comments go with the body, so the note says how many
                    // — folding a file must not silently take its conversation
                    // out of sight.
                    let hidden = comments_in(&app.files, file, &app.comment_rows);
                    let conversation = match hidden {
                        0 => String::new(),
                        1 => ", 1 comment".to_string(),
                        n => format!(", {n} comments"),
                    };
                    format!(
                        "   collapsed — {n} hunk{}{conversation} hidden",
                        if n == 1 { "" } else { "s" }
                    )
                }
            };
            // Full width like the rows around it, so the cursor bar is a bar
            // rather than a fragment — that bar is the only cursor indicator
            // that survives NO_COLOR.
            Line::from(Span::styled(
                fit_columns(&text, pane_width),
                theme.dim().patch(whole).patch(cursor),
            ))
        }
        Row::Hunk { file, hunk } => {
            let h = &app.files[file].hunks[hunk];
            let text = format!(
                " @@ -{},{} +{},{} @@ {}",
                h.old_start, h.old_len, h.new_start, h.new_len, h.section
            );
            Line::from(Span::styled(
                fit_columns(&text, pane_width),
                theme.fg(Color::Cyan).patch(whole).patch(cursor),
            ))
        }
        Row::Code { file, hunk, line } => {
            let l = &app.files[file].hunks[hunk].lines[line];
            let marker = line_marker(l.kind);
            let body = expand_tabs(&l.text, app.tab_size);
            let visible = slice_columns(&body, app.h_scroll, text_width);
            let style = match l.kind {
                LineKind::Addition => theme.fg(Color::Green),
                LineKind::Deletion => theme.fg(Color::Red),
                LineKind::Context => Style::default(),
            }
            .patch(cursor);
            let gutter_style = theme.dim().patch(cursor);
            let mut spans = vec![
                // The gutters stay unmarked: what is selected is text, and a
                // character range that underlined the line numbers too would
                // claim more than it covers.
                Span::styled(fit_columns(&num(l.old_line), gutter), gutter_style),
                Span::styled(" ", gutter_style),
                Span::styled(fit_columns(&num(l.new_line), gutter), gutter_style),
                Span::styled(format!(" {marker} "), style),
            ];
            spans.extend(marked_spans(
                &visible,
                style,
                app.h_scroll,
                text_width,
                marks,
            ));
            Line::from(spans)
        }
        // Drawn exactly like a context line, gutters and all, because that is
        // what it is — the only difference is where the text came from. A
        // different shape here would make expanded lines read as an annotation
        // rather than as the file.
        //
        // That holds in split view too, where it is a deliberate exception to
        // the two-column layout: an unchanged line is the same text on both
        // sides, so a split gap row would be the same string twice. It is drawn
        // once across the pane instead, and `App::text_column_at` decodes it
        // with the unified prefix for the same reason.
        Row::Context { file, gap, line } => {
            let (text, old) = app.context_line(file, gap, line).unwrap_or(("", None));
            let body = expand_tabs(text, app.tab_size);
            let visible = slice_columns(&body, app.h_scroll, text_width);
            let gutter_style = theme.dim().patch(cursor);
            let mut spans = vec![
                Span::styled(fit_columns(&num(old), gutter), gutter_style),
                Span::styled(" ", gutter_style),
                Span::styled(fit_columns(&num(Some(line)), gutter), gutter_style),
                Span::styled("   ", Style::default().patch(cursor)),
            ];
            spans.extend(marked_spans(
                &visible,
                Style::default().patch(cursor),
                app.h_scroll,
                text_width,
                marks,
            ));
            Line::from(spans)
        }
        Row::Split { file, hunk, pair } => {
            let h = &app.files[file].hunks[hunk];
            let half = split_half_width(pane_width, gutter);
            // Only the column the drag happened in is underlined; a line-wise
            // selection has no side and marks both. See `Selection::side`.
            let dragged = app.selection.and_then(|s| s.side);
            let side = |which: Option<usize>, which_side: Side| -> Vec<Span<'a>> {
                let marks = match dragged {
                    Some(s) if s != which_side => None,
                    _ => marks,
                };
                let Some(li) = which else {
                    // An absent side is padded, not skipped. A blank column is
                    // what says "nothing here was added" — a short row would
                    // just look like the end of the file.
                    return vec![Span::styled(
                        fit_columns("", split_side_prefix(gutter) + half),
                        Style::default().patch(cursor),
                    )];
                };
                let l = &h.lines[li];
                let number = match which_side {
                    Side::New => l.new_line,
                    Side::Old => l.old_line,
                };
                let style = match l.kind {
                    LineKind::Addition => theme.fg(Color::Green),
                    LineKind::Deletion => theme.fg(Color::Red),
                    LineKind::Context => Style::default(),
                }
                .patch(cursor);
                let body = expand_tabs(&l.text, app.tab_size);
                // Padded to the full half, not just sliced to it. `slice_columns`
                // truncates and never pads, so a side shorter than `half` would
                // put the divider — and everything right of it — wherever this
                // line happened to end. That is not merely ragged: it is the
                // column `App::text_column_at` subtracts to decide which side a
                // click landed in, so an unpadded row silently decodes every
                // drag in the right-hand column against the left-hand line.
                let visible = fit_columns(&slice_columns(&body, app.h_scroll, half), half);
                let mut spans = vec![
                    Span::styled(fit_columns(&num(number), gutter), theme.dim().patch(cursor)),
                    Span::styled(format!(" {} ", line_marker(l.kind)), style),
                ];
                spans.extend(marked_spans(&visible, style, app.h_scroll, half, marks));
                spans
            };
            let mut spans = side(pair.left, Side::Old);
            // A divider rather than a space: two code columns with nothing
            // between them read as one wrapped line, which is the whole failure
            // mode split view exists to avoid.
            spans.push(Span::styled("│", theme.dim().patch(cursor)));
            spans.extend(side(pair.right, Side::New));
            Line::from(spans)
        }
        Row::Expand { file, gap } => {
            let (hidden, refusal) = app.gap_state(file, gap).unwrap_or((0, None));
            let text = match refusal {
                // Named rather than left as a row that does nothing: a gap that
                // cannot open looks exactly like one that is broken.
                Some(why) => format!("   ⋯ {hidden} unchanged line{} — {why}", plural(hidden)),
                // The keys are named here rather than in the footer because
                // this is the only row they do anything on, and a footer that
                // listed every contextual key would be all of them.
                None => format!(
                    "   ⋯ {hidden} unchanged line{}  ·  + more  ·  z all",
                    plural(hidden)
                ),
            };
            Line::from(Span::styled(
                fit_columns(&text, pane_width),
                theme.dim().patch(whole).patch(cursor),
            ))
        }
    }
}

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The code column, split at the selection's edges.
///
/// Every column here is a display column of the *visible* window, so the
/// horizontal scroll is subtracted once, at the door. The marked run is padded
/// to its own width rather than to the text's: a selection that runs past the
/// end of a short line — a blank line inside a multi-line drag, or a pointer
/// released in the empty right-hand side of the pane — has to show as marked,
/// and there is no text there to carry the attribute.
fn marked_spans<'a>(
    visible: &str,
    style: Style,
    h_scroll: usize,
    text_width: usize,
    marks: Option<(usize, usize)>,
) -> Vec<Span<'a>> {
    let Some((from, to)) = marks else {
        return vec![Span::styled(visible.to_string(), style)];
    };
    let start = from.saturating_sub(h_scroll).min(text_width);
    let end = to.saturating_sub(h_scroll).min(text_width);
    if end <= start {
        return vec![Span::styled(visible.to_string(), style)];
    }
    vec![
        Span::styled(slice_columns(visible, 0, start), style),
        Span::styled(
            fit_columns(&slice_columns(visible, start, end - start), end - start),
            style.patch(marked()),
        ),
        Span::styled(
            slice_columns(visible, end, text_width.saturating_sub(end)),
            style,
        ),
    ]
}

fn num(n: Option<u32>) -> String {
    n.map(|n| n.to_string()).unwrap_or_default()
}

/// Long paths lose their middle, not their end: `.../hooks/useComments.ts`
/// identifies a file, `src/ui/hooks/useCom…` does not.
pub fn elide_left(path: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if display_width(path) <= width {
        return path.to_string();
    }
    if width == 1 {
        return "…".to_string();
    }
    let tail_width = width - 1;
    let full = display_width(path);
    let tail = slice_columns(path, full - tail_width, tail_width);
    format!("…{tail}")
}

/// The key list, plus the size a box has to be to show all of it: the widest
/// line and the number of lines, each plus its two borders.
fn help<'a>() -> (Paragraph<'a>, u16, u16) {
    let lines = vec![
        Line::from("  j / k, ↑ / ↓      move by line"),
        Line::from("  ctrl-d / ctrl-u   half a screen"),
        Line::from("  space / b         half a screen"),
        Line::from("  gg / G            first / last row"),
        Line::from("  n / p             next / previous hunk"),
        Line::from("  ] / [             next / previous file"),
        Line::from("  h / l, 0          scroll sideways, reset"),
        Line::from("  } / {             next / previous comment"),
        Line::from("  z, enter          collapse the file, or the gap under it"),
        Line::from("  + / -             open / close a gap between hunks"),
        Line::from("  tab               move between panes"),
        Line::from("  f                 show / hide the file list"),
        Line::from("  s                 split / unified (needs a wide pane)"),
        Line::from("  m                 release the mouse to the terminal"),
        Line::from("  wheel, click      scroll / put the cursor there"),
        Line::from(""),
        Line::from("  v                 select lines (movement extends)"),
        Line::from("  drag              select characters"),
        Line::from("  c                 comment on the selection or the line"),
        Line::from("  R                 reply to the comment under the cursor"),
        Line::from("  X                 resolve it, or reopen it"),
        Line::from("  P                 post every queued comment"),
        Line::from("  S                 done reviewing"),
        Line::from(""),
        Line::from("  r                 refetch the review"),
        Line::from("  ctrl-z            suspend"),
        Line::from("  esc               close this, then clear a selection"),
        Line::from("  ? , q             this / quit"),
    ];
    let width = lines
        .iter()
        .map(|l| display_width(&l.to_string()))
        .max()
        .unwrap_or(0) as u16;
    let height = lines.len() as u16;
    (
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" Keys ")),
        width + 2,
        height + 2,
    )
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let w = width.min(area.width);
    let h = height.min(area.height);
    Rect {
        x: area.x + (area.width - w) / 2,
        y: area.y + (area.height - h) / 2,
        width: w,
        height: h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Action;
    use crate::client::DiffPayload;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;

    const PATCH: &str = "diff --git a/src/a.rs b/src/a.rs\n\
                         @@ -10,3 +10,4 @@ fn thing()\n\
                         \x20   keep()\n\
                         -    was()\n\
                         +    is()\n\
                         +    also()\n\
                         diff --git a/notes.md b/notes.md\n\
                         new file mode 100644\n\
                         @@ -0,0 +1,1 @@\n\
                         +hello";

    fn app() -> App {
        let mut app = App::default();
        app.load(
            &DiffPayload {
                patch: PATCH.to_string(),
                repo_name: "krit".into(),
                branch: "main".into(),
                custom_mode: false,
                file_contents: Default::default(),
                untracked_files: vec!["notes.md".into()],
            },
            10,
        );
        app
    }

    fn rows_of(buf: &Buffer) -> Vec<String> {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    fn render(app: &App, width: u16, height: u16) -> Vec<String> {
        render_with_panes(app, width, height).0
    }

    fn render_with_panes(app: &App, width: u16, height: u16) -> (Vec<String>, Panes) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let theme = Theme { color: true };
        let mut panes = Panes::default();
        terminal
            .draw(|f| panes = draw(f, app, &theme, false))
            .unwrap();
        (rows_of(terminal.backend().buffer()), panes)
    }

    /// `app()` drawn side by side, on a pane wide enough to carry it.
    fn split_app() -> App {
        let mut app = app();
        app.split_pref = true;
        app.show_files = false;
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
    fn every_split_row_puts_its_divider_in_the_same_column() {
        // Read off a rendered frame rather than recomputed, because the
        // arithmetic being checked is exactly what a recomputing test would
        // share with the code. `slice_columns` truncates and does not pad, so
        // an unpadded side put the divider wherever its line ended — ragged on
        // screen, and decoded by `text_column_at` as a divider that is not
        // there, which sends every right-column drag to the left-hand line.
        let app = split_app();
        let screen = render(&app, 120, 20);
        let expect = split_side_prefix(app.gutter) + split_half_width(120, app.gutter);

        let dividers: Vec<usize> = screen
            .iter()
            .filter(|line| line.contains('│'))
            .map(|line| line.chars().position(|c| c == '│').unwrap())
            .collect();
        assert!(
            dividers.len() >= 3,
            "expected several split rows, got {dividers:?}"
        );
        for at in &dividers {
            assert_eq!(*at, expect, "divider moved: {dividers:?} in {screen:#?}");
        }
    }

    #[test]
    fn a_row_with_only_one_side_is_padded_like_the_rest() {
        // `+ also()` has no deletion beside it. The blank column is what says
        // "nothing was removed here"; a short row would read as end-of-file.
        let app = split_app();
        let screen = render(&app, 120, 20);
        let lone = screen
            .iter()
            .find(|line| line.contains("also()"))
            .expect("the unpaired addition rendered");
        let at = lone.chars().position(|c| c == '│').unwrap();
        assert_eq!(
            at,
            split_side_prefix(app.gutter) + split_half_width(120, app.gutter)
        );
    }

    #[test]
    fn the_whole_frame_lays_out_header_panes_and_footer() {
        let screen = render(&app(), 100, 16);
        assert!(screen[0].contains("krit  krit  main"), "{:?}", screen[0]);
        assert!(screen[0].contains("2 files"), "{:?}", screen[0]);
        assert!(screen[0].contains("+3 −1"), "{:?}", screen[0]);
        assert!(screen[1].contains("Files"), "{:?}", screen[1]);
        // The file list carries the sigils, and the untracked file reads as
        // untracked rather than as a plain addition.
        let pane: String = screen.join("\n");
        assert!(pane.contains("M src/a.rs"), "{pane}");
        assert!(pane.contains("? notes.md"), "{pane}");
        assert!(screen[15].contains("q quit"), "{:?}", screen[15]);
    }

    #[test]
    fn code_rows_carry_both_line_numbers_and_a_marker() {
        let screen = render(&app(), 100, 16);
        let body: Vec<&String> = screen.iter().filter(|l| l.contains("was()")).collect();
        assert_eq!(body.len(), 1);
        // old number present, new number absent, marker '-'.
        assert!(
            body[0].contains("11") && body[0].contains("-     was()"),
            "{:?}",
            body[0]
        );

        let added: Vec<&String> = screen.iter().filter(|l| l.contains("is()")).collect();
        assert!(added[0].contains("+     is()"), "{:?}", added[0]);
    }

    #[test]
    fn the_file_pane_disappears_on_a_narrow_terminal_rather_than_squeezing_the_code() {
        let wide = render(&app(), 100, 12);
        assert!(wide[1].contains("Files"));
        let narrow = render(&app(), 70, 12);
        assert!(!narrow.iter().any(|l| l.contains("Files")), "{:?}", narrow);
        // The diff itself is still there.
        assert!(narrow.iter().any(|l| l.contains("src/a.rs")));
    }

    #[test]
    fn an_empty_review_says_so_instead_of_drawing_nothing() {
        let mut app = App::default();
        app.load(
            &DiffPayload {
                patch: String::new(),
                repo_name: "krit".into(),
                branch: "main".into(),
                ..Default::default()
            },
            10,
        );
        let screen = render(&app, 80, 8);
        assert!(
            screen.iter().any(|l| l.contains("No changes")),
            "{screen:?}"
        );
        assert!(screen[0].contains("0 files"));
    }

    #[test]
    fn the_help_overlay_covers_the_diff_and_lists_the_keys() {
        let mut app = app();
        app.show_help = true;
        let screen = render(&app, 100, 20);
        let all = screen.join("\n");
        assert!(all.contains("Keys"), "{all}");
        assert!(all.contains("next / previous hunk"), "{all}");
    }

    #[test]
    fn the_error_strip_replaces_the_key_hints_rather_than_popping_a_dialog() {
        // A terminal can deadlock an automated client exactly the way a
        // browser `confirm()` can; every message is a strip that redraws.
        let mut app = app();
        app.status = Status::Error("cannot reach krit at http://localhost:1".into());
        let screen = render(&app, 100, 12);
        assert!(screen[11].contains("cannot reach krit"), "{:?}", screen[11]);
        assert!(!screen[11].contains("q quit"));
    }

    #[test]
    fn a_binary_file_and_a_rename_render_their_notes() {
        let mut app = App::default();
        app.load(
            &DiffPayload {
                patch: "diff --git a/old.png b/new.png\n\
                    similarity index 100%\n\
                    rename from old.png\n\
                    rename to new.png\n\
                    Binary files a/old.png and b/new.png differ"
                    .to_string(),
                ..Default::default()
            },
            10,
        );
        let all = render(&app, 90, 10).join("\n");
        assert!(all.contains("renamed from old.png"), "{all}");
        assert!(all.contains("binary file"), "{all}");
    }

    #[test]
    fn collapsing_a_file_says_how_much_it_hid() {
        let mut app = app();
        app.apply(Action::ToggleCollapse, 10);
        let all = render(&app, 90, 12).join("\n");
        assert!(all.contains("collapsed — 1 hunk hidden"), "{all}");
        assert!(!all.contains("was()"), "the body is gone: {all}");
    }

    #[test]
    fn horizontal_scrolling_moves_the_code_and_leaves_the_gutter_alone() {
        let mut app = app();
        app.h_scroll = 4;
        let screen = render(&app, 100, 16);
        let line = screen.iter().find(|l| l.contains("was()")).unwrap();
        // The gutter still shows the line number in the same place; only the
        // code has slid.
        assert!(line.contains("11"), "{line:?}");
        assert!(line.contains("- was()"), "{line:?}");
    }

    #[test]
    fn without_color_every_state_is_still_readable() {
        let mut terminal = Terminal::new(TestBackend::new(90, 12)).unwrap();
        let theme = Theme { color: false };
        let app = app();
        terminal
            .draw(|f| {
                draw(f, &app, &theme, false);
            })
            .unwrap();
        let buf = terminal.backend().buffer();
        // Nothing sets a foreground color...
        assert!(
            (0..buf.area.height).all(|y| (0..buf.area.width)
                .all(|x| buf[(x, y)].style().fg.is_none_or(|c| c == Color::Reset))),
            "a color survived NO_COLOR"
        );
        // ...and the diff is still legible: sigils and markers carry it.
        let all = rows_of(buf).join("\n");
        assert!(all.contains("M src/a.rs"), "{all}");
        assert!(all.contains("-     was()"), "{all}");
        assert!(all.contains("+     is()"), "{all}");
    }

    #[test]
    fn a_long_file_list_still_shows_what_comes_after_the_current_file() {
        // The list used to pin the current file to the *last* visible row, so
        // past ~20 files a reviewer could never see one below the cursor. It
        // scrolls by the same least-movement rule as the diff.
        let patch: String = (0..40)
            .map(|n| format!("diff --git a/f{n:02}.rs b/f{n:02}.rs\n@@ -1 +1 @@\n-a\n+b\n"))
            .collect();
        let mut app = App::default();
        app.load(
            &DiffPayload {
                patch,
                ..Default::default()
            },
            10,
        );
        assert_eq!(app.files.len(), 40);

        // Starting at the top, the list starts at the top.
        let (screen, panes) = render_with_panes(&app, 100, 14);
        assert_eq!(panes.files_top, 0);
        assert!(screen[2].contains("f00.rs"), "{:?}", screen[2]);
        assert!(
            screen.iter().any(|l| l.contains("f05.rs")),
            "files after the current one are visible"
        );

        // Walk down past the end of the list; it scrolls to follow.
        for _ in 0..20 {
            app.apply(Action::NextFile, 12);
            app.set_panes(render_with_panes(&app, 100, 14).1);
        }
        let panes = render_with_panes(&app, 100, 14).1;
        assert!(panes.files_top > 0, "the list scrolled to follow");

        // Now the part that was broken: jump back up. The old policy derived
        // the start from the current file alone every frame, so it pinned the
        // current file to the *last* visible row no matter how you arrived —
        // going back to file 12 would show files 3–12 and nothing after. Least
        // movement puts it at the top instead, so what follows it is visible.
        let before = panes.files_top;
        // Far enough that the target is above the window — inside it, least
        // movement correctly does nothing, which the last assertion covers.
        for _ in 0..18 {
            app.apply(Action::PrevFile, 12);
            app.set_panes(render_with_panes(&app, 100, 14).1);
        }
        let (screen, panes) = render_with_panes(&app, 100, 14);
        let current = app.current_file().expect("a file is current");
        assert!(panes.files_top < before, "it scrolled back up");
        assert_eq!(
            panes.files_top, current,
            "the file jumped back to is the first on the list, not the last"
        );
        assert!(
            screen
                .iter()
                .any(|l| l.contains(&format!("f{:02}.rs", current + 3))),
            "files after the current one are on screen: {screen:?}"
        );

        // And a file already on the list doesn't move it at all.
        let steady = panes.files_top;
        app.apply(Action::NextFile, 12);
        app.set_panes(render_with_panes(&app, 100, 14).1);
        assert_eq!(render_with_panes(&app, 100, 14).1.files_top, steady);
    }

    #[test]
    fn hiding_the_file_list_gives_the_diff_the_whole_width() {
        let mut app = app();
        app.apply(Action::ToggleFiles, 10);
        let (screen, panes) = render_with_panes(&app, 100, 12);
        assert!(!screen.iter().any(|l| l.contains("Files")), "{screen:?}");
        assert!(panes.files.is_none(), "nothing to click at");
        assert_eq!(panes.diff.x, 0);
        assert_eq!(panes.diff.width, 100);
        assert!(screen.iter().any(|l| l.contains("src/a.rs")));
    }

    #[test]
    fn the_reported_geometry_is_the_geometry_that_was_drawn() {
        // The whole point of returning it: a click resolves against this, so
        // if it disagrees with the picture, clicks land on the wrong row.
        let (screen, panes) = render_with_panes(&app(), 100, 16);
        let files = panes.files.expect("the list is drawn at this width");
        // The file pane's first row is inside its border, and the first file
        // is drawn on it.
        assert_eq!(files.y, 2);
        assert_eq!(panes.files_top, 0);
        assert!(
            screen[files.y as usize].contains("src/a.rs"),
            "{:?}",
            screen[2]
        );
        // The diff starts just right of the pane and just under the header.
        assert_eq!((panes.diff.x, panes.diff.y), (FILE_PANE_WIDTH, 1));
        assert_eq!(panes.diff_top_row, 0);
        assert!(screen[panes.diff.y as usize].contains("src/a.rs"));
    }

    #[test]
    fn a_scrolled_view_reports_the_row_drawn_at_its_top() {
        let mut app = app();
        // A viewport short enough that there is something to scroll: this
        // diff is 10 rows, so a 10-row view is already showing all of it.
        app.apply(Action::ScrollViewDown(3), 6);
        let (screen, panes) = render_with_panes(&app, 100, 8);
        assert_eq!(panes.diff_top_row, 3);
        // Row 3 of this diff is the second changed line; whatever it is, the
        // top of the pane is not the file header any more.
        assert!(!screen[panes.diff.y as usize].contains("+3 −1"));
    }

    #[test]
    fn the_help_overlay_takes_the_panes_out_of_reach() {
        // It covers them, so a click must not fall through to what is under it.
        let mut app = app();
        app.show_help = true;
        let (_, panes) = render_with_panes(&app, 100, 20);
        assert!(panes.files.is_none());
        assert_eq!(panes.diff.width, 0);
    }

    #[test]
    fn the_footer_says_how_to_get_the_mouse_back_only_once_it_is_gone() {
        let mut app = app();
        let screen = render(&app, 100, 12);
        assert!(screen[11].contains("f files"), "{:?}", screen[11]);
        assert!(!screen[11].contains("mouse"), "{:?}", screen[11]);
        app.apply(Action::ToggleMouse, 10);
        let screen = render(&app, 100, 12);
        assert!(screen[11].contains("m mouse off"), "{:?}", screen[11]);
    }

    fn comment(line: u32, body: &str) -> krit_core::types::ReviewComment {
        krit_core::types::ReviewComment {
            id: format!("c{line}"),
            file_path: "src/a.rs".into(),
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

    #[test]
    fn a_comment_is_drawn_under_its_line_and_counted_in_the_header() {
        // PATCH's new-side line 11 is the "+    is()" row.
        let mut app = app();
        app.set_comments(vec![comment(11, "this name is doing two jobs")], 10);
        let screen = render(&app, 100, 20);
        let at = screen
            .iter()
            .position(|l| l.contains("this name is doing two jobs"))
            .expect("the body is on screen");
        assert!(
            screen[at - 1].contains("┌ open  11"),
            "{:?}",
            screen[at - 1]
        );
        assert!(
            screen[at - 2].contains("+     is()"),
            "{:?}",
            screen[at - 2]
        );
        assert!(screen[0].contains("1 comment"), "{:?}", screen[0]);
    }

    #[test]
    fn a_queued_comment_says_so_in_the_header_as_well_as_on_the_badge() {
        // It is the reviewer's own unposted work; the agent cannot see it yet,
        // and finding out only by scrolling past it is how it gets forgotten.
        let mut app = app();
        let mut c = comment(12, "not yet");
        c.status = "queued".into();
        app.set_comments(vec![c], 10);
        let screen = render(&app, 100, 20);
        assert!(
            screen[0].contains("1 comment (1 queued)"),
            "{:?}",
            screen[0]
        );
        assert!(screen.iter().any(|l| l.contains("┌ queued")), "{screen:?}");
    }

    #[test]
    fn a_narrower_pane_rewraps_the_body_rather_than_clipping_it() {
        // Comment bodies wrap to the pane, so the row model depends on the
        // width — and `set_panes` is what notices, since hiding the file list
        // widens the pane without resizing the terminal.
        let mut app = app();
        let long = "a body long enough that it wraps to a different number of \
                    lines in a wide pane than it does in a narrow one, which is \
                    the whole point of measuring it here";
        app.set_comments(vec![comment(11, long)], 10);
        let (_, wide) = render_with_panes(&app, 120, 20);
        assert!(app.set_panes(wide), "the first frame settles the width");
        let tall = app.rows.len();

        let (_, narrow) = render_with_panes(&app, 100, 20);
        assert!(app.set_panes(narrow), "a narrower pane is a taller comment");
        assert!(
            app.rows.len() > tall,
            "{} rows at 120 columns, {} at 100",
            tall,
            app.rows.len()
        );
        // Nothing overflows: every line still fits the pane it was wrapped to.
        for line in render(&app, 100, 20) {
            assert!(display_width(&line) <= 100, "{line:?}");
        }
    }

    #[test]
    fn a_comment_the_diff_cannot_place_is_still_visible() {
        // On a line no hunk carries, so there is no code row to hang it off.
        let mut app = app();
        app.set_comments(vec![comment(900, "from an older shape of this file")], 10);
        let screen = render(&app, 100, 20);
        let at = screen
            .iter()
            .position(|l| l.contains("from an older shape"))
            .expect("shown somewhere rather than dropped");
        assert!(
            screen[at - 1].contains("┌ open  900"),
            "{:?}",
            screen[at - 1]
        );
    }

    #[test]
    fn a_comment_on_a_file_outside_the_review_is_counted_in_the_header() {
        // It occupies no row — there is no file to hang it off — so the header
        // is the only place it can be said to exist. The total counts it either
        // way, and a number nothing on screen accounts for is what sends a
        // reviewer hunting for a comment that is not there.
        let mut app = app();
        let mut gone = comment(3, "on a file this range dropped");
        gone.file_path = "vanished.rs".into();
        app.set_comments(vec![comment(12, "here"), gone], 10);
        let header = render(&app, 100, 20)[0].clone();
        assert!(header.contains("2 comments"), "{header:?}");
        assert!(header.contains("(1 elsewhere)"), "{header:?}");
    }

    #[test]
    fn folding_a_file_says_how_much_conversation_went_with_it() {
        let mut app = app();
        app.set_comments(vec![comment(12, "a note")], 10);
        app.apply(Action::ToggleCollapse, 10);
        let all = render(&app, 100, 20).join("\n");
        assert!(all.contains("1 hunk, 1 comment hidden"), "{all}");
        assert!(
            !all.contains("a note"),
            "the body went with the body: {all}"
        );
    }

    // ---- the composer ---------------------------------------------------

    fn composing(app: &mut App, body: &str) {
        let anchor = app.comment_anchor().expect("the cursor is on code");
        app.compose = Some(Composer::new(
            crate::compose::Target::Comment(Box::new(anchor)),
            body,
        ));
    }

    #[test]
    fn the_composer_takes_rows_from_the_diff_rather_than_covering_it() {
        // What is being commented on has to stay readable while it is being
        // written about — and the cursor has to still be in what is left.
        let mut app = app();
        app.apply(Action::Down(4), 10);
        let before = render_with_panes(&app, 100, 20).1;
        composing(&mut app, "this name is doing two jobs");

        let (screen, panes) = render_with_panes(&app, 100, 20);
        assert!(panes.diff.height < before.diff.height, "the diff shrank");
        // The claim the comment above makes, asserted directly: after the loop
        // reconciles the smaller pane, the cursor is inside it. Written as a
        // disjunction with `set_panes`'s return value it could not fail for
        // that reason — the invalidated flag satisfied it on its own.
        app.set_panes(panes);
        let visible = app.offset..app.offset + panes.diff.height as usize;
        assert!(
            visible.contains(&app.cursor),
            "cursor {} outside {visible:?}",
            app.cursor
        );
        let all = screen.join("\n");
        assert!(all.contains("this name is doing two jobs"), "{all}");
        assert!(all.contains("ctrl-s post"), "{all}");
        assert!(all.contains("Comment on src/a.rs"), "{all}");
        // And the diff is still there above it.
        assert!(all.contains("src/a.rs"), "{all}");
    }

    #[test]
    fn the_footer_promises_ctrl_enter_only_where_the_terminal_can_deliver_it() {
        // A legacy terminal reports Ctrl+Enter as a bare Enter, so promising
        // the binding there would be promising a newline.
        let mut app = app();
        app.apply(Action::Down(4), 10);
        composing(&mut app, "x");
        let plain = render(&app, 100, 20).join("\n");
        assert!(plain.contains("ctrl-s post"), "{plain}");
        assert!(!plain.contains("ctrl-enter"), "{plain}");

        let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
        let theme = Theme { color: true };
        terminal
            .draw(|f| {
                draw(f, &app, &theme, true);
            })
            .unwrap();
        let enhanced = rows_of(terminal.backend().buffer()).join("\n");
        assert!(enhanced.contains("ctrl-s / ctrl-enter post"), "{enhanced}");
    }

    #[test]
    fn the_discard_question_is_a_strip_and_the_diff_keeps_drawing_behind_it() {
        // The terminal reading of the ban on `confirm()`: a program that stops
        // redrawing until someone answers deadlocks whatever is driving it.
        let mut app = app();
        app.apply(Action::Down(4), 10);
        composing(&mut app, "half a thought");
        app.compose.as_mut().unwrap().confirm_discard = true;
        let screen = render(&app, 100, 20);
        let all = screen.join("\n");
        assert!(all.contains("Discard what you have written?"), "{all}");
        assert!(all.contains("half a thought"), "the text is still there");
        assert!(all.contains("src/a.rs"), "and so is the diff");
    }

    #[test]
    fn a_selection_shows_what_c_would_comment_on() {
        let mut app = app();
        app.apply(Action::Down(4), 10);
        app.apply(Action::ToggleVisual, 10);
        app.apply(Action::Down(1), 10);
        let screen = render(&app, 100, 20);
        assert!(screen[19].contains("c comment"), "{:?}", screen[19]);
        assert!(screen[19].contains("src/a.rs lines"), "{:?}", screen[19]);
    }

    #[test]
    fn a_long_path_loses_its_middle_not_its_name() {
        assert_eq!(elide_left("a/b/c.rs", 20), "a/b/c.rs");
        assert_eq!(
            elide_left("src/ui/hooks/useComments.ts", 16),
            "…/useComments.ts"
        );
        assert_eq!(
            display_width(&elide_left("src/ui/hooks/useComments.ts", 16)),
            16
        );
        assert_eq!(elide_left("anything", 1), "…");
        assert_eq!(elide_left("anything", 0), "");
    }
}
