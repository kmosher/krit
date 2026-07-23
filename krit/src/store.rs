//! The comment store: a single Vec behind the server's one mutex, with
//! best-effort persistence after every mutation. Comments are durable reviewer
//! state keyed to a review (worktree + branch); they live under `~/.krit`
//! (see `state::comments_store_path`), never in a temp dir and never in the
//! repo.

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ReviewComment;

    fn comment(id: &str, body: &str) -> ReviewComment {
        ReviewComment {
            id: id.into(),
            file_path: "f.rs".into(),
            side: "additions".into(),
            line_number: 1,
            end_line: None,
            line_content: "x".into(),
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
    fn crud_lifecycle() {
        let mut s = CommentStore::new(None);
        s.add(comment("a", "first"));
        s.add(comment("b", "second"));
        assert_eq!(s.get_all().len(), 2);
        assert_eq!(s.get("a").unwrap().body, "first");

        let updated = s
            .update(
                "a",
                UpdateFields {
                    status: Some("resolved".into()),
                    body: Some("edited".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.status, "resolved");
        assert_eq!(updated.body, "edited");
        // Unset fields are left untouched.
        assert_eq!(s.get("a").unwrap().line_number, 1);

        assert!(s.update("missing", UpdateFields::default()).is_none());
        assert!(s.remove("a"));
        assert!(!s.remove("a"));
        assert_eq!(s.get_all().len(), 1);
    }

    #[test]
    fn add_reply_targets_the_right_comment() {
        let mut s = CommentStore::new(None);
        s.add(comment("a", "x"));
        let reply = CommentReply {
            id: "r1".into(),
            body: "reply".into(),
            created_at: 1,
            author: Some("user".into()),
        };
        let updated = s.add_reply("a", reply).unwrap();
        assert_eq!(updated.replies.len(), 1);
        assert_eq!(updated.replies[0].body, "reply");
        assert!(
            s.add_reply(
                "nope",
                CommentReply {
                    id: "r2".into(),
                    body: "y".into(),
                    created_at: 2,
                    author: None,
                }
            )
            .is_none()
        );
    }

    #[test]
    fn persists_and_reloads_across_instances() {
        let path =
            std::env::temp_dir().join(format!("krit-store-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let mut s = CommentStore::new(Some(path.clone()));
        s.add(comment("a", "persisted"));
        s.add_reply(
            "a",
            CommentReply {
                id: "r".into(),
                body: "kept".into(),
                created_at: 3,
                author: Some("agent".into()),
            },
        );

        // A fresh instance over the same file sees the mutations.
        let reloaded = CommentStore::new(Some(path.clone()));
        let all = reloaded.get_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].body, "persisted");
        assert_eq!(all[0].replies[0].body, "kept");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tolerates_corrupt_file_by_starting_empty() {
        let path =
            std::env::temp_dir().join(format!("krit-store-corrupt-{}.json", std::process::id()));
        std::fs::write(&path, "{not valid json").unwrap();
        let s = CommentStore::new(Some(path.clone()));
        assert!(s.get_all().is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
