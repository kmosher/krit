//! The comment store: a single Vec behind the server's one mutex, with
//! best-effort persistence after every mutation. Comments are reviewer
//! scratch state tied to a krit session — they live next to the state file,
//! never in the repo.

use crate::types::{CommentReply, ReviewComment};
use std::path::PathBuf;

#[derive(Default)]
pub struct UpdateFields {
    pub body: Option<String>,
    pub status: Option<String>,
    pub line_number: Option<u32>,
    pub end_line: Option<u32>,
    pub line_content: Option<String>,
    pub outdated: Option<bool>,
}

pub struct CommentStore {
    comments: Vec<ReviewComment>,
    file: Option<PathBuf>,
}

impl CommentStore {
    /// File-backed: loads existing comments (tolerating a corrupt or
    /// partially-written file by starting fresh) and persists after every
    /// mutation. `None` = in-memory only.
    pub fn new(file: Option<PathBuf>) -> Self {
        let comments = file
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<ReviewComment>>(&s).ok())
            .unwrap_or_default();
        Self { comments, file }
    }

    fn persist(&self) {
        // Best-effort: a failed write shouldn't crash a working review
        // session; only durability across a restart is lost.
        if let Some(path) = &self.file
            && let Ok(json) = serde_json::to_string_pretty(&self.comments)
        {
            let _ = std::fs::write(path, json);
        }
    }

    pub fn get_all(&self) -> Vec<ReviewComment> {
        self.comments.clone()
    }

    pub fn get(&self, id: &str) -> Option<&ReviewComment> {
        self.comments.iter().find(|c| c.id == id)
    }

    pub fn add(&mut self, comment: ReviewComment) -> ReviewComment {
        self.comments.push(comment.clone());
        self.persist();
        comment
    }

    pub fn update(&mut self, id: &str, fields: UpdateFields) -> Option<ReviewComment> {
        let comment = self.comments.iter_mut().find(|c| c.id == id)?;
        if let Some(body) = fields.body {
            comment.body = body;
        }
        if let Some(status) = fields.status {
            comment.status = status;
        }
        if let Some(n) = fields.line_number {
            comment.line_number = n;
        }
        if let Some(n) = fields.end_line {
            comment.end_line = Some(n);
        }
        if let Some(s) = fields.line_content {
            comment.line_content = s;
        }
        if let Some(o) = fields.outdated {
            comment.outdated = Some(o);
        }
        let cloned = comment.clone();
        self.persist();
        Some(cloned)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.comments.len();
        self.comments.retain(|c| c.id != id);
        let removed = self.comments.len() != before;
        if removed {
            self.persist();
        }
        removed
    }

    pub fn add_reply(&mut self, comment_id: &str, reply: CommentReply) -> Option<ReviewComment> {
        let comment = self.comments.iter_mut().find(|c| c.id == comment_id)?;
        comment.replies.push(reply);
        let cloned = comment.clone();
        self.persist();
        Some(cloned)
    }
}
