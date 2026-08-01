//! Syntax highlighting, from whole files rather than from hunks.
//!
//! **The whole file is the unit, and that is not an optimisation.** Syntax is
//! stateful down a file — a block comment, a raw string, a heredoc all run
//! past the line that opens them — so a hunk highlighted on its own starts
//! from a parse state nobody established. A hunk that opens inside a block
//! comment then renders as code: not an error, not a blank, just confidently
//! the wrong colors on the lines a reviewer is reading most closely. krit
//! already carries what fixes it, because `/api/diff` bundles `fileContents`
//! for gap expansion — so both sides of every file are already here, and
//! highlighting them entire costs one pass and no extra request.
//!
//! What that leaves is the files with no text on the wire: a binary, an
//! oversize refusal, a side that does not exist. Those get no highlighting at
//! all rather than a per-hunk approximation, on the same grounds — nothing is
//! easier to trust wrongly than plausible colors.
//!
//! Highlighting runs on the fetch thread, never in the draw loop. It is the
//! one piece of per-review work that scales with the *content* of the review
//! rather than its shape, and `docs/design/tui.md`'s rule is that the program
//! never stops redrawing while it waits.

use crate::client::{FileSides, SideText};
use crate::rows::Side;
use crate::text::cluster_advance;
use ratatui::style::Color;
use std::collections::HashMap;
use syntect::easy::HighlightLines;
use syntect::highlighting::{FontStyle, Theme};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use unicode_segmentation::UnicodeSegmentation;

/// A run of one line, in **display columns** — the same space `expand_tabs`
/// and `slice_columns` work in, so the renderer can clip it against `h_scroll`
/// without converting anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    pub from: usize,
    pub to: usize,
    pub color: Color,
    pub bold: bool,
}

/// Every line of one side of one file. Indexed by zero-based line number, so a
/// lookup is `lines.get(n - 1)` against a one-based diff line.
pub type FileRuns = Vec<Vec<Run>>;

/// How much color the terminal will take.
///
/// Measured once from the environment rather than per frame. `None` is not
/// merely "draw it grey": it is the signal to skip loading the syntax set
/// entirely, which is most of what highlighting costs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Depth {
    None,
    Ansi16,
    Ansi256,
    True,
}

/// Read the terminal's color support off the environment.
///
/// `NO_COLOR` wins over everything, per the convention: its presence means no
/// color whatever its value, including empty. Otherwise `COLORTERM` is the
/// only positive statement of truecolor there is, and `TERM` carrying `256`
/// is the long-standing way a terminfo name says 256.
pub fn depth_from_env() -> Depth {
    if std::env::var_os("NO_COLOR").is_some() {
        return Depth::None;
    }
    // The one terminfo name that means "assume nothing".
    if let Ok("dumb") = std::env::var("TERM").as_deref() {
        return Depth::None;
    }
    if let Ok("truecolor") | Ok("24bit") = std::env::var("COLORTERM").as_deref() {
        return Depth::True;
    }
    match std::env::var("TERM") {
        Ok(term) if term.contains("256") => Depth::Ansi256,
        Ok(_) => Depth::Ansi16,
        // No TERM at all is not a terminal we should be guessing about.
        Err(_) => Depth::None,
    }
}

/// The theme used when the reviewer names none.
///
/// A terminal does not report its background color reliably, so no default can
/// be right for both a light and a dark one. This picks the dark side because
/// that is where most terminals are, and `KRIT_THEME` is the way out — on a
/// light background `KRIT_THEME=ansi` is the best answer, since the `ansi`
/// theme paints in the reviewer's own palette and so cannot clash with it.
const DEFAULT_THEME: &str = "TwoDark";

/// The theme to use at 16 colors, whatever was asked for.
///
/// A themed color downsampled to 16 is a guess about a palette we cannot see;
/// `ansi` names the palette entries directly and lets the terminal decide what
/// they look like, which is the only thing that can be right on a terminal
/// whose colors the reviewer chose.
const ANSI_THEME: &str = "ansi";

pub struct Highlighter {
    syntaxes: SyntaxSet,
    theme: Theme,
    depth: Depth,
}

impl Highlighter {
    /// Load the syntax and theme sets, or `None` when there is no color to
    /// spend them on.
    ///
    /// `name` is matched case- and space-insensitively against the embedded
    /// theme names, so `KRIT_THEME=solarized-dark` and `Solarized (dark)` are
    /// the same request. An unknown name falls back to the default rather than
    /// failing: a typo in an environment variable should cost the reviewer
    /// their preferred colors, not their review.
    pub fn new(depth: Depth, name: Option<&str>) -> Option<Self> {
        if depth == Depth::None {
            return None;
        }
        let themes = two_face::theme::extra();
        let wanted = if depth == Depth::Ansi16 {
            ANSI_THEME
        } else {
            name.unwrap_or(DEFAULT_THEME)
        };
        let pick = theme_named(wanted).unwrap_or_else(|| {
            theme_named(DEFAULT_THEME).expect("the default theme is one two-face embeds")
        });
        Some(Highlighter {
            syntaxes: two_face::syntax::extra_newlines(),
            theme: themes.get(pick).clone(),
            depth,
        })
    }

    /// Highlight one side of one file.
    ///
    /// `path` picks the syntax by extension, falling back to the file's first
    /// line (which is what catches a `#!` script with no extension at all — a
    /// real shape in every repo). A file whose language is not recognised gets
    /// an empty result rather than plain-text runs, so the renderer can skip
    /// the whole overlay for it.
    pub fn file(&self, path: &str, text: &str, tab_size: usize) -> FileRuns {
        let syntax = path
            .rsplit_once('.')
            .and_then(|(_, ext)| self.syntaxes.find_syntax_by_extension(ext))
            .or_else(|| self.syntaxes.find_syntax_by_first_line(text));
        let Some(syntax) = syntax else {
            return Vec::new();
        };
        let mut state = HighlightLines::new(syntax, &self.theme);
        let mut out = Vec::new();
        for line in LinesWithEndings::from(text) {
            // A line that fails to parse ends the file rather than poisoning
            // the rest: the parse state is gone at that point, so every line
            // after it would be highlighted from a state nobody established —
            // which is the exact failure this module exists to avoid.
            let Ok(runs) = state.highlight_line(line, &self.syntaxes) else {
                break;
            };
            out.push(self.runs_of(&runs, tab_size));
        }
        out
    }

    /// Convert one line's syntect runs into display-column runs.
    ///
    /// The column walk mirrors `expand_tabs` through the shared
    /// `cluster_advance`, which is what keeps a tab from shifting the tint off
    /// the text it belongs to.
    fn runs_of(&self, runs: &[(syntect::highlighting::Style, &str)], tab_size: usize) -> Vec<Run> {
        let mut col = 0;
        let mut out: Vec<Run> = Vec::new();
        for (style, text) in runs {
            let from = col;
            for g in text.graphemes(true) {
                // The newline `LinesWithEndings` kept is real text to syntect
                // and no width at all here.
                if g == "\n" || g == "\r\n" {
                    continue;
                }
                col += cluster_advance(g, col, tab_size);
            }
            if col == from {
                continue;
            }
            let run = Run {
                from,
                to: col,
                color: self.color(style.foreground),
                bold: style.font_style.contains(FontStyle::BOLD),
            };
            // Coalesce, because a themed line is mostly one color in several
            // scopes and every run is a `Span` the renderer allocates.
            match out.last_mut() {
                Some(last) if last.color == run.color && last.bold == run.bold => last.to = run.to,
                _ => out.push(run),
            }
        }
        out
    }

    /// Map a theme color onto what this terminal can show.
    ///
    /// The alpha channel is not opacity here. bat's `ansi` theme — which
    /// two-face ships — encodes palette *indices* in themes by dropping alpha
    /// below opaque, so a color with `a < 255` names a slot in the reviewer's
    /// palette rather than an RGB value, and rendering it as RGB paints the
    /// whole review black. That is not a hypothetical: `ansi`'s first color is
    /// `r/g/b/a = 0/0/0/1`.
    fn color(&self, c: syntect::highlighting::Color) -> Color {
        if c.a < 255 {
            return Color::Indexed(c.r);
        }
        match self.depth {
            Depth::True => Color::Rgb(c.r, c.g, c.b),
            Depth::Ansi256 => Color::Indexed(ansi256_of(c.r, c.g, c.b)),
            // Only reachable for a theme that is not `ansi`, i.e. one the
            // reviewer named explicitly at 16 colors.
            Depth::Ansi16 | Depth::None => Color::Indexed(ansi256_of(c.r, c.g, c.b)),
        }
    }
}

/// Find an embedded theme by a forgiving name.
fn theme_named(name: &str) -> Option<two_face::theme::EmbeddedThemeName> {
    let want = normalize(name);
    two_face::theme::EmbeddedLazyThemeSet::theme_names()
        .iter()
        .copied()
        .find(|t| normalize(t.as_name()) == want)
}

fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Nearest xterm-256 index for an RGB triple.
///
/// The 6×6×6 cube and the 24-step grey ramp are compared rather than assuming
/// the cube wins: a near-grey lands much closer on the ramp, and syntax themes
/// are full of near-greys (comments, punctuation).
fn ansi256_of(r: u8, g: u8, b: u8) -> u8 {
    let cube_index = |v: u8| -> u8 {
        // The cube's levels are 0, 95, 135, 175, 215, 255 — not evenly spaced,
        // which is why this is a table rather than a division.
        const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
        let mut best = 0;
        let mut best_d = u32::MAX;
        for (i, l) in LEVELS.iter().enumerate() {
            let d = (*l as i32 - v as i32).unsigned_abs();
            if d < best_d {
                best_d = d;
                best = i as u8;
            }
        }
        best
    };
    const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let (ri, gi, bi) = (cube_index(r), cube_index(g), cube_index(b));
    let cube = (
        16 + 36 * ri + 6 * gi + bi,
        dist(
            (r, g, b),
            (
                LEVELS[ri as usize],
                LEVELS[gi as usize],
                LEVELS[bi as usize],
            ),
        ),
    );
    // Grey ramp: 232..=255 at 8 + 10n.
    let grey_step = ((r as u32 + g as u32 + b as u32) / 3).saturating_sub(8) / 10;
    let grey_step = grey_step.min(23) as u8;
    let grey_value = 8 + 10 * grey_step;
    let grey = (
        232 + grey_step,
        dist((r, g, b), (grey_value, grey_value, grey_value)),
    );
    if grey.1 < cube.1 { grey.0 } else { cube.0 }
}

fn dist(a: (u8, u8, u8), b: (u8, u8, u8)) -> u32 {
    let d = |x: u8, y: u8| {
        let d = x as i32 - y as i32;
        (d * d) as u32
    };
    d(a.0, b.0) + d(a.1, b.1) + d(a.2, b.2)
}

/// Highlight every file in a `/api/diff` response.
///
/// A side with no `contents` — a binary, an oversize refusal, the missing
/// pre-image of an added file — highlights to nothing, which the renderer
/// reads as "leave this file alone" rather than as an error.
pub fn of_payload(
    highlighter: &Highlighter,
    contents: &HashMap<String, FileSides>,
    tab_size: usize,
) -> Highlights {
    let mut out = Highlights::default();
    for (path, sides) in contents {
        let one = |side: &SideText| {
            side.contents
                .as_deref()
                .map(|text| highlighter.file(path, text, tab_size))
                .unwrap_or_default()
        };
        out.insert(path, one(&sides.new), one(&sides.old));
    }
    out
}

/// Every file's runs, keyed the way the renderer asks for them.
///
/// Both sides are kept because a diff shows both: a deletion row's text is the
/// *old* file's line, and highlighting it against the new file would tint text
/// that is not there.
#[derive(Clone, Debug, Default)]
pub struct Highlights {
    new_side: HashMap<String, FileRuns>,
    old_side: HashMap<String, FileRuns>,
}

impl Highlights {
    pub fn insert(&mut self, path: &str, new_side: FileRuns, old_side: FileRuns) {
        if !new_side.is_empty() {
            self.new_side.insert(path.to_string(), new_side);
        }
        if !old_side.is_empty() {
            self.old_side.insert(path.to_string(), old_side);
        }
    }

    /// The runs for a one-based line on one side, if there are any.
    ///
    /// `width` is the display width of the line as the *patch* carries it, and
    /// it has to match the extent the runs cover — which is the width of the
    /// same line as the *file* carries it. The two arrive in one `/api/diff`
    /// response and normally agree; when they do not, the file moved under the
    /// response and every line below the edit is off by however far it moved.
    /// Refusing is the point: colors are the one thing here that can be wrong
    /// without looking wrong, and a whole file tinted one line out of step
    /// reads as a theme quirk rather than as stale data.
    pub fn runs(&self, path: &str, side: Side, line: u32, width: usize) -> Option<&[Run]> {
        let map = match side {
            Side::New => &self.new_side,
            Side::Old => &self.old_side,
        };
        let runs = map.get(path)?.get(line.checked_sub(1)? as usize)?;
        // An empty line covers no columns and is trivially in agreement.
        match runs.last() {
            Some(last) if last.to == width => Some(runs),
            None if width == 0 => Some(runs),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{display_width, expand_tabs};

    #[test]
    fn a_color_below_full_alpha_is_a_palette_index_not_an_rgb_value() {
        // The trap that paints a whole review black. bat's `ansi` theme, which
        // two-face ships, encodes palette slots by dropping alpha below opaque,
        // so reading one as RGB gives near-black for every scope in the file.
        let h = Highlighter::new(Depth::True, Some("ansi")).expect("color is on");
        let indexed = syntect::highlighting::Color {
            r: 4,
            g: 0,
            b: 0,
            a: 1,
        };
        assert_eq!(h.color(indexed), Color::Indexed(4));
        let opaque = syntect::highlighting::Color {
            r: 10,
            g: 20,
            b: 30,
            a: 255,
        };
        assert_eq!(h.color(opaque), Color::Rgb(10, 20, 30));
    }

    #[test]
    fn no_color_declines_to_build_a_highlighter_at_all() {
        // Not merely "draw it grey": loading the syntax set is nearly all of
        // what highlighting costs, and under NO_COLOR none of it is spendable.
        assert!(Highlighter::new(Depth::None, None).is_none());
    }

    #[test]
    fn an_unknown_theme_name_costs_the_colors_asked_for_not_the_review() {
        assert!(Highlighter::new(Depth::True, Some("no such theme")).is_some());
    }

    #[test]
    fn a_theme_name_matches_however_it_was_typed() {
        assert!(theme_named("TwoDark").is_some());
        assert_eq!(
            theme_named("solarized-dark"),
            theme_named("Solarized (dark)")
        );
        assert_eq!(theme_named("ANSI"), theme_named("ansi"));
    }

    #[test]
    fn sixteen_colors_forces_the_ansi_theme_whatever_was_asked_for() {
        // A themed color downsampled to sixteen is a guess about a palette we
        // cannot see; `ansi` names the slots and lets the terminal decide.
        let h = Highlighter::new(Depth::Ansi16, Some("GruvboxDark")).expect("color is on");
        let two_face = two_face::theme::extra();
        assert_eq!(
            h.theme.name,
            two_face
                .get(theme_named(ANSI_THEME).expect("two-face embeds ansi"))
                .name
        );
    }

    #[test]
    fn a_run_ends_where_expand_tabs_says_the_line_ends() {
        // The invariant `cluster_advance` exists for. These two walks are the
        // renderer's and the highlighter's; if they disagree about a tab, the
        // tint lands beside the text it belongs to and nothing errors.
        let h = Highlighter::new(Depth::True, None).expect("color is on");
        let line = "\tlet x = 1;";
        let runs = h.file("a.rs", &format!("fn a() {{}}\n{line}\n"), 4);
        assert_eq!(runs.len(), 2, "one entry per line");
        assert_eq!(
            runs[1].last().expect("the line has runs").to,
            display_width(&expand_tabs(line, 4)),
        );
        assert_eq!(runs[1].first().expect("the line has runs").from, 0);
    }

    #[test]
    fn a_file_in_no_known_language_highlights_to_nothing() {
        let h = Highlighter::new(Depth::True, None).expect("color is on");
        assert!(h.file("a.wobble", "nothing claims this\n", 4).is_empty());
    }

    #[test]
    fn runs_are_refused_when_the_patch_and_the_file_disagree_about_the_line() {
        // The file moved under the response, so every line below the edit is
        // off by however far it moved. Colors are the one thing here that can
        // be wrong without looking wrong.
        let mut hl = Highlights::default();
        let red = Run {
            from: 0,
            to: 5,
            color: Color::Red,
            bold: false,
        };
        hl.insert("a.rs", vec![vec![red]], Vec::new());
        assert!(hl.runs("a.rs", Side::New, 1, 5).is_some());
        assert!(
            hl.runs("a.rs", Side::New, 1, 9).is_none(),
            "width disagrees"
        );
        assert!(hl.runs("a.rs", Side::Old, 1, 5).is_none(), "other side");
        assert!(hl.runs("b.rs", Side::New, 1, 5).is_none(), "other file");
        assert!(
            hl.runs("a.rs", Side::New, 0, 5).is_none(),
            "lines are 1-based"
        );
    }
}
