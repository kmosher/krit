//! Direct-manipulation edits: splice a character range out of (or back into)
//! a working-tree file. 1-based lines, 0-based columns, end_column exclusive
//! — the same convention as the schema v3 comment fields.

use crate::git::write_working_tree_file;
use crate::pathsafe::is_safe_path;
use std::path::Path;

pub struct DeleteRange {
    pub file_path: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// Removes the range and writes the file back. Returns the deleted text (for
/// the undo buffer / user-edit event), or None if the path is unsafe, the
/// file is unreadable, or the range no longer fits the file on disk — the
/// range was computed against whatever the browser last rendered, which may
/// have drifted by the time the request lands.
pub fn splice_delete_range(repo_root: &Path, range: &DeleteRange) -> Option<String> {
    if !is_safe_path(&range.file_path) {
        return None;
    }
    let content = std::fs::read_to_string(repo_root.join(&range.file_path)).ok()?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let start_idx = range.start_line.checked_sub(1)? as usize;
    let end_idx = range.end_line.checked_sub(1)? as usize;
    if end_idx >= lines.len() || start_idx > end_idx {
        return None;
    }
    let first_line = lines[start_idx].clone();
    let last_line = lines[end_idx].clone();
    let (sc, ec) = (range.start_column as usize, range.end_column as usize);
    if sc > first_line.len() || ec > last_line.len() {
        return None;
    }
    if start_idx == end_idx && sc > ec {
        return None;
    }

    let (deleted, merged) = if start_idx == end_idx {
        (
            first_line[sc..ec].to_string(),
            format!("{}{}", &first_line[..sc], &first_line[ec..]),
        )
    } else {
        let mut deleted = vec![first_line[sc..].to_string()];
        deleted.extend(lines[start_idx + 1..end_idx].iter().cloned());
        deleted.push(last_line[..ec].to_string());
        (
            deleted.join("\n"),
            format!("{}{}", &first_line[..sc], &last_line[ec..]),
        )
    };

    lines.splice(start_idx..=end_idx, [merged]);
    if !write_working_tree_file(repo_root, &range.file_path, &lines.join("\n")) {
        return None;
    }
    Some(deleted)
}

/// Inverse of splice_delete_range: re-inserts `text` at its removal point.
/// Only correct if nothing else touched that position since — accepted
/// tradeoff for a simple undo buffer (no OT reconciliation).
pub fn splice_insert_text(
    repo_root: &Path,
    file_path: &str,
    start_line: u32,
    start_column: u32,
    text: &str,
) -> bool {
    if !is_safe_path(file_path) {
        return false;
    }
    let Ok(content) = std::fs::read_to_string(repo_root.join(file_path)) else {
        return false;
    };
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
    let Some(idx) = start_line.checked_sub(1).map(|n| n as usize) else {
        return false;
    };
    if idx >= lines.len() {
        return false;
    }
    let line = lines[idx].clone();
    let col = start_column as usize;
    if col > line.len() {
        return false;
    }

    let inserted: Vec<&str> = text.split('\n').collect();
    if inserted.len() == 1 {
        lines[idx] = format!("{}{}{}", &line[..col], text, &line[col..]);
    } else {
        let mut new_lines: Vec<String> = inserted.iter().map(|s| s.to_string()).collect();
        new_lines[0] = format!("{}{}", &line[..col], new_lines[0]);
        let last = new_lines.len() - 1;
        new_lines[last] = format!("{}{}", new_lines[last], &line[col..]);
        lines.splice(idx..=idx, new_lines);
    }
    write_working_tree_file(repo_root, file_path, &lines.join("\n"))
}
