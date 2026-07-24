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

    /// Comments on one file, cloned. The re-anchor hot path runs per changed
    /// file per watcher tick; cloning only the file's comments (not the whole
    /// store, as `get_all` would) keeps a churn burst from cloning every
    /// comment once per changed path.
    pub fn for_file(&self, file_path: &str) -> Vec<ReviewComment> {
        self.comments
            .iter()
            .filter(|c| c.file_path == file_path)
            .cloned()
            .collect()
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
        let result = self.apply_update(id, fields);
        if result.is_some() {
            self.persist();
        }
        result
    }

    /// Applies several updates in one store lock and persists **once**
    /// afterward, instead of once per update — a reanchor pass over C moved
    /// comments must not write the file C times. Returns the updated
    /// comments in input order, skipping any id that no longer exists
    /// (mirrors `update`'s `None` for a missing id).
    pub fn update_many(
        &mut self,
        updates: impl IntoIterator<Item = (String, UpdateFields)>,
    ) -> Vec<ReviewComment> {
        let mut out = Vec::new();
        let mut dirty = false;
        for (id, fields) in updates {
            if let Some(updated) = self.apply_update(&id, fields) {
                dirty = true;
                out.push(updated);
            }
        }
        if dirty {
            self.persist();
        }
        out
    }

    fn apply_update(&mut self, id: &str, fields: UpdateFields) -> Option<ReviewComment> {
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
        Some(comment.clone())
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
    fn for_file_returns_only_the_matching_files_comments() {
        let mut s = CommentStore::new(None);
        s.add(comment("a", "on f.rs")); // comment() files everything at f.rs
        let mut other = comment("b", "on g.rs");
        other.file_path = "g.rs".into();
        s.add(other);

        let f = s.for_file("f.rs");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].id, "a");
        assert!(s.for_file("nope.rs").is_empty());
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
    fn update_many_applies_all_updates_in_one_write() {
        let path = std::env::temp_dir().join(format!(
            "krit-store-update-many-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        let mut s = CommentStore::new(Some(path.clone()));
        s.add(comment("a", "first"));
        s.add(comment("b", "second"));
        s.add(comment("c", "third"));

        let updated = s.update_many([
            (
                "a".to_string(),
                UpdateFields {
                    body: Some("a2".into()),
                    ..Default::default()
                },
            ),
            (
                "missing".to_string(),
                UpdateFields {
                    body: Some("nope".into()),
                    ..Default::default()
                },
            ),
            (
                "c".to_string(),
                UpdateFields {
                    status: Some("resolved".into()),
                    ..Default::default()
                },
            ),
        ]);
        // Only the two real ids come back — the missing one is silently
        // skipped, mirroring `update`'s None.
        assert_eq!(updated.len(), 2);
        assert_eq!(updated[0].id, "a");
        assert_eq!(updated[0].body, "a2");
        assert_eq!(updated[1].id, "c");
        assert_eq!(updated[1].status, "resolved");
        // "b" is untouched.
        assert_eq!(s.get("b").unwrap().body, "second");

        // Reload from disk proves the batch was actually persisted, not just
        // held in memory.
        let reloaded = CommentStore::new(Some(path.clone()));
        assert_eq!(reloaded.get("a").unwrap().body, "a2");
        assert_eq!(reloaded.get("c").unwrap().status, "resolved");
        assert_eq!(reloaded.get("b").unwrap().body, "second");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn update_many_with_no_hits_does_not_persist() {
        let path = std::env::temp_dir().join(format!(
            "krit-store-update-many-noop-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        let mut s = CommentStore::new(Some(path.clone()));
        s.add(comment("a", "first"));
        assert!(path.exists(), "add() should have persisted once");
        std::fs::remove_file(&path).unwrap();

        let updated = s.update_many([(
            "missing".to_string(),
            UpdateFields {
                body: Some("nope".into()),
                ..Default::default()
            },
        )]);
        assert!(updated.is_empty());
        assert!(
            !path.exists(),
            "an all-miss batch must not touch the file at all"
        );

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
