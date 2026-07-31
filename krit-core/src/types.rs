//! The wire types: comments and the event protocol. Field names and event
//! tags are what the React UI and the Claude skill speak, so changing one
//! means changing them in the same breath — `src/types.ts` mirrors this file
//! and the UI switches over it exhaustively, so a rename shows up as a
//! TypeScript error rather than a silent mismatch.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentReply {
    pub id: String,
    pub body: String,
    pub created_at: u64,
    // 'user' = browser UI, 'agent' = CLI/agent. Missing (pre-field persisted
    // data) is treated as 'agent' by consumers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub new_lines: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub file_path: String,
    /// "deletions" | "additions"
    pub side: String,
    /// 1-based inclusive start; end_line is the inclusive end (== line_number
    /// for a single-line comment, and treated as such when absent).
    pub line_number: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Single line: that line's text. Range: the lines joined with '\n'.
    pub line_content: String,
    pub body: String,
    /// "open" | "resolved" | "queued". Queued comments are suppressed from
    /// every broadcast and agent-facing listing until posted. Stores written
    /// before the rename say "draft"; `store::load` migrates them.
    pub status: String,
    pub created_at: u64,
    pub replies: Vec<CommentReply>,
    /// GitHub-style staleness: re-anchoring lost this comment's text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outdated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<Suggestion>,
    // Schema v3 character-level anchor: all three present or none.
    // start_column 0-based into the first anchored line; end_column 0-based
    // *exclusive* into the last.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
}

impl ReviewComment {
    pub fn end_line_or_start(&self) -> u32 {
        self.end_line.unwrap_or(self.line_number)
    }
}

/// Comment text the reviewer is still typing — not a comment yet.
///
/// Distinct from a `ReviewComment` with `status: "queued"`, which *is* a
/// comment: submitted, stored, listable, and merely withheld from the agent
/// until posted. A `PendingDraft` has never been submitted at all. Both were
/// once called "draft"; "queued" took over the submitted one so that "draft"
/// can mean only this.
///
/// Identity is the anchor, not an id: one open form per file + side + line
/// range, which is already how the UI's `pending` map is keyed. A second draft
/// in the same slot is the same draft.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDraft {
    pub file_path: String,
    /// "deletions" | "additions"
    pub side: String,
    pub start_line: u32,
    pub end_line: u32,
    pub body: String,
    /// Whether the form's suggestion editor is open, and what is in it. Both are
    /// part of the draft: reopening on the body alone would silently drop a
    /// rewrite the reviewer had typed.
    #[serde(default)]
    pub suggest_mode: bool,
    #[serde(default)]
    pub suggestion_text: String,
    /// Whether `suggestion_text` was typed by the reviewer rather than seeded
    /// from the file. It cannot be recovered by comparison after the fact: by
    /// the time a draft is restored, the lines it was seeded from may be gone.
    #[serde(default)]
    pub suggestion_edited: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    pub updated_at: u64,
}

impl PendingDraft {
    /// The anchor tuple this draft is identified by.
    pub fn slot(&self) -> (&str, &str, u32, u32) {
        (&self.file_path, &self.side, self.start_line, self.end_line)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// Every frame on the SSE and ws streams. The serde tag IS the wire contract:
/// a malformed frame is unrepresentable here, which is half the reason krit
/// is written in Rust (the other half is the FSEvents watcher).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    State {
        watcher_count: usize,
        ui_count: usize,
        agent_count: usize,
    },
    Clients {
        browsers: usize,
    },
    CommentAdded {
        comment: ReviewComment,
    },
    CommentUpdated {
        comment: ReviewComment,
    },
    #[serde(rename_all = "camelCase")]
    ReplyAdded {
        comment_id: String,
        reply: CommentReply,
        comment_status: String,
    },
    FileChanged {
        path: String,
    },
    /// Coalesced fs-watcher output: one frame per debounce tick covering every
    /// file whose content actually changed, replacing the per-path
    /// `FileChanged` fanout on that path (see docs/design/reactive-loop-perf.md).
    /// `FileChanged` itself stays in the enum for other callers.
    FilesChanged {
        paths: Vec<String>,
    },
    FileWritten {
        path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    UserEdit {
        action: String,
        file_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        range: Option<EditRange>,
        #[serde(skip_serializing_if = "Option::is_none")]
        deleted_text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inserted_text: Option<String>,
    },
    Submitted {
        timestamp: u64,
        /// The reviewer's concluding notes, typed into the Done-reviewing box.
        /// Absent when they finished without writing any — which is a normal
        /// ending, not a degenerate one.
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    ReviewEnded {
        reason: EndReason,
    },
}

/// Why the server is exiting.
///
/// An enum rather than free text because a client has to act on it: a review
/// that ended because the reviewer finished it needs different words — and a
/// different level of alarm — from one whose backend was killed out from
/// under an open page. Adding a variant is a wire change; mirror it in
/// `src/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndReason {
    /// The reviewer clicked Done reviewing.
    Submitted,
    /// Every UI disconnected and the idle window elapsed.
    Idle,
    /// No UI ever connected — a launch that never reached a window.
    NoBrowser,
    /// SIGTERM or SIGINT. The one ending the reviewer did not ask for.
    Signal,
}

pub fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Snapshot tests pinning every Event variant's JSON — tag casing, field
// names, and optional-field absence. Changing a shape here is allowed; doing
// it without updating these, `src/types.ts` and the skill is what breaks the
// UI, and this is the test that makes you notice.
#[cfg(test)]
mod tests {
    use super::*;

    fn js(event: &Event) -> String {
        serde_json::to_string(event).unwrap()
    }

    #[test]
    fn event_wire_shapes() {
        assert_eq!(
            js(&Event::State {
                watcher_count: 1,
                ui_count: 2,
                agent_count: 3
            }),
            r#"{"type":"state","watcherCount":1,"uiCount":2,"agentCount":3}"#
        );
        assert_eq!(
            js(&Event::Clients { browsers: 2 }),
            r#"{"type":"clients","browsers":2}"#
        );
        assert_eq!(
            js(&Event::FileChanged {
                path: "a.rs".into()
            }),
            r#"{"type":"file-changed","path":"a.rs"}"#
        );
        assert_eq!(
            js(&Event::FilesChanged {
                paths: vec!["a.rs".into()]
            }),
            r#"{"type":"files-changed","paths":["a.rs"]}"#
        );
        assert_eq!(
            js(&Event::FilesChanged {
                paths: vec!["a.rs".into(), "b.rs".into()]
            }),
            r#"{"type":"files-changed","paths":["a.rs","b.rs"]}"#
        );
        assert_eq!(
            js(&Event::FileWritten { path: None }),
            r#"{"type":"file-written","path":null}"#
        );
        assert_eq!(
            js(&Event::FileWritten {
                path: Some("a.rs".into())
            }),
            r#"{"type":"file-written","path":"a.rs"}"#
        );
        assert_eq!(
            js(&Event::Submitted {
                timestamp: 7,
                summary: None
            }),
            r#"{"type":"submitted","timestamp":7}"#
        );
        assert_eq!(
            js(&Event::Submitted {
                timestamp: 7,
                summary: Some("ship it".into())
            }),
            r#"{"type":"submitted","timestamp":7,"summary":"ship it"}"#
        );
        assert_eq!(
            js(&Event::ReviewEnded {
                reason: EndReason::Idle
            }),
            r#"{"type":"review-ended","reason":"idle"}"#
        );
        assert_eq!(
            js(&Event::UserEdit {
                action: "delete".into(),
                file_path: "a.rs".into(),
                range: Some(EditRange {
                    start_line: 1,
                    start_column: 0,
                    end_line: 1,
                    end_column: 4
                }),
                deleted_text: Some("text".into()),
                inserted_text: None,
            }),
            r#"{"type":"user-edit","action":"delete","filePath":"a.rs","range":{"startLine":1,"startColumn":0,"endLine":1,"endColumn":4},"deletedText":"text"}"#
        );
    }

    #[test]
    fn comment_wire_shape_and_optional_absence() {
        let bare = ReviewComment {
            id: "i".into(),
            file_path: "f".into(),
            side: "additions".into(),
            line_number: 3,
            end_line: None,
            line_content: "x".into(),
            body: "b".into(),
            status: "open".into(),
            created_at: 1,
            replies: Vec::new(),
            outdated: None,
            suggestion: None,
            start_column: None,
            end_column: None,
            selected_text: None,
        };
        // Optional fields must be ABSENT (not null) when unset — the UI
        // distinguishes missing from null.
        assert_eq!(
            serde_json::to_string(&bare).unwrap(),
            r#"{"id":"i","filePath":"f","side":"additions","lineNumber":3,"lineContent":"x","body":"b","status":"open","createdAt":1,"replies":[]}"#
        );
        let event = Event::CommentAdded { comment: bare };
        assert!(js(&event).starts_with(r#"{"type":"comment-added","comment":{"#));

        let reply = CommentReply {
            id: "r".into(),
            body: "y".into(),
            created_at: 2,
            author: Some("user".into()),
        };
        assert_eq!(
            js(&Event::ReplyAdded {
                comment_id: "i".into(),
                reply,
                comment_status: "open".into()
            }),
            r#"{"type":"reply-added","commentId":"i","reply":{"id":"r","body":"y","createdAt":2,"author":"user"},"commentStatus":"open"}"#
        );
    }
}
