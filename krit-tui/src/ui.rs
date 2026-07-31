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
use crate::patch::{ChangeKind, LineKind};
use crate::rows::{Note, Row, line_marker, row_window, scroll_to_show, stat_label};
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
pub fn draw(frame: &mut Frame, app: &App, theme: &Theme) -> Panes {
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
    let text = format!(
        " krit  {}  {}{}   {} file{}  +{} −{}",
        app.repo,
        app.branch,
        scope,
        app.files.len(),
        if app.files.len() == 1 { "" } else { "s" },
        adds,
        dels,
    );
    Paragraph::new(Line::from(Span::styled(
        text,
        theme.fg(Color::Cyan).add_modifier(Modifier::BOLD),
    )))
}

fn footer<'a>(app: &App, theme: &Theme) -> Paragraph<'a> {
    let (text, style) = match &app.status {
        Status::Idle => (
            format!(
                " j/k move · n/p hunk · ]/[ file · z collapse · f files{} · r refresh · ? keys · q quit",
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

fn kind_color(kind: ChangeKind) -> Color {
    match kind {
        ChangeKind::Added | ChangeKind::Untracked => Color::Green,
        ChangeKind::Deleted => Color::Red,
        ChangeKind::Renamed => Color::Magenta,
        ChangeKind::Modified => Color::Yellow,
    }
}

/// The list widget, the rect its rows occupy (inside the border), and the
/// index of the file drawn on its first row. The last two are what make a
/// click resolvable — computed here because here is where they are decided.
fn file_pane<'a>(app: &App, theme: &Theme, area: Rect) -> (Paragraph<'a>, Rect, usize) {
    let current = app.current_file();
    let text_cols = FILE_PANE_WIDTH.saturating_sub(2) as usize;
    let visible = area.height.saturating_sub(2) as usize;
    // The same least-movement rule the diff pane scrolls by, fed the start the
    // last frame reported. Deriving a start from the current file alone can
    // only pin it to one edge — the previous version pinned it to the *last*
    // visible row, so no file below the cursor was ever on screen once the
    // review outgrew the pane.
    let start = scroll_to_show(
        app.panes.files_top,
        visible,
        current.unwrap_or(0),
        app.files.len(),
    );
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

/// The columns between the gutters and the code: one separator space, the
/// change marker, and one more space. Named because three row kinds have to
/// agree with it — a header that computed the width differently would drift
/// out of line with the code rows below it.
const MARKER_COLS: usize = 4;

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
    // old │ new │ marker │ text — a fixed prefix, so the code column never
    // moves as you scroll between files.
    let gutter = app.gutter;
    let text_width = pane_width.saturating_sub(gutter * 2 + MARKER_COLS);

    match app.rows[index] {
        // Padded and styled like every other row: a cursor parked on the gap
        // between two files would otherwise be invisible, since reverse video
        // over an empty string covers nothing.
        Row::Gap => Line::from(Span::styled(fit_columns("", pane_width), cursor)),
        Row::File { file } => {
            let f = &app.files[file];
            let text = format!(" {} {}  {}", f.kind.sigil(), f.path, stat_label(f));
            Line::from(Span::styled(
                fit_columns(&text, pane_width),
                theme
                    .fg(kind_color(f.kind))
                    .add_modifier(Modifier::BOLD)
                    .patch(cursor),
            ))
        }
        Row::Meta { file, note } => {
            let f = &app.files[file];
            let text = match note {
                Note::RenamedFrom => {
                    format!("   renamed from {}", f.old_path.as_deref().unwrap_or("?"))
                }
                Note::Binary => "   binary file — not shown".to_string(),
                Note::Collapsed => {
                    let n = f.hunks.len();
                    format!(
                        "   collapsed — {n} hunk{} hidden",
                        if n == 1 { "" } else { "s" }
                    )
                }
            };
            // Full width like the rows around it, so the cursor bar is a bar
            // rather than a fragment — that bar is the only cursor indicator
            // that survives NO_COLOR.
            Line::from(Span::styled(
                fit_columns(&text, pane_width),
                theme.dim().patch(cursor),
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
                theme.fg(Color::Cyan).patch(cursor),
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
            Line::from(vec![
                Span::styled(fit_columns(&num(l.old_line), gutter), gutter_style),
                Span::styled(" ", gutter_style),
                Span::styled(fit_columns(&num(l.new_line), gutter), gutter_style),
                Span::styled(format!(" {marker} "), style),
                Span::styled(visible, style),
            ])
        }
    }
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
        Line::from("  z, enter          collapse the current file"),
        Line::from("  tab               move between panes"),
        Line::from("  f                 show / hide the file list"),
        Line::from("  m                 release the mouse to the terminal"),
        Line::from("  wheel, click      scroll / put the cursor there"),
        Line::from("  r                 refetch the diff"),
        Line::from("  ctrl-z            suspend"),
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
        terminal.draw(|f| panes = draw(f, app, &theme)).unwrap();
        (rows_of(terminal.backend().buffer()), panes)
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
                draw(f, &app, &theme);
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
