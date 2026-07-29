//! The comment store: a single Vec behind the server's one mutex, with
//! best-effort persistence after every mutation. Comments are durable reviewer
//! state keyed to a review (worktree + branch); they live under `~/.krit`
//! (see `state::comments_store_path`), never in a temp dir and never in the
//! repo.

use crate::types::{CommentReply, PendingDraft, ReviewComment};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Bumped when the on-disk record shape changes incompatibly. Files written
/// before it existed are bare arrays and read as version 0.
const SCHEMA_VERSION: u32 = 1;

#[derive(Default)]
pub struct UpdateFields {
    pub body: Option<String>,
    pub status: Option<String>,
    pub line_number: Option<u32>,
    pub end_line: Option<u32>,
    pub line_content: Option<String>,
    pub outdated: Option<bool>,
}

/// Reads the store file, keeping every record that still parses. Records are
/// decoded one at a time so that a single malformed or newer-shaped comment
/// costs one comment rather than the whole review — the next mutation
/// persists whatever survived, so anything dropped here is dropped for good.
/// Accepts both the versioned object and the bare array older builds wrote.
fn load(path: &Path) -> Vec<ReviewComment> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let records = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(records)) => records,
        Ok(Value::Object(mut obj)) => match obj.remove("comments") {
            Some(Value::Array(records)) => records,
            _ => return quarantine(path, "no `comments` array"),
        },
        _ => return quarantine(path, "not valid JSON"),
    };
    records
        .into_iter()
        .filter_map(
            |record| match serde_json::from_value::<ReviewComment>(record) {
                Ok(comment) => Some(comment),
                Err(err) => {
                    eprintln!(
                        "krit: dropping unreadable comment in {}: {err}",
                        path.display()
                    );
                    None
                }
            },
        )
        .collect()
}

/// Renames an unreadable store aside so the first mutation of the new session
/// doesn't overwrite it with an empty list.
fn quarantine(path: &Path, why: &str) -> Vec<ReviewComment> {
    let aside = path.with_extension("json.corrupt");
    match std::fs::rename(path, &aside) {
        Ok(()) => eprintln!(
            "krit: comment store {} is unreadable ({why}); kept a copy at {}",
            path.display(),
            aside.display()
        ),
        Err(err) => eprintln!(
            "krit: comment store {} is unreadable ({why}) and could not be set aside: {err}",
            path.display()
        ),
    }
    Vec::new()
}

/// Unsent draft text out of the same file, by the same record-at-a-time rule as
/// `load`. An absent key is the normal case for any store written before drafts
/// persisted, and is not a problem.
fn load_pending(path: &Path) -> Vec<PendingDraft> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(Value::Array(records)) = obj.remove("pendingDrafts") else {
        return Vec::new();
    };
    records
        .into_iter()
        .filter_map(|r| serde_json::from_value::<PendingDraft>(r).ok())
        .collect()
}

pub struct CommentStore {
    comments: Vec<ReviewComment>,
    /// Text still being typed. Deliberately in the same file and behind the same
    /// lock as `comments`: a draft and the comment it becomes are the same piece
    /// of reviewer state at two moments, and splitting them would mean two
    /// writes that can disagree about whether a comment was submitted.
    pending: Vec<PendingDraft>,
    file: Option<PathBuf>,
}

impl CommentStore {
    /// File-backed: loads existing comments and persists after every mutation.
    /// `None` = in-memory only.
    pub fn new(file: Option<PathBuf>) -> Self {
        let comments = file.as_ref().map(|p| load(p)).unwrap_or_default();
        let pending = file.as_ref().map(|p| load_pending(p)).unwrap_or_default();
        Self {
            comments,
            pending,
            file,
        }
    }

    pub fn pending_all(&self) -> Vec<PendingDraft> {
        self.pending.clone()
    }

    /// Upsert by slot — see `PendingDraft::slot`. An empty body with nothing in
    /// the suggestion editor is a cleared form, which is a removal rather than a
    /// stored blank; otherwise closing a form you had emptied would leave a
    /// draft that reopens as an empty one forever.
    pub fn upsert_pending(&mut self, draft: PendingDraft) {
        if draft.body.trim().is_empty() && draft.suggestion_text.trim().is_empty() {
            self.remove_pending(
                &draft.file_path,
                &draft.side,
                draft.start_line,
                draft.end_line,
            );
            return;
        }
        match self.pending.iter_mut().find(|d| d.slot() == draft.slot()) {
            Some(existing) => *existing = draft,
            None => self.pending.push(draft),
        }
        self.persist();
    }

    /// Returns whether anything was removed, so a caller can answer 404 rather
    /// than claim it deleted something that was never there.
    pub fn remove_pending(
        &mut self,
        file_path: &str,
        side: &str,
        start_line: u32,
        end_line: u32,
    ) -> bool {
        let before = self.pending.len();
        self.pending
            .retain(|d| d.slot() != (file_path, side, start_line, end_line));
        let removed = self.pending.len() != before;
        if removed {
            self.persist();
        }
        removed
    }

    fn persist(&self) {
        // Best-effort: a failed write shouldn't crash a working review
        // session; only durability across a restart is lost. The rename is
        // what makes it safe to fail — the previous file stays whole until
        // the replacement is complete on disk.
        let Some(path) = &self.file else { return };
        let Ok(json) = serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "comments": &self.comments,
            "pendingDrafts": &self.pending,
        })) else {
            return;
        };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
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

    /// A store path in shared system temp, cleared of anything a previous run
    /// left behind. Pids recycle, so a stale fixture would fail the next run
    /// of a test whose code is fine.
    fn store_path(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("krit-store-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("json.corrupt"));
        path
    }

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
        let path = store_path("test");

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
        let path = store_path("update-many");

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
        let path = store_path("update-many-noop");

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

    /// Writes `content` as the store file, loads it, and asserts the bytes were
    /// moved aside intact and survive the session's first mutation.
    fn assert_quarantined(name: &str, content: &str) {
        let path = store_path(name);
        let aside = path.with_extension("json.corrupt");
        std::fs::write(&path, content).unwrap();

        let mut s = CommentStore::new(Some(path.clone()));
        assert!(s.get_all().is_empty());
        assert_eq!(std::fs::read_to_string(&aside).unwrap(), content);
        assert!(
            !path.exists(),
            "the unreadable file is moved aside, not copied — leaving it in \
             place would let the next load quarantine it a second time"
        );
        // The first mutation writes a fresh file; the quarantined one stands.
        s.add(comment("a", "new"));
        assert_eq!(std::fs::read_to_string(&aside).unwrap(), content);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&aside);
    }

    #[test]
    fn unparseable_json_is_set_aside_rather_than_overwritten() {
        assert_quarantined("corrupt", "{not valid json");
    }

    #[test]
    fn json_without_a_comments_array_is_set_aside_rather_than_overwritten() {
        // The likelier of the two quarantine triggers: a partial write, a hand
        // edit or a future schema yields valid JSON of the wrong shape far more
        // often than it yields a parse error.
        assert_quarantined("wrong-shape", r#"{"schemaVersion":1,"notes":[]}"#);
    }

    #[test]
    fn one_unreadable_record_does_not_lose_the_rest() {
        let path = store_path("bad-record");
        let mut s = CommentStore::new(Some(path.clone()));
        s.add(comment("a", "keep me"));
        s.add(comment("b", "keep me too"));

        // Corrupt exactly one record in place.
        let text = std::fs::read_to_string(&path).unwrap();
        let mut file: serde_json::Value = serde_json::from_str(&text).unwrap();
        file["comments"][0]["lineNumber"] = serde_json::json!("not a number");
        std::fs::write(&path, serde_json::to_string(&file).unwrap()).unwrap();

        let reloaded = CommentStore::new(Some(path.clone()));
        let all = reloaded.get_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "b");

        let _ = std::fs::remove_file(&path);
    }

    fn draft(file: &str, line: u32, body: &str) -> PendingDraft {
        PendingDraft {
            file_path: file.into(),
            side: "additions".into(),
            start_line: line,
            end_line: line,
            body: body.into(),
            suggest_mode: false,
            suggestion_text: String::new(),
            start_column: None,
            end_column: None,
            selected_text: None,
            updated_at: 1,
        }
    }

    #[test]
    fn unsent_text_survives_a_restart() {
        // The whole point: a reviewer mid-sentence closes the tab (or the TUI
        // pane) and comes back to what they were typing.
        let path = store_path("pending-durable");
        let mut s = CommentStore::new(Some(path.clone()));
        s.upsert_pending(draft("a.rs", 12, "half a thought"));

        let reloaded = CommentStore::new(Some(path.clone()));
        let all = reloaded.pending_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].body, "half a thought");
        assert_eq!(all[0].start_line, 12);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_slot_holds_one_draft_and_later_typing_replaces_it() {
        // The UI allows one open form per file+side+range, so a second draft in
        // the same slot is the same draft — appending would resurrect earlier
        // keystrokes on reload.
        let path = store_path("pending-slot");
        let mut s = CommentStore::new(Some(path.clone()));
        s.upsert_pending(draft("a.rs", 12, "first"));
        s.upsert_pending(draft("a.rs", 12, "first, extended"));
        s.upsert_pending(draft("a.rs", 99, "elsewhere"));

        let all = s.pending_all();
        assert_eq!(all.len(), 2, "same slot must not stack: {all:?}");
        let same_slot: Vec<&PendingDraft> = all.iter().filter(|d| d.start_line == 12).collect();
        assert_eq!(same_slot.len(), 1);
        assert_eq!(same_slot[0].body, "first, extended");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clearing_the_form_removes_the_draft_rather_than_storing_a_blank() {
        // Otherwise emptying a form and closing it leaves a draft that reopens
        // as an empty form on every future load, with no way to be rid of it.
        let path = store_path("pending-cleared");
        let mut s = CommentStore::new(Some(path.clone()));
        s.upsert_pending(draft("a.rs", 5, "something"));
        s.upsert_pending(draft("a.rs", 5, "   "));
        assert!(s.pending_all().is_empty(), "{:?}", s.pending_all());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_blank_body_still_persists_when_a_suggestion_is_typed() {
        // Suggest-only is a real review action — the rewrite is the content.
        // Keying "is this draft empty" on the body alone would drop it.
        let path = store_path("pending-suggest-only");
        let mut s = CommentStore::new(Some(path.clone()));
        let mut d = draft("a.rs", 5, "");
        d.suggest_mode = true;
        d.suggestion_text = "let x = 1;".into();
        s.upsert_pending(d);
        let all = s.pending_all();
        assert_eq!(all.len(), 1);
        assert!(all[0].suggest_mode);
        assert_eq!(all[0].suggestion_text, "let x = 1;");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn removing_reports_whether_anything_was_there() {
        let path = store_path("pending-remove");
        let mut s = CommentStore::new(Some(path.clone()));
        s.upsert_pending(draft("a.rs", 5, "text"));
        assert!(s.remove_pending("a.rs", "additions", 5, 5));
        assert!(!s.remove_pending("a.rs", "additions", 5, 5));
        assert!(s.pending_all().is_empty());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drafts_and_comments_share_a_file_without_disturbing_each_other() {
        let path = store_path("pending-coexist");
        let mut s = CommentStore::new(Some(path.clone()));
        s.add(comment("a", "a real comment"));
        s.upsert_pending(draft("a.rs", 5, "still typing"));

        let reloaded = CommentStore::new(Some(path.clone()));
        assert_eq!(reloaded.get_all().len(), 1);
        assert_eq!(reloaded.pending_all().len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_store_without_the_drafts_key_loads_as_no_drafts() {
        // Every store written before this feature. Absent is normal, not broken.
        let path = store_path("pending-absent");
        let mut s = CommentStore::new(Some(path.clone()));
        s.add(comment("a", "only a comment"));
        let reloaded = CommentStore::new(Some(path.clone()));
        assert!(reloaded.pending_all().is_empty());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_the_bare_array_older_builds_wrote() {
        let path = store_path("legacy");
        let legacy = serde_json::to_string(&vec![comment("a", "from v0")]).unwrap();
        std::fs::write(&path, legacy).unwrap();

        let mut s = CommentStore::new(Some(path.clone()));
        assert_eq!(s.get_all().len(), 1);
        // ...and rewrites it in the versioned shape.
        s.add(comment("b", "new"));
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(written["comments"].as_array().unwrap().len(), 2);

        let _ = std::fs::remove_file(&path);
    }
}
