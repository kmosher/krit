//! The wire types: comments and the event protocol. These are the frozen v1
//! API contract (see docs/design/krit-v2.md) — field names and event tags
//! must stay byte-compatible with what the React UI and the Claude skill
//! already speak.

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
    /// "open" | "resolved" | "draft". Drafts are suppressed from every
    /// broadcast and agent-facing listing until posted.
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
    },
    ReviewEnded {
        reason: String,
    },
}

pub fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
