//! The unified patch `/api/diff` serves, read into files, hunks and lines.
//!
//! The server hands out a patch string rather than a structured diff, because
//! the web UI feeds that string straight to Pierre. A terminal client has no
//! Pierre, so this is where the structure comes from.
//!
//! The patch is not always git's own output. `git.rs` concatenates the
//! unstaged diff, the staged diff, and a *synthesized* new-file patch per
//! untracked file, joined with `\n` — so blank lines appear between file
//! sections, and a synthesized hunk header can read `@@ -0,0 +1,N @@`. Hunk
//! bodies are therefore delimited by the counts in their own header rather
//! than by "the first line that doesn't start with a diff marker", which a
//! blank separator would end early.

use krit_core::patch::diff_header_path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Untracked,
    Deleted,
    Renamed,
    Modified,
}

impl ChangeKind {
    /// A distinct *shape* per change type, not a distinct color — see the rule
    /// at the head of `ui`.
    pub fn sigil(self) -> char {
        match self {
            ChangeKind::Added => 'A',
            ChangeKind::Untracked => '?',
            ChangeKind::Deleted => 'D',
            ChangeKind::Renamed => 'R',
            ChangeKind::Modified => 'M',
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    /// 1-based line number on the deletions side; `None` on an addition.
    pub old_line: Option<u32>,
    /// 1-based line number on the additions side; `None` on a deletion.
    pub new_line: Option<u32>,
    /// The line's text, without the leading `+`/`-`/space marker.
    pub text: String,
    /// Git said `\ No newline at end of file` about this line.
    pub no_newline: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: u32,
    pub old_len: u32,
    pub new_start: u32,
    pub new_len: u32,
    /// Whatever trails the closing `@@` — usually the enclosing function.
    pub section: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileDiff {
    /// The new-side path, which is the key everything else in krit uses.
    pub path: String,
    /// The old-side path, present only on a rename.
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    /// Binary files carry no hunks — git says only that they differ.
    pub binary: bool,
    pub hunks: Vec<Hunk>,
    /// Counted once, here, because the header and every file row ask for them
    /// and the draw loop runs ten times a second: as methods they walked every
    /// line of every hunk per frame, which scales with the review rather than
    /// with the window.
    pub additions: usize,
    pub deletions: usize,
}

impl FileDiff {
    fn count(&self, kind: LineKind) -> usize {
        self.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == kind)
            .count()
    }

    fn tally(&mut self) {
        self.additions = self.count(LineKind::Addition);
        self.deletions = self.count(LineKind::Deletion);
    }
}

/// `@@ -12,7 +12,9 @@ fn thing()` → the four numbers and the section text.
/// A side with no comma is one line long (`@@ -1 +1 @@`), and a side with an
/// explicit `,0` covers nothing — which is how a new file's deletions side
/// reads.
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, String)> {
    let rest = line.strip_prefix("@@ ")?;
    let (ranges, tail) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(' ')?;
    let (old_start, old_len) = parse_range(old.strip_prefix('-')?)?;
    let (new_start, new_len) = parse_range(new.strip_prefix('+')?)?;
    Some((
        old_start,
        old_len,
        new_start,
        new_len,
        tail.trim_start().to_string(),
    ))
}

fn parse_range(spec: &str) -> Option<(u32, u32)> {
    match spec.split_once(',') {
        Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
        None => Some((spec.parse().ok()?, 1)),
    }
}

/// Parse a whole patch. `untracked` is the payload's `untrackedFiles`, and it
/// refines a new file to `Untracked` — the server draws the same added-vs-
/// untracked distinction for binaries in `binaryFiles`, and it is worth
/// keeping because "I have not added this yet" reads differently from "I added
/// it".
pub fn parse_patch(patch: &str, untracked: &[String]) -> Vec<FileDiff> {
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut files: Vec<FileDiff> = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let Some(path) = diff_header_path(line) else {
            i += 1;
            continue;
        };
        i += 1;

        let mut file = FileDiff {
            path,
            old_path: None,
            kind: ChangeKind::Modified,
            binary: false,
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
        };

        // The preamble: mode lines, rename pair, index, ---/+++, and the
        // binary notice. Ends at the first hunk or the next file.
        while i < lines.len() {
            let l = lines[i];
            if l.starts_with("@@ ") || diff_header_path(l).is_some() {
                break;
            }
            if l.starts_with("new file mode") {
                file.kind = if untracked.iter().any(|u| u == &file.path) {
                    ChangeKind::Untracked
                } else {
                    ChangeKind::Added
                };
            } else if l.starts_with("deleted file mode") {
                file.kind = ChangeKind::Deleted;
            } else if let Some(from) = l.strip_prefix("rename from ") {
                file.kind = ChangeKind::Renamed;
                file.old_path = Some(from.to_string());
            } else if l.starts_with("Binary files ") || l.starts_with("GIT binary patch") {
                file.binary = true;
            }
            i += 1;
        }

        while i < lines.len() && lines[i].starts_with("@@ ") {
            if let Some((old_start, old_len, new_start, new_len, section)) =
                parse_hunk_header(lines[i])
            {
                i += 1;
                let (hunk_lines, consumed) =
                    parse_hunk_body(&lines[i..], old_start, old_len, new_start, new_len);
                i += consumed;
                file.hunks.push(Hunk {
                    old_start,
                    old_len,
                    new_start,
                    new_len,
                    section,
                    lines: hunk_lines,
                });
            } else {
                // An `@@` line we can't read is not a hunk. Skipping it rather
                // than aborting the file keeps one malformed header from
                // swallowing every hunk after it.
                i += 1;
            }
        }

        file.tally();
        files.push(file);
    }

    files
}

/// Consume exactly the lines the header accounts for. Returns the lines and
/// how many entries of `rest` were used.
fn parse_hunk_body(
    rest: &[&str],
    old_start: u32,
    old_len: u32,
    new_start: u32,
    new_len: u32,
) -> (Vec<DiffLine>, usize) {
    let mut out: Vec<DiffLine> = Vec::new();
    let mut old_no = old_start;
    let mut new_no = new_start;
    let mut old_left = old_len;
    let mut new_left = new_len;
    let mut used = 0;

    while used < rest.len() && (old_left > 0 || new_left > 0) {
        let line = rest[used];
        // A new file section always ends the hunk, however the counts look —
        // a truncated patch must not eat the file after it.
        if diff_header_path(line).is_some() || line.starts_with("@@ ") {
            break;
        }
        used += 1;

        // "\ No newline at end of file" annotates the line above and consumes
        // no count of its own.
        if line.starts_with('\\') {
            if let Some(last) = out.last_mut() {
                last.no_newline = true;
            }
            continue;
        }

        let (kind, text) = match line.as_bytes().first() {
            Some(b'+') => (LineKind::Addition, &line[1..]),
            Some(b'-') => (LineKind::Deletion, &line[1..]),
            Some(b' ') => (LineKind::Context, &line[1..]),
            // A bare empty line inside the counted region is an empty context
            // line whose trailing space something stripped — common enough in
            // pasted and mailed patches to be worth tolerating.
            None => (LineKind::Context, line),
            // Anything else means the patch is not what the header claimed.
            _ => break,
        };

        let (old_line, new_line) = match kind {
            LineKind::Context => {
                let pair = (Some(old_no), Some(new_no));
                old_no = old_no.saturating_add(1);
                new_no = new_no.saturating_add(1);
                old_left = old_left.saturating_sub(1);
                new_left = new_left.saturating_sub(1);
                pair
            }
            LineKind::Addition => {
                let pair = (None, Some(new_no));
                new_no = new_no.saturating_add(1);
                new_left = new_left.saturating_sub(1);
                pair
            }
            LineKind::Deletion => {
                let pair = (Some(old_no), None);
                old_no = old_no.saturating_add(1);
                old_left = old_left.saturating_sub(1);
                pair
            }
        };

        out.push(DiffLine {
            kind,
            old_line,
            new_line,
            text: text.to_string(),
            no_newline: false,
        });
    }

    // A trailing "\ No newline" sits past the counted region, so the loop
    // above has already stopped. Claim it before returning.
    if used < rest.len() && rest[used].starts_with('\\') {
        if let Some(last) = out.last_mut() {
            last.no_newline = true;
        }
        used += 1;
    }

    (out, used)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODIFY: &str = "diff --git a/src/a.rs b/src/a.rs\n\
                          index 111..222 100644\n\
                          --- a/src/a.rs\n\
                          +++ b/src/a.rs\n\
                          @@ -10,4 +10,5 @@ fn thing() {\n\
                          \x20   let a = 1;\n\
                          -    let b = 2;\n\
                          +    let b = 3;\n\
                          +    let c = 4;\n\
                          \x20   done()\n\
                          \x20}";

    #[test]
    fn numbers_every_line_on_the_side_it_belongs_to() {
        let files = parse_patch(MODIFY, &[]);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "src/a.rs");
        assert_eq!(f.kind, ChangeKind::Modified);
        assert_eq!(f.additions, 2);
        assert_eq!(f.deletions, 1);

        let h = &f.hunks[0];
        assert_eq!(
            (h.old_start, h.old_len, h.new_start, h.new_len),
            (10, 4, 10, 5)
        );
        assert_eq!(h.section, "fn thing() {");

        // Context advances both sides; a deletion advances only the old and an
        // addition only the new, which is the whole reason both are carried.
        let numbering: Vec<(Option<u32>, Option<u32>)> =
            h.lines.iter().map(|l| (l.old_line, l.new_line)).collect();
        assert_eq!(
            numbering,
            vec![
                (Some(10), Some(10)),
                (Some(11), None),
                (None, Some(11)),
                (None, Some(12)),
                (Some(12), Some(13)),
                (Some(13), Some(14)),
            ]
        );
        assert_eq!(h.lines[2].text, "    let b = 3;");
    }

    #[test]
    fn a_blank_line_between_file_sections_does_not_swallow_the_next_file() {
        // `git.rs` joins the unstaged, staged and untracked patches with '\n',
        // so a blank line between sections is normal input, not corruption.
        let patch = format!("{MODIFY}\n\ndiff --git a/b.rs b/b.rs\n@@ -1 +1 @@\n-x\n+y");
        let files = parse_patch(&patch, &[]);
        assert_eq!(
            files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["src/a.rs", "b.rs"]
        );
        assert_eq!(files[1].hunks[0].lines.len(), 2);
    }

    #[test]
    fn a_synthesized_untracked_patch_reads_as_untracked() {
        // The shape `synthesize_untracked_patch` emits, including the `-0,0`
        // deletions side that a real git diff never produces.
        let patch = "diff --git a/new.txt b/new.txt\n\
                     new file mode 100644\n\
                     index 0000000..0000001\n\
                     --- /dev/null\n\
                     +++ b/new.txt\n\
                     @@ -0,0 +1,2 @@\n\
                     +one\n\
                     +two";
        let files = parse_patch(patch, &["new.txt".to_string()]);
        assert_eq!(files[0].kind, ChangeKind::Untracked);
        assert_eq!(files[0].hunks[0].lines[0].new_line, Some(1));
        assert_eq!(files[0].hunks[0].lines[1].new_line, Some(2));
        assert!(files[0].hunks[0].lines.iter().all(|l| l.old_line.is_none()));

        // The same patch for a file git *does* track is an ordinary addition.
        assert_eq!(parse_patch(patch, &[])[0].kind, ChangeKind::Added);
    }

    #[test]
    fn a_rename_keeps_both_paths() {
        let patch = "diff --git a/old.rs b/new.rs\n\
                     similarity index 95%\n\
                     rename from old.rs\n\
                     rename to new.rs\n\
                     @@ -1 +1 @@\n\
                     -a\n\
                     +b";
        let f = &parse_patch(patch, &[])[0];
        assert_eq!(f.kind, ChangeKind::Renamed);
        assert_eq!(f.path, "new.rs");
        assert_eq!(f.old_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn a_binary_file_parses_with_no_hunks_rather_than_being_dropped() {
        let patch = "diff --git a/img.png b/img.png\n\
                     new file mode 100644\n\
                     Binary files /dev/null and b/img.png differ";
        let f = &parse_patch(patch, &[])[0];
        assert!(f.binary);
        assert_eq!(f.kind, ChangeKind::Added);
        assert!(f.hunks.is_empty());
    }

    #[test]
    fn a_hunk_with_no_comma_covers_one_line_per_side() {
        let f = &parse_patch("diff --git a/a b/a\n@@ -7 +9 @@\n-x\n+y", &[])[0];
        let h = &f.hunks[0];
        assert_eq!((h.old_len, h.new_len), (1, 1));
        assert_eq!(h.lines[0].old_line, Some(7));
        assert_eq!(h.lines[1].new_line, Some(9));
    }

    #[test]
    fn no_newline_at_eof_annotates_the_line_above_and_ends_the_hunk() {
        let patch = "diff --git a/a b/a\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file";
        let h = &parse_patch(patch, &[])[0].hunks[0];
        // The marker consumes no line count of its own — three content lines.
        assert_eq!(h.lines.len(), 3);
        assert!(h.lines[1].no_newline, "deletion carries the marker");
        assert!(h.lines[2].no_newline, "so does the trailing addition");
    }

    #[test]
    fn several_hunks_in_one_file_each_start_at_their_own_offset() {
        let patch = "diff --git a/a b/a\n\
                     @@ -1,1 +1,1 @@\n\
                     -x\n\
                     +y\n\
                     @@ -50,1 +50,1 @@ fn other()\n\
                     -p\n\
                     +q";
        let f = &parse_patch(patch, &[])[0];
        assert_eq!(f.hunks.len(), 2);
        assert_eq!(f.hunks[1].lines[0].old_line, Some(50));
        assert_eq!(f.hunks[1].section, "fn other()");
    }

    #[test]
    fn a_path_containing_the_header_separator_survives_parsing() {
        // krit-core resolves the ambiguity; this checks the parser asks it
        // rather than splitting the header itself.
        let patch = "diff --git a/foo b/bar.rs b/foo b/bar.rs\n@@ -1 +1 @@\n-a\n+b";
        assert_eq!(parse_patch(patch, &[])[0].path, "foo b/bar.rs");
    }

    #[test]
    fn an_empty_patch_is_no_files_rather_than_one_empty_file() {
        assert!(parse_patch("", &[]).is_empty());
        assert!(parse_patch("\n\n", &[]).is_empty());
    }
}
