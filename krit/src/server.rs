//! The HTTP surface: the frozen v1 API contract served by axum. Routes, JSON
//! shapes, and event frames are wire-compatible with diffx v1 — the React UI
//! and the Claude skill run against either backend unchanged.

use crate::edits::{DeleteRange, splice_delete_range, splice_insert_text};
use crate::git;
use crate::hub::{Hub, Role};
use crate::reanchor::reanchor_file_comments;
use crate::settings::{load_settings, save_settings};
use crate::store::{CommentStore, UpdateFields};
use crate::types::{CommentReply, EditRange, Event, ReviewComment, Suggestion, now_millis};
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use rust_embed::RustEmbed;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The built React UI, embedded at compile time — the whole artifact is one
/// binary; there is no dist/ to go stale. Debug builds read the folder from
/// disk (fast iteration), release builds embed.
#[derive(RustEmbed)]
#[folder = "../dist/client"]
struct Assets;

const FILE_TEXT_CAP_BYTES: usize = 5 * 1024 * 1024;
const UNDO_BUFFER_CAP: usize = 20;

/// Debounce for the state→clients transform sent to agent (ws) subscribers —
/// long enough that a browser tab reload doesn't read as a leave-then-rejoin.
const CLIENTS_DEBOUNCE_MS: u64 = 4000;

struct UndoEntry {
    id: String,
    file_path: String,
    start_line: u32,
    start_column: u32,
    deleted_text: String,
}

pub struct Inner {
    pub hub: Arc<Hub>,
    pub store: Mutex<CommentStore>,
    pub repo_root: PathBuf,
    pub custom_diff_args: Option<Vec<String>>,
    viewed: Mutex<HashSet<String>>,
    undo: Mutex<Vec<UndoEntry>>,
}

pub type AppState = Arc<Inner>;

pub fn new_state(
    hub: Arc<Hub>,
    store: CommentStore,
    repo_root: PathBuf,
    custom_diff_args: Option<Vec<String>>,
) -> AppState {
    Arc::new(Inner {
        hub,
        store: Mutex::new(store),
        repo_root,
        custom_diff_args,
        viewed: Mutex::new(HashSet::new()),
        undo: Mutex::new(Vec::new()),
    })
}

/// Re-anchors non-resolved additions-side comments on `path` after a
/// working-tree change and broadcasts the movers as comment-updated. Runs
/// once server-side so UI, CLI, and agent can't disagree. Drafts re-anchor
/// but never broadcast. Sync on purpose: callable from the watcher thread.
pub fn reanchor_and_broadcast(state: &AppState, path: &str) {
    let changed = {
        let mut store = state.store.lock().unwrap();
        reanchor_file_comments(path, &mut store, &state.repo_root)
    };
    for comment in changed {
        if comment.status == "draft" {
            continue;
        }
        state.hub.broadcast(Event::CommentUpdated { comment });
    }
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

// ---------- diff assembly ----------

fn parse_file_paths(patch: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch.lines() {
        if let Some(p) = diff_header_path(line)
            && !paths.contains(&p)
        {
            paths.push(p);
        }
    }
    paths
}

/// `diff --git a/<old> b/<new>` → `<new>`.
fn diff_header_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git a/")?;
    rest.split_once(" b/").map(|(_, new)| new.to_string())
}

/// One file's fragment out of a multi-file patch, for GET /api/diff?file=.
/// '' = no pending diff for that path (e.g. reverted between the watcher
/// event and this request) — treated as "nothing to show".
fn extract_file_patch(patch: &str, file_path: &str) -> String {
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut start: Option<usize> = None;
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        if !line.starts_with("diff --git a/") {
            continue;
        }
        match start {
            None => {
                if diff_header_path(line).as_deref() == Some(file_path) {
                    start = Some(i);
                }
            }
            Some(_) => {
                end = i;
                break;
            }
        }
    }
    match start {
        Some(s) => lines[s..end].join("\n"),
        None => String::new(),
    }
}

fn parse_binary_files(patch: &str, untracked: &HashSet<String>) -> Vec<Value> {
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut result = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.starts_with("Binary files ") || !line.contains(" differ") {
            continue;
        }
        let mut file_path = String::new();
        for j in (0..i).rev() {
            if let Some(p) = diff_header_path(lines[j]) {
                file_path = p;
                break;
            }
        }
        if file_path.is_empty() {
            continue;
        }
        let mut change_type = "changed";
        for j in (0..i).rev() {
            if lines[j].starts_with("diff --git") {
                break;
            }
            if lines[j].starts_with("new file mode") {
                change_type = "added";
                break;
            }
            if lines[j].starts_with("deleted file mode") {
                change_type = "deleted";
                break;
            }
        }
        if change_type == "added" && untracked.contains(&file_path) {
            change_type = "untracked";
        }
        result.push(json!({ "path": file_path, "type": change_type }));
    }
    result
}

fn read_side(root: &std::path::Path, path: &str, git_ref: &str) -> Value {
    let Some(buf) = git::file_content_at_ref(root, path, git_ref) else {
        return json!({ "missing": true });
    };
    if buf.iter().take(8192).any(|&b| b == 0) {
        return json!({ "binary": true });
    }
    if buf.len() > FILE_TEXT_CAP_BYTES {
        return json!({ "oversize": true, "size": buf.len() });
    }
    json!({ "contents": String::from_utf8_lossy(&buf) })
}

async fn api_diff(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let is_custom = state.custom_diff_args.is_some();
    let staged = params.get("staged").map(|v| v == "true").unwrap_or(false);
    let untracked = params
        .get("untracked")
        .map(|v| v == "true")
        .unwrap_or(false);

    let (patch, refs) = if let Some(args) = &state.custom_diff_args {
        (
            git::custom_git_diff(args),
            git::resolve_diff_refs(Some(args)),
        )
    } else {
        let patch = git::git_diff(staged, untracked, &state.repo_root);
        // Refs must mirror what git_diff actually covered so the client can
        // reproduce the patch from the bundled contents (see v1's table).
        let refs = if staged && untracked {
            ("HEAD".to_string(), git::WORKING_TREE_REF.to_string())
        } else if staged {
            ("HEAD".to_string(), git::INDEX_REF.to_string())
        } else {
            (
                git::INDEX_REF.to_string(),
                git::WORKING_TREE_REF.to_string(),
            )
        };
        (patch, refs)
    };

    let repo_name = git::repo_name();
    let branch = git::branch_name();
    let untracked_files: Vec<String> = if untracked {
        git::untracked_file_paths()
    } else {
        Vec::new()
    };
    let untracked_set: HashSet<String> = untracked_files.iter().cloned().collect();
    let binary_files = parse_binary_files(&patch, &untracked_set);
    let binary_set: HashSet<String> = binary_files
        .iter()
        .filter_map(|b| b["path"].as_str().map(|s| s.to_string()))
        .collect();

    // ?file=<path> scopes to one file for targeted refetches.
    if let Some(file_filter) = params.get("file") {
        let fragment = extract_file_patch(&patch, file_filter);
        let file_contents = if binary_set.contains(file_filter) {
            json!({})
        } else {
            json!({
                file_filter.clone(): {
                    "old": read_side(&state.repo_root, file_filter, &refs.0),
                    "new": read_side(&state.repo_root, file_filter, &refs.1),
                }
            })
        };
        return axum::Json(json!({
            "patch": fragment,
            "repoName": repo_name,
            "branch": branch,
            "customMode": is_custom,
            "binaryFiles": binary_files.iter().filter(|b| b["path"].as_str() == Some(file_filter)).collect::<Vec<_>>(),
            "untrackedFiles": untracked_files.iter().filter(|f| *f == file_filter).collect::<Vec<_>>(),
            "fileContents": file_contents,
        }))
        .into_response();
    }

    let mut file_contents = serde_json::Map::new();
    for path in parse_file_paths(&patch) {
        if binary_set.contains(&path) {
            continue; // binary renders outside CodeView
        }
        file_contents.insert(
            path.clone(),
            json!({
                "old": read_side(&state.repo_root, &path, &refs.0),
                "new": read_side(&state.repo_root, &path, &refs.1),
            }),
        );
    }

    axum::Json(json!({
        "patch": patch,
        "repoName": repo_name,
        "branch": branch,
        "customMode": is_custom,
        "binaryFiles": binary_files,
        "untrackedFiles": untracked_files,
        "fileContents": file_contents,
    }))
    .into_response()
}

// ---------- file content ----------

async fn api_file_content_get(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (Some(path), Some(version)) = (params.get("path"), params.get("version")) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "Missing path or version"})),
        )
            .into_response();
    };
    let Some(content) = git::file_content(&state.repo_root, path, version) else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "File not found"})),
        )
            .into_response();
    };
    ([(header::CONTENT_TYPE, mime_for(path))], content).into_response()
}

async fn api_file_content_put(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let (Some(path), Some(contents)) = (body["path"].as_str(), body["contents"].as_str()) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "path and contents required"})),
        )
            .into_response();
    };
    if !git::write_working_tree_file(&state.repo_root, path, contents) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "write failed (unsafe path or IO error)"})),
        )
            .into_response();
    }
    // Re-anchor before broadcasting, so by the time watchers refetch,
    // comment positions already reflect the edit.
    reanchor_and_broadcast(&state, path);
    state.hub.broadcast(Event::FileWritten {
        path: Some(path.to_string()),
    });
    axum::Json(json!({"ok": true})).into_response()
}

async fn api_refresh(State(state): State<AppState>) -> Response {
    // Manual nudge for edits made outside the in-browser editor (an agent's
    // own tools) — those writes never broadcast file-written on their own.
    state.hub.broadcast(Event::FileWritten { path: None });
    axum::Json(json!({"ok": true})).into_response()
}

// ---------- direct edits + undo ----------

async fn api_edits_delete(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let (Some(file_path), Some(start_line), Some(start_column), Some(end_line), Some(end_column)) = (
        body["filePath"].as_str(),
        body["startLine"].as_u64(),
        body["startColumn"].as_u64(),
        body["endLine"].as_u64(),
        body["endColumn"].as_u64(),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(
                json!({"error": "filePath, startLine, startColumn, endLine, endColumn required"}),
            ),
        )
            .into_response();
    };
    let range = DeleteRange {
        file_path: file_path.to_string(),
        start_line: start_line as u32,
        start_column: start_column as u32,
        end_line: end_line as u32,
        end_column: end_column as u32,
    };
    let Some(deleted_text) = splice_delete_range(&state.repo_root, &range) else {
        return (StatusCode::BAD_REQUEST, axum::Json(json!({"error": "delete failed (unsafe path, unreadable file, or range no longer matches the file on disk)"}))).into_response();
    };

    let undo_id = uuid::Uuid::new_v4().to_string();
    {
        let mut undo = state.undo.lock().unwrap();
        undo.push(UndoEntry {
            id: undo_id.clone(),
            file_path: file_path.to_string(),
            start_line: range.start_line,
            start_column: range.start_column,
            deleted_text: deleted_text.clone(),
        });
        if undo.len() > UNDO_BUFFER_CAP {
            undo.remove(0);
        }
    }

    reanchor_and_broadcast(&state, file_path);
    state.hub.broadcast(Event::FileChanged {
        path: file_path.to_string(),
    });
    state.hub.broadcast(Event::UserEdit {
        action: "delete".into(),
        file_path: file_path.to_string(),
        range: Some(EditRange {
            start_line: range.start_line,
            start_column: range.start_column,
            end_line: range.end_line,
            end_column: range.end_column,
        }),
        deleted_text: Some(deleted_text),
        inserted_text: None,
    });
    (
        StatusCode::CREATED,
        axum::Json(json!({"ok": true, "undoId": undo_id})),
    )
        .into_response()
}

async fn api_edits_undo(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let id = body["id"].as_str().unwrap_or_default().to_string();
    let entry = {
        let mut undo = state.undo.lock().unwrap();
        match undo.iter().position(|e| e.id == id) {
            Some(idx) => undo.remove(idx),
            None => {
                return (StatusCode::NOT_FOUND, axum::Json(json!({"error": "nothing to undo for that id (already undone, evicted, or never existed)"}))).into_response();
            }
        }
    };
    if !splice_insert_text(
        &state.repo_root,
        &entry.file_path,
        entry.start_line,
        entry.start_column,
        &entry.deleted_text,
    ) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(
                json!({"error": "undo failed (file changed since the delete, or became unwritable)"}),
            ),
        )
            .into_response();
    }
    reanchor_and_broadcast(&state, &entry.file_path);
    state.hub.broadcast(Event::FileChanged {
        path: entry.file_path.clone(),
    });
    state.hub.broadcast(Event::UserEdit {
        action: "undo".into(),
        file_path: entry.file_path.clone(),
        range: None,
        deleted_text: None,
        inserted_text: Some(entry.deleted_text),
    });
    axum::Json(json!({"ok": true})).into_response()
}

// ---------- settings + viewed ----------

async fn api_settings_get() -> Response {
    axum::Json(load_settings()).into_response()
}

async fn api_settings_put(axum::Json(body): axum::Json<Value>) -> Response {
    axum::Json(save_settings(&body)).into_response()
}

async fn api_viewed_get(State(state): State<AppState>) -> Response {
    let viewed = state.viewed.lock().unwrap();
    axum::Json(viewed.iter().cloned().collect::<Vec<_>>()).into_response()
}

async fn api_viewed_put(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let file_path = body["filePath"].as_str().unwrap_or_default().to_string();
    let viewed_flag = body["viewed"].as_bool().unwrap_or(false);
    let mut viewed = state.viewed.lock().unwrap();
    if viewed_flag {
        viewed.insert(file_path);
    } else {
        viewed.remove(&file_path);
    }
    axum::Json(json!({"ok": true})).into_response()
}

// ---------- comments ----------

async fn api_comments_get(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let comments = state.store.lock().unwrap().get_all();
    // Drafts are opt-in: only the browser UI passes includeDrafts=true.
    // Everyone else gets the agent-visible view, matching the broadcast
    // suppression — `krit comments` must not leak unposted drafts.
    if params.get("includeDrafts").map(|v| v == "true") == Some(true) {
        return axum::Json(comments).into_response();
    }
    let visible: Vec<ReviewComment> = comments
        .into_iter()
        .filter(|c| c.status != "draft")
        .collect();
    axum::Json(visible).into_response()
}

async fn api_comments_post(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let line_number = body["lineNumber"].as_u64().unwrap_or(0) as u32;
    // Clamp endLine to never precede lineNumber — inverted ranges from a
    // buggy client would silently confuse every downstream consumer.
    let end_line = (body["endLine"].as_u64().unwrap_or(line_number as u64) as u32).max(line_number);
    // Suggestion passes through only if shaped correctly.
    let suggestion = body["suggestion"]["newLines"].as_array().and_then(|arr| {
        let lines: Option<Vec<String>> = arr
            .iter()
            .map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        lines.map(|new_lines| Suggestion { new_lines })
    });
    // Only the UI creates drafts; anything else in the field is ignored.
    let status = if body["status"].as_str() == Some("draft") {
        "draft"
    } else {
        "open"
    };
    // Char-level anchor: all three fields or none.
    let char_anchor = match (
        body["startColumn"].as_u64(),
        body["endColumn"].as_u64(),
        body["selectedText"].as_str(),
    ) {
        (Some(s), Some(e), Some(t)) => Some((s as u32, e as u32, t.to_string())),
        _ => None,
    };

    let comment = ReviewComment {
        id: uuid::Uuid::new_v4().to_string(),
        file_path: body["filePath"].as_str().unwrap_or_default().to_string(),
        side: body["side"].as_str().unwrap_or_default().to_string(),
        line_number,
        end_line: Some(end_line),
        line_content: body["lineContent"].as_str().unwrap_or_default().to_string(),
        body: body["body"].as_str().unwrap_or_default().to_string(),
        status: status.to_string(),
        created_at: now_millis(),
        replies: Vec::new(),
        outdated: None,
        suggestion,
        start_column: char_anchor.as_ref().map(|(s, _, _)| *s),
        end_column: char_anchor.as_ref().map(|(_, e, _)| *e),
        selected_text: char_anchor.map(|(_, _, t)| t),
    };
    let created = state.store.lock().unwrap().add(comment);
    // Drafts stay invisible to the agent until posted.
    if created.status != "draft" {
        state.hub.broadcast(Event::CommentAdded {
            comment: created.clone(),
        });
    }
    (StatusCode::CREATED, axum::Json(created)).into_response()
}

/// Flips every draft to open in one batch, broadcasting comment-added for
/// each — the moment they become visible. Shared by "Post drafts" and by
/// /api/submit (Done reviewing must not strand drafts).
fn post_drafts_and_broadcast(state: &AppState) -> usize {
    let posted: Vec<ReviewComment> = {
        let mut store = state.store.lock().unwrap();
        let drafts: Vec<String> = store
            .get_all()
            .into_iter()
            .filter(|c| c.status == "draft")
            .map(|c| c.id)
            .collect();
        drafts
            .iter()
            .filter_map(|id| {
                store.update(
                    id,
                    UpdateFields {
                        status: Some("open".into()),
                        ..Default::default()
                    },
                )
            })
            .collect()
    };
    let count = posted.len();
    for comment in posted {
        state.hub.broadcast(Event::CommentAdded { comment });
    }
    count
}

async fn api_drafts_post(State(state): State<AppState>) -> Response {
    let posted = post_drafts_and_broadcast(&state);
    axum::Json(json!({"ok": true, "posted": posted})).into_response()
}

async fn api_comment_put(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    axum::Json(payload): axum::Json<Value>,
) -> Response {
    let new_status = payload["status"].as_str().map(|s| s.to_string());
    let (was_draft, updated) = {
        let mut store = state.store.lock().unwrap();
        // Only meaningful when a status change was requested (matching v1's
        // wasDraft computation): None = no status in the payload.
        let was_draft: Option<bool> = new_status
            .as_ref()
            .map(|_| store.get(&id).map(|c| c.status == "draft") == Some(true));
        let updated = store.update(
            &id,
            UpdateFields {
                body: payload["body"].as_str().map(|s| s.to_string()),
                status: new_status.clone(),
                ..Default::default()
            },
        );
        (was_draft, updated)
    };
    let Some(updated) = updated else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "Comment not found"})),
        )
            .into_response();
    };
    // A draft posted one-off through this route needs its catch-up
    // comment-added broadcast — it never got one at creation.
    if was_draft == Some(true) && new_status.as_deref() != Some("draft") {
        state.hub.broadcast(Event::CommentAdded {
            comment: updated.clone(),
        });
    }
    axum::Json(updated).into_response()
}

async fn api_comment_delete(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let removed = state.store.lock().unwrap().remove(&id);
    if !removed {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "Comment not found"})),
        )
            .into_response();
    }
    axum::Json(json!({"ok": true})).into_response()
}

async fn api_reply_post(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
    axum::Json(payload): axum::Json<Value>,
) -> Response {
    // source=ui → human in the browser; anything else → agent/CLI. The
    // browser opts in explicitly, so an unknown client defaults to the
    // silent path and can't feed the agent's own event loop.
    let source_ui = params.get("source").map(|s| s.as_str()) == Some("ui");
    let reply = CommentReply {
        id: uuid::Uuid::new_v4().to_string(),
        body: payload["body"].as_str().unwrap_or_default().to_string(),
        created_at: now_millis(),
        author: Some(if source_ui { "user" } else { "agent" }.to_string()),
    };
    let updated = {
        let mut store = state.store.lock().unwrap();
        let mut updated = store.add_reply(&id, reply.clone());
        if source_ui {
            // A human reply on a resolved comment reopens it for the next
            // agent pass; the broadcast carries the post-update status.
            if let Some(c) = &updated
                && c.status == "resolved"
            {
                updated = store.update(
                    &id,
                    UpdateFields {
                        status: Some("open".into()),
                        ..Default::default()
                    },
                );
            }
        }
        updated
    };
    let Some(updated) = updated else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "Comment not found"})),
        )
            .into_response();
    };
    if source_ui {
        state.hub.broadcast(Event::ReplyAdded {
            comment_id: id,
            reply,
            comment_status: updated.status.clone(),
        });
    }
    axum::Json(updated).into_response()
}

// ---------- submit ----------

async fn api_submit_post(State(state): State<AppState>) -> Response {
    // Done reviewing must not leave forgotten drafts stranded — post first.
    post_drafts_and_broadcast(&state);
    let ts = now_millis();
    state.hub.broadcast(Event::Submitted { timestamp: ts });
    axum::Json(json!({"ok": true, "timestamp": ts})).into_response()
}

async fn api_submit_get(State(state): State<AppState>) -> Response {
    let (watcher_count, ui_count, agent_count) = state.hub.counts();
    axum::Json(json!({
        "watcherCount": watcher_count,
        "uiCount": ui_count,
        "agentCount": agent_count,
    }))
    .into_response()
}

// ---------- event streams ----------

fn to_sse(event: &Event) -> SseEvent {
    SseEvent::default().data(serde_json::to_string(event).unwrap_or_default())
}

async fn api_events(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Sse<impl futures_core::Stream<Item = Result<SseEvent, std::convert::Infallible>>> {
    let role = if params.get("role").map(|s| s.as_str()) == Some("cli") {
        Role::Cli
    } else {
        Role::Ui
    };
    let (mut rx, guard) = state.hub.subscribe(role);
    let initial = state.hub.state_event();
    let stream = async_stream::stream! {
        // Guard lives inside the stream: dropped (→ disconnect accounting)
        // whenever the client goes away, no matter how.
        let _guard = guard;
        yield Ok(to_sse(&initial));
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let terminal = matches!(event, Event::ReviewEnded { .. });
                    yield Ok(to_sse(&event));
                    // Ending the stream on the terminal event is what lets
                    // graceful shutdown complete — an SSE stream that never
                    // ends was v1's shutdown deadlock.
                    if terminal {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(30))
            .text(""),
    )
}

async fn api_events_ws(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| agent_ws(state, socket))
}

/// Events the agent stream forwards. Agents only hear *human-originated*
/// signals: every ws frame is a Monitor wake-up costing the agent tokens, and
/// the ambient events (fs-watcher file-changed, the agent's own `krit
/// refresh` echo, comment-updated re-anchor fallout) are usually caused by
/// the agent's own edits — it would be paying to listen to itself work. The
/// UI keeps receiving all of these over SSE; the agent sees current comment
/// positions/outdated flags via the CLI whenever it acts on a comment.
fn agent_visible(event: &Event) -> bool {
    match event {
        Event::FileChanged { .. } => false,
        Event::FileWritten { path: None } => false, // agent's own refresh
        Event::CommentUpdated { .. } => false,
        // file-written{path} = krit editor save; user-edit = direct
        // delete/undo. Both provably human — they only flow through UI
        // endpoints.
        _ => true,
    }
}

async fn agent_ws(state: AppState, mut socket: WebSocket) {
    let (mut rx, _guard) = state.hub.subscribe(Role::Agent);
    // Agent subscribers never see raw `state` snapshots — they get the
    // debounced `clients {browsers}` line derived from them, deduplicated on
    // the browser count (a tab reload reads as nothing at all).
    let mut pending: Option<(tokio::time::Instant, usize)> = None;
    let mut last_emitted: i64 = -1;

    loop {
        let deadline = pending.map(|(t, _)| t);
        let debounce = async {
            match deadline {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    None | Some(Err(_)) => break,
                    Some(Ok(_)) => {} // inbound frames are ignored
                }
            }
            _ = debounce => {
                let (_, browsers) = pending.take().unwrap();
                if last_emitted != browsers as i64 {
                    last_emitted = browsers as i64;
                    let frame = serde_json::to_string(&Event::Clients { browsers }).unwrap_or_default();
                    if socket.send(Message::Text(frame.into())).await.is_err() {
                        break;
                    }
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(Event::State { ui_count, .. }) => {
                        pending = Some((
                            tokio::time::Instant::now()
                                + std::time::Duration::from_millis(CLIENTS_DEBOUNCE_MS),
                            ui_count,
                        ));
                    }
                    Ok(event) => {
                        if !agent_visible(&event) {
                            continue;
                        }
                        let terminal = matches!(event, Event::ReviewEnded { .. });
                        let frame = serde_json::to_string(&event).unwrap_or_default();
                        if socket.send(Message::Text(frame.into())).await.is_err() {
                            break;
                        }
                        if terminal {
                            // Close so the Monitor sees a clean end after
                            // review-ended, and graceful shutdown can finish.
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

// ---------- static UI ----------

async fn serve_ui(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(asset) = Assets::get(path) {
        return (
            [(header::CONTENT_TYPE, mime_for(path))],
            asset.data.into_owned(),
        )
            .into_response();
    }
    // SPA fallback.
    match Assets::get("index.html") {
        Some(index) => (
            [(header::CONTENT_TYPE, "text/html")],
            index.data.into_owned(),
        )
            .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "krit was built without an embedded UI (dist/client missing at compile time)",
        )
            .into_response(),
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/diff", get(api_diff))
        .route(
            "/api/file-content",
            get(api_file_content_get).put(api_file_content_put),
        )
        .route("/api/refresh", post(api_refresh))
        .route("/api/edits/delete", post(api_edits_delete))
        .route("/api/edits/undo", post(api_edits_undo))
        .route("/api/settings", get(api_settings_get).put(api_settings_put))
        .route("/api/viewed", get(api_viewed_get).put(api_viewed_put))
        .route(
            "/api/comments",
            get(api_comments_get).post(api_comments_post),
        )
        .route("/api/drafts/post", post(api_drafts_post))
        .route(
            "/api/comments/{id}",
            put(api_comment_put).delete(api_comment_delete),
        )
        .route("/api/comments/{id}/replies", post(api_reply_post))
        .route("/api/submit", get(api_submit_get).post(api_submit_post))
        .route("/api/events", get(api_events))
        .route("/api/events-ws", get(api_events_ws))
        .fallback(serve_ui)
        .with_state(state)
}
