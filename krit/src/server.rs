//! The HTTP surface served by axum. Routes, JSON shapes and event frames
//! still carry diffx v1's shapes, which is where their oddities come from —
//! but the UI and the skill live in this repo, so changing the wire is a
//! matter of changing them alongside it.

use crate::edits::{DeleteRange, splice_delete_range, splice_insert_text};
use crate::git;
use crate::hub::{Hub, Role};
use crate::pathsafe::is_safe_path;
use crate::reanchor::reanchor_file_comments;
use crate::settings::{Loaded, load_settings, save_settings};
use crate::store::{CommentStore, UpdateFields};
use crate::types::{CommentReply, EditRange, Event, ReviewComment, Suggestion, now_millis};
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
// Shared with the TUI client, which builds its own file list from the same
// patch string — see the note on the function.
use krit_core::patch::diff_header_path;
use rust_embed::RustEmbed;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The built React UI, embedded at compile time — the whole artifact is one
/// binary; there is no dist/ to go stale. Debug builds read the folder from
/// disk (fast iteration), release builds embed.
#[derive(RustEmbed)]
#[folder = "../dist/client"]
struct Assets;

const FILE_TEXT_CAP_BYTES: usize = 5 * 1024 * 1024;
/// A second cap on the same contents, because bytes are a poor proxy for what
/// rendering a side actually costs: a 300k-line file of short lines sits well
/// under `FILE_TEXT_CAP_BYTES` and still asks CodeView to build a row model
/// two orders of magnitude past anything a reviewer reads. Whichever cap trips
/// first degrades the file to patch-only.
const FILE_TEXT_CAP_LINES: usize = 50_000;
const UNDO_BUFFER_CAP: usize = 20;

/// `branch_name()` forks `git rev-parse`. A full `/api/diff` refetch (no
/// `file` params) always recomputes it fresh AND refreshes this cache — the
/// watcher can't see `.git/HEAD` change, so nothing here lives forever — but
/// a path-scoped refetch (the hot path a files-changed burst drives) reads
/// the cache instead of forking again. Short enough that a mid-review branch
/// switch is never stale for more than a beat.
const BRANCH_CACHE_TTL: Duration = Duration::from_secs(2);

/// Debounce for the state→clients transform sent to agent (ws) subscribers —
/// long enough that a browser tab reload doesn't read as a leave-then-rejoin.
const CLIENTS_DEBOUNCE_MS: u64 = 4000;

struct UndoEntry {
    id: String,
    file_path: String,
    start_line: u32,
    start_column: u32,
    deleted_text: String,
    /// The file's tag as the delete left it. The undo re-inserts at a raw
    /// line/column, so it must refuse a file that anything else has touched
    /// since — those coordinates would otherwise land in unrelated text.
    expected_tag: crate::edits::DeleteTag,
}

pub struct Inner {
    pub hub: Arc<Hub>,
    pub store: Mutex<CommentStore>,
    pub repo_root: PathBuf,
    pub custom_diff_args: Option<Vec<String>>,
    /// `--base <rev>`: an explicit base for the branch scope, outranking the
    /// `baseBranches` ladder in settings. Any rev, not just a branch.
    pub base_ref: Option<String>,
    /// `Some` only when the bind reaches past this machine — see
    /// `mint_api_token` and `require_api_token`.
    pub api_token: Option<String>,
    viewed: Mutex<HashSet<String>>,
    undo: Mutex<Vec<UndoEntry>>,
    /// Serializes the If-Match check and the write it guards. Without it two
    /// PUTs carrying the same valid tag both pass the check and both write,
    /// which is the loss the tag exists to prevent.
    file_write: Mutex<()>,
    // (value, fetched_at) — see BRANCH_CACHE_TTL.
    branch_cache: Mutex<Option<(String, Instant)>>,
}

pub type AppState = Arc<Inner>;

/// Poison-tolerant lock: one panicked handler must not brick every later
/// request for the session. The guarded values stay internally consistent
/// across a panic (single-writer mutations; worst case a lost in-flight
/// update), so recovering the guard is safe.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn new_state(
    hub: Arc<Hub>,
    store: CommentStore,
    repo_root: PathBuf,
    custom_diff_args: Option<Vec<String>>,
    base_ref: Option<String>,
    api_token: Option<String>,
) -> AppState {
    Arc::new(Inner {
        hub,
        store: Mutex::new(store),
        repo_root,
        custom_diff_args,
        base_ref,
        api_token,
        viewed: Mutex::new(HashSet::new()),
        undo: Mutex::new(Vec::new()),
        file_write: Mutex::new(()),
        branch_cache: Mutex::new(None),
    })
}

/// `state.repo_root`'s own basename. The server knows its root at startup, so
/// this answers without forking — unlike `git::repo_name()`, which is for
/// callers that have no root in hand and must ask `rev-parse --show-toplevel`.
fn repo_name_from_root(state: &AppState) -> String {
    state
        .repo_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Fresh `git::branch_name()`, also refreshing the cache for the next scoped
/// request that reads `cached_branch_name`.
fn refreshed_branch_name(state: &AppState) -> String {
    let name = git::branch_name();
    *lock(&state.branch_cache) = Some((name.clone(), Instant::now()));
    name
}

/// The scoped hot path's branch lookup: reuses a fresh cache entry, only
/// forking `git` if the cache is empty or past `BRANCH_CACHE_TTL`.
fn cached_branch_name(state: &AppState) -> String {
    if let Some((name, fetched_at)) = lock(&state.branch_cache).clone()
        && fetched_at.elapsed() < BRANCH_CACHE_TTL
    {
        return name;
    }
    refreshed_branch_name(state)
}

/// Re-anchors non-resolved additions-side comments on `path` after a
/// working-tree change and broadcasts the movers as comment-updated. Runs
/// once server-side so UI, CLI, and agent can't disagree. Queued comments
/// re-anchor but never broadcast. Sync on purpose: callable from the watcher
/// thread.
pub fn reanchor_and_broadcast(state: &AppState, path: &str) {
    let changed = {
        let mut store = lock(&state.store);
        reanchor_file_comments(path, &mut store, &state.repo_root)
    };
    for comment in changed {
        if comment.status == "queued" {
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

/// A client-supplied repo-relative path that is safe to hand to `git` as a
/// pathspec: traversal-free (`is_safe_path`) and free of pathspec magic,
/// which git spells with a leading `:` (`:(glob)`, `:(exclude)`, `:/`).
fn is_plain_repo_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with(':') && is_safe_path(path)
}

// ---------- diff assembly ----------

fn parse_file_paths(patch: &str) -> Vec<String> {
    // Order-preserving dedup: the Vec keeps first-seen order (the response
    // orders file contents by it), a HashSet does the membership check so a
    // several-thousand-file review isn't O(files²) in `Vec::contains`.
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in patch.lines() {
        if let Some(p) = diff_header_path(line)
            && seen.insert(p.clone())
        {
            paths.push(p);
        }
    }
    paths
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

/// Each requested path's fragment out of `patch`, in request order, empty
/// ("no pending diff for this path") fragments dropped, joined into one
/// patch string. Shared by the 1-file and N-file `?file=` cases in
/// `api_diff` — one implementation, not "N-file logic plus a 1-file
/// special case".
fn join_requested_fragments(patch: &str, files: &[String]) -> String {
    files
        .iter()
        .map(|f| extract_file_patch(patch, f))
        .filter(|f| !f.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Scopes a `path`-keyed JSON array (the `binaryFiles` shape) down to just
/// `files_set` — order preserved.
fn filter_values_by_path<'a>(items: &'a [Value], files_set: &HashSet<&str>) -> Vec<&'a Value> {
    items
        .iter()
        .filter(|v| {
            v["path"]
                .as_str()
                .map(|p| files_set.contains(p))
                .unwrap_or(false)
        })
        .collect()
}

/// Scopes a plain path list (the `untrackedFiles` shape) down to just
/// `files_set` — order preserved.
fn filter_paths_by_set<'a>(paths: &'a [String], files_set: &HashSet<&str>) -> Vec<&'a String> {
    paths
        .iter()
        .filter(|p| files_set.contains(p.as_str()))
        .collect()
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
    if git::looks_binary(&buf) {
        return json!({ "binary": true });
    }
    if buf.len() > FILE_TEXT_CAP_BYTES {
        return json!({ "oversize": true, "size": buf.len() });
    }
    // Counted only once the byte cap has passed, so the scan is bounded by
    // FILE_TEXT_CAP_BYTES rather than by the file.
    let lines = buf.iter().filter(|b| **b == b'\n').count() + 1;
    if lines > FILE_TEXT_CAP_LINES {
        return json!({ "oversize": true, "size": buf.len(), "lines": lines });
    }
    json!({ "contents": String::from_utf8_lossy(&buf) })
}

/// The `baseBranches` setting, as a ladder for `resolve_base_ref`. Non-strings
/// are dropped rather than rejected: this key is read here but owned by the UI
/// (see the settings module header), and one bad entry should cost that entry,
/// not the whole scope. An empty or absent list means the built-in ladder.
fn base_branch_candidates() -> Vec<String> {
    let from_settings: Vec<String> = load_settings()
        .effective
        .get("baseBranches")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    if from_settings.is_empty() {
        return git::DEFAULT_BASE_BRANCHES
            .iter()
            .map(|s| s.to_string())
            .collect();
    }
    from_settings
}

/// What the branch scope diffs against: the merge-base of HEAD and the base
/// branch, so the range is what *this* branch changed and not what landed on the
/// trunk meanwhile.
///
/// The merge-base failing is not fatal — unrelated histories and shallow clones
/// both do it — and falling back to the base ref itself matches what
/// `resolve_diff_refs` already does for a `<a>...<b>` range.
fn resolve_branch_scope_base(state: &AppState) -> Result<String, String> {
    let base = match &state.base_ref {
        Some(explicit) => explicit.clone(),
        None => {
            let candidates = base_branch_candidates();
            git::resolve_base_ref(&state.repo_root, &candidates).ok_or_else(|| {
                format!(
                    "no base branch found: tried {} (each as origin/<name> then local), \
                     and origin/HEAD is not set. Set baseBranches in settings or pass --base.",
                    candidates.join(", ")
                )
            })?
        }
    };
    Ok(git::merge_base_with_head(&state.repo_root, &base).unwrap_or(base))
}

async fn api_diff(
    State(state): State<AppState>,
    Query(params): Query<Vec<(String, String)>>,
) -> Response {
    let is_custom = state.custom_diff_args.is_some();
    let param = |key: &str| {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    let staged = param("staged") == Some("true");
    let untracked = param("untracked") == Some("true");
    // Repeated `file=` params, in request order — repeated keys rather than a
    // delimited list, so a repo-relative path containing a comma or newline
    // never needs escaping. A single `file=` is the pre-existing one-path
    // case: just the 1-element case of the same scoped path below.
    let files: Vec<String> = params
        .iter()
        .filter(|(k, _)| k == "file")
        .map(|(_, v)| v.clone())
        .collect();
    // These reach `git diff --` as pathspecs and double as the scoping keys
    // for fileContents/binaryFiles, so only a plain repo-relative path is
    // usable: pathspec magic would widen or redirect the diff while matching
    // none of the keys.
    if let Some(bad) = files.iter().find(|f| !is_plain_repo_path(f)) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": format!("invalid file param: {bad}")})),
        )
            .into_response();
    }

    // Computed once regardless of scoping, and threaded into git_diff /
    // git_diff_paths below instead of letting either recompute it — the
    // previous version forked `ls-files` a second time just to re-derive the
    // same list this response already needed.
    let untracked_files: Vec<String> = if untracked {
        git::untracked_file_paths(&state.repo_root)
    } else {
        Vec::new()
    };
    let untracked_arg = untracked.then_some(untracked_files.as_slice());

    let patch_result = if let Some(args) = &state.custom_diff_args {
        // An explicit range on the command line outranks any scope: the invoker
        // pinned what this review covers. The UI knows (`customMode`) and does
        // not offer the control.
        git::custom_git_diff(args).map(|p| (p, git::resolve_diff_refs(Some(args))))
    } else if param("scope") == Some("branch") {
        match resolve_branch_scope_base(&state) {
            Ok(base) => {
                let paths = (!files.is_empty()).then_some(files.as_slice());
                git::diff_against_ref(&state.repo_root, &base, untracked_arg, paths)
                    // `staged` has no meaning here — a ref-to-working-tree diff
                    // spans the index either way (see `diff_against_ref`).
                    .map(|p| (p, (base, git::WORKING_TREE_REF.to_string())))
            }
            Err(msg) => Err(msg),
        }
    } else {
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
        // A scoped request (one or more file= params) runs a path-scoped
        // `git diff -- <paths>` instead of diffing the whole repo just to
        // slice fragments back out of it below.
        let diffed = if files.is_empty() {
            git::git_diff(staged, untracked_arg, &state.repo_root)
        } else {
            git::git_diff_paths(staged, untracked_arg, &state.repo_root, &files)
        };
        diffed.map(|p| (p, refs))
    };
    // A failed git diff (typo'd ref, unreadable object) 500s, as in v1: an
    // empty patch is indistinguishable from a clean tree, so serving one
    // would show the reviewer a "no changes" review that isn't true.
    let (patch, refs) = match patch_result {
        Ok(pr) => pr,
        Err(msg) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({"error": format!("git diff failed: {msg}")})),
            )
                .into_response();
        }
    };

    let repo_name = repo_name_from_root(&state);
    // A full refetch refreshes the branch cache; a scoped one reads it.
    let branch = if files.is_empty() {
        refreshed_branch_name(&state)
    } else {
        cached_branch_name(&state)
    };

    let untracked_set: HashSet<String> = untracked_files.iter().cloned().collect();
    let binary_files = parse_binary_files(&patch, &untracked_set);
    let binary_set: HashSet<String> = binary_files
        .iter()
        .filter_map(|b| b["path"].as_str().map(|s| s.to_string()))
        .collect();

    // One or more `file=` params scope the response to just those paths.
    // `patch` (from git_diff_paths / custom_git_diff above) may already
    // cover only the requested files, but extract_file_patch per path still
    // gives request-order concatenation and the "no pending diff for this
    // path" empty-fragment case — one implementation for 1 file and N alike.
    if !files.is_empty() {
        let mut file_contents = serde_json::Map::new();
        for f in &files {
            if binary_set.contains(f) {
                continue;
            }
            file_contents.insert(
                f.clone(),
                json!({
                    "old": read_side(&state.repo_root, f, &refs.0),
                    "new": read_side(&state.repo_root, f, &refs.1),
                }),
            );
        }
        let files_set: HashSet<&str> = files.iter().map(|s| s.as_str()).collect();
        return axum::Json(json!({
            "patch": join_requested_fragments(&patch, &files),
            "repoName": repo_name,
            "branch": branch,
            "customMode": is_custom,
            "binaryFiles": filter_values_by_path(&binary_files, &files_set),
            "untrackedFiles": filter_paths_by_set(&untracked_files, &files_set),
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

/// The ETag here is a concurrency token for PUT's If-Match, not a cache
/// validator: inbound If-None-Match is ignored and every GET re-sends the
/// body. `version=old` serves the HEAD blob, whose tag If-Match could never
/// satisfy — a token that can only produce a permanent 412 is not handed out
/// at all.
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
    if version.as_str() != "new" {
        return ([(header::CONTENT_TYPE, mime_for(path))], content).into_response();
    }
    let tag = git::content_tag(&content);
    (
        [
            (header::CONTENT_TYPE, mime_for(path)),
            (header::ETAG, tag.as_str()),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        content,
    )
        .into_response()
}

async fn api_file_content_put(
    State(state): State<AppState>,
    headers: header::HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let (Some(path), Some(contents)) = (body["path"].as_str(), body["contents"].as_str()) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "path and contents required"})),
        )
            .into_response();
    };
    // Optimistic concurrency, opt-in: a client that tells us what it thinks is
    // on disk gets its write refused if that's no longer true, instead of
    // silently winning the race. Omitting If-Match keeps the original
    // last-writer-wins behaviour, which every pre-existing caller relies on.
    // The check and the write it guards share one lock, or two PUTs holding
    // the same tag would both pass it and the loser's content would vanish.
    let write_guard = lock(&state.file_write);
    if let Some(expected) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) {
        let actual = git::working_tree_content_tag(&state.repo_root, path);
        // RFC 7232: `*` asserts only that a representation exists.
        let matched = if expected == "*" {
            actual.is_some()
        } else {
            actual.as_deref() == Some(expected)
        };
        if !matched {
            return (
                StatusCode::PRECONDITION_FAILED,
                axum::Json(json!({
                    "error": "file changed on disk since it was read",
                    "etag": actual,
                })),
            )
                .into_response();
        }
    }
    if !git::write_working_tree_file(&state.repo_root, path, contents) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "write failed (unsafe path or IO error)"})),
        )
            .into_response();
    }
    drop(write_guard);
    // Re-anchor before broadcasting, so by the time watchers refetch,
    // comment positions already reflect the edit.
    reanchor_and_broadcast(&state, path);
    state.hub.broadcast(Event::FileWritten {
        path: Some(path.to_string()),
    });
    // Hand back the tag the write produced, so a client that stays in the file
    // can keep sending If-Match without a round trip to re-read it.
    axum::Json(json!({"ok": true, "etag": git::content_tag(contents.as_bytes())})).into_response()
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
    // One writer at a time. The tag authorizing the undo comes back from the
    // splice itself (see `Deletion::content_tag`), so it describes this
    // delete's bytes no matter what lands next.
    let spliced = {
        let _guard = lock(&state.file_write);
        splice_delete_range(&state.repo_root, &range)
    };
    let Some(crate::edits::Deletion {
        deleted_text,
        content_tag: expected_tag,
    }) = spliced
    else {
        return (StatusCode::BAD_REQUEST, axum::Json(json!({"error": "delete failed (unsafe path, unreadable file, or range no longer matches the file on disk)"}))).into_response();
    };

    let undo_id = uuid::Uuid::new_v4().to_string();
    {
        let mut undo = lock(&state.undo);
        undo.push(UndoEntry {
            id: undo_id.clone(),
            file_path: file_path.to_string(),
            start_line: range.start_line,
            start_column: range.start_column,
            deleted_text: deleted_text.clone(),
            expected_tag,
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
        let mut undo = lock(&state.undo);
        match undo.iter().position(|e| e.id == id) {
            Some(idx) => undo.remove(idx),
            None => {
                return (StatusCode::NOT_FOUND, axum::Json(json!({"error": "nothing to undo for that id (already undone, evicted, or never existed)"}))).into_response();
            }
        }
    };
    let spliced = {
        let _guard = lock(&state.file_write);
        splice_insert_text(
            &state.repo_root,
            &entry.file_path,
            entry.start_line,
            entry.start_column,
            &entry.deleted_text,
            &entry.expected_tag,
        )
    };
    if let Err(err) = spliced {
        // 409 for the one failure the caller can act on — re-read the file and
        // decide — and 400 for the rest, which no retry fixes.
        let status = match err {
            crate::edits::SpliceError::ContentChanged => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        return (
            status,
            axum::Json(json!({"error": format!("undo failed ({err})")})),
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

// ---------- pending drafts (text still being typed) ----------
//
// Deliberately not broadcast. Every other mutation here fans out on SSE so the
// other tab catches up, but a draft is one reviewer mid-sentence: echoing each
// keystroke back would fight the form it came from, and there is no second
// author to inform. Nor does any of this reach `/api/events-ws` — unsent text is
// not the agent's business until the reviewer submits it. Hydrate on load,
// write on change; that is the whole contract.

async fn api_pending_get(State(state): State<AppState>) -> Response {
    axum::Json(lock(&state.store).pending_all()).into_response()
}

async fn api_pending_put(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let draft: crate::types::PendingDraft = match serde_json::from_value(body) {
        Ok(draft) => draft,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({"error": format!("not a pending draft: {err}")})),
            )
                .into_response();
        }
    };
    if !is_plain_repo_path(&draft.file_path) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "filePath must be a plain repo-relative path"})),
        )
            .into_response();
    }
    lock(&state.store).upsert_pending(draft);
    axum::Json(json!({"ok": true})).into_response()
}

async fn api_pending_delete(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let (Some(file_path), Some(side), Some(start_line), Some(end_line)) = (
        body["filePath"].as_str(),
        body["side"].as_str(),
        body["startLine"].as_u64(),
        body["endLine"].as_u64(),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "filePath, side, startLine and endLine are required"})),
        )
            .into_response();
    };
    let removed =
        lock(&state.store).remove_pending(file_path, side, start_line as u32, end_line as u32);
    axum::Json(json!({"ok": true, "removed": removed})).into_response()
}

// ---------- settings + viewed ----------

/// The effective settings, carrying `settingsError` when the file on disk could
/// not be used. Server-managed metadata rather than a setting, like
/// `schemaVersion` — it is injected here and never written back to the file,
/// and the UI renders it as a strip rather than silently running on defaults.
fn settings_response(loaded: Loaded) -> Response {
    let mut body = loaded.effective;
    if let (Some(error), Value::Object(map)) = (loaded.error, &mut body) {
        map.insert("settingsError".into(), Value::String(error));
    }
    axum::Json(body).into_response()
}

async fn api_settings_get() -> Response {
    settings_response(load_settings())
}

async fn api_settings_put(axum::Json(body): axum::Json<Value>) -> Response {
    settings_response(save_settings(&body))
}

async fn api_viewed_get(State(state): State<AppState>) -> Response {
    let viewed = lock(&state.viewed);
    axum::Json(viewed.iter().cloned().collect::<Vec<_>>()).into_response()
}

async fn api_viewed_put(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let file_path = body["filePath"].as_str().unwrap_or_default().to_string();
    let viewed_flag = body["viewed"].as_bool().unwrap_or(false);
    let mut viewed = lock(&state.viewed);
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
    let comments = lock(&state.store).get_all();
    // Queued comments are opt-in: only the browser UI passes
    // includeQueued=true. Everyone else gets the agent-visible view, matching
    // the broadcast suppression — `krit comments` must not leak unposted work.
    if params.get("includeQueued").map(|v| v == "true") == Some(true) {
        return axum::Json(comments).into_response();
    }
    let visible: Vec<ReviewComment> = comments
        .into_iter()
        .filter(|c| c.status != "queued")
        .collect();
    axum::Json(visible).into_response()
}

async fn api_comments_post(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    // filePath/side/lineNumber are the anchor: a comment stored with a
    // defaulted one is durable garbage that no filter and no UI can place, so
    // they are required and checked against the shared schema's domains
    // rather than defaulted.
    let (Some(file_path), Some(side), Some(line_number)) = (
        body["filePath"].as_str(),
        body["side"].as_str(),
        body["lineNumber"].as_u64(),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "filePath, side and lineNumber required"})),
        )
            .into_response();
    };
    if !is_plain_repo_path(file_path) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "invalid filePath"})),
        )
            .into_response();
    }
    if side != "deletions" && side != "additions" {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "side must be 'deletions' or 'additions'"})),
        )
            .into_response();
    }
    let line_number = line_number as u32;
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
    // Only the UI queues comments; anything else in the field is ignored.
    let status = if body["status"].as_str() == Some("queued") {
        "queued"
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
        file_path: file_path.to_string(),
        side: side.to_string(),
        line_number,
        // Absent, not echoed, for a single-line comment — the shape types.rs
        // documents and its snapshot test pins.
        end_line: (end_line != line_number).then_some(end_line),
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
    let created = lock(&state.store).add(comment);
    // A queued comment stays invisible to the agent until posted.
    if created.status != "queued" {
        state.hub.broadcast(Event::CommentAdded {
            comment: created.clone(),
        });
    }
    (StatusCode::CREATED, axum::Json(created)).into_response()
}

/// Flips every queued comment to open in one batch, broadcasting comment-added
/// for each — the moment they become visible. Shared by "Post queued" and by
/// /api/submit (Done reviewing must not strand queued comments).
fn post_queued_and_broadcast(state: &AppState) -> usize {
    let posted: Vec<ReviewComment> = {
        let mut store = lock(&state.store);
        let queued: Vec<String> = store
            .get_all()
            .into_iter()
            .filter(|c| c.status == "queued")
            .map(|c| c.id)
            .collect();
        queued
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

async fn api_queued_post(State(state): State<AppState>) -> Response {
    let posted = post_queued_and_broadcast(&state);
    axum::Json(json!({"ok": true, "posted": posted})).into_response()
}

async fn api_comment_put(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    axum::Json(payload): axum::Json<Value>,
) -> Response {
    let new_status = payload["status"].as_str().map(|s| s.to_string());
    // The three-way union src/types.ts declares. A status outside it matches
    // no filter anywhere — `krit comments open` and `resolved` both skip it
    // while the agent stream still shows it.
    if let Some(s) = &new_status
        && !matches!(s.as_str(), "open" | "resolved" | "queued")
    {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "status must be 'open', 'resolved' or 'queued'"})),
        )
            .into_response();
    }
    let (was_queued, updated) = {
        let mut store = lock(&state.store);
        // Only meaningful when a status change was requested: None = no status
        // in the payload.
        let was_queued: Option<bool> = new_status
            .as_ref()
            .map(|_| store.get(&id).map(|c| c.status == "queued") == Some(true));
        let updated = store.update(
            &id,
            UpdateFields {
                body: payload["body"].as_str().map(|s| s.to_string()),
                status: new_status.clone(),
                ..Default::default()
            },
        );
        (was_queued, updated)
    };
    let Some(updated) = updated else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "Comment not found"})),
        )
            .into_response();
    };
    // A queued comment posted one-off through this route needs its catch-up
    // comment-added broadcast — it never got one at creation.
    if was_queued == Some(true) && new_status.as_deref() != Some("queued") {
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
    let removed = lock(&state.store).remove(&id);
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
        let mut store = lock(&state.store);
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

/// Concluding notes from the Done-reviewing box. The whole body is optional —
/// older callers (and `curl -X POST /api/submit`) send nothing at all — so this
/// is read leniently: no body, an empty body, or unparseable JSON all mean "no
/// summary" rather than a 400. Refusing to end a review over a malformed
/// courtesy field would be the wrong trade.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct SubmitBody {
    summary: Option<String>,
}

/// The concluding notes a request actually carries, or None.
///
/// Whitespace-only is the same as untyped: the reviewer opened the box, hit
/// space, and finished — nothing downstream should relay that as notes.
fn parse_submit_summary(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<SubmitBody>(body).unwrap_or_default();
    let trimmed = parsed.summary?.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

async fn api_submit_post(State(state): State<AppState>, body: String) -> Response {
    // Done reviewing must not leave forgotten queued comments stranded — post
    // first.
    post_queued_and_broadcast(&state);
    let summary = parse_submit_summary(&body);
    let ts = now_millis();
    state.hub.broadcast(Event::Submitted {
        timestamp: ts,
        summary: summary.clone(),
    });
    // After the broadcast, so a tab still open sees `submitted` and can close
    // itself. If this was the only tab, its disconnect ends the server; if
    // others are still watching, nothing happens until the last one leaves.
    state.hub.mark_submitted();
    axum::Json(json!({"ok": true, "timestamp": ts, "summary": summary})).into_response()
}

/// v1 contract quirk: GET on /api/submit is the subscriber-presence probe the
/// UI polls (it gates the Done-reviewing button) — not a dry-run of POST.
/// Kept on this route for wire compatibility.
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

/// Only an explicit `role=ui` counts as a browser. Browser presence gates
/// idle shutdown and the Done-reviewing button, so the default has to be the
/// one that can't hold a review open forever: an unlabelled subscriber — a
/// curl, a script, a consumer written before this parameter existed — is a
/// CLI. The UI says what it is (`src/ui/hooks/useDiff.ts`,
/// `useReviewState.ts`, both pinned by a Vitest test).
fn subscriber_role(role: Option<&str>) -> Role {
    if role == Some("ui") {
        Role::Ui
    } else {
        Role::Cli
    }
}

async fn api_events(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Sse<impl futures_core::Stream<Item = Result<SseEvent, std::convert::Infallible>>> {
    let role = subscriber_role(params.get("role").map(|s| s.as_str()));
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
/// the ambient events (fs-watcher files-changed, the agent's own `krit
/// refresh` echo, comment-updated re-anchor fallout) are usually caused by
/// the agent's own edits — it would be paying to listen to itself work. The
/// UI keeps receiving all of these over SSE; the agent sees current comment
/// positions/outdated flags via the CLI whenever it acts on a comment.
fn agent_visible(event: &Event) -> bool {
    match event {
        Event::FileChanged { .. } => false,
        Event::FilesChanged { .. } => false,
        Event::FileWritten { path: None } => false, // agent's own refresh
        Event::CommentUpdated { .. } => false,
        // file-written{path} = krit editor save; user-edit = direct
        // delete/undo. Human by convention, not proof: only the browser UI
        // calls those routes today, but they're ordinary HTTP endpoints — an
        // agent that starts calling them will hear its own edits.
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

/// The host part of an `authority` (`host`, `host:port`, `[v6]:port`).
fn authority_host(authority: &str) -> &str {
    match authority.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => authority.split(':').next().unwrap_or(authority),
    }
}

/// True for an authority that names this machine directly rather than through
/// DNS: a literal address, or `localhost`.
fn is_local_authority(authority: &str) -> bool {
    let host = authority_host(authority);
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok()
}

/// DNS-rebinding defense. A loopback client needs no token (see
/// `require_api_token`), so a page the user merely visits could otherwise
/// point a hostname it owns at that port and drive the API — including
/// reading file contents — as same-origin requests from the one position
/// that is exempt. Names resolved through DNS are therefore refused;
/// only literal addresses and `localhost`, neither of which an attacker can
/// repoint, are honoured. A cross-site `Origin` is refused for the same
/// reason; a request with no Origin at all is a non-browser client (the CLI,
/// the agent's ws Monitor, curl) and passes.
async fn guard_local_requests(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| h.to_string())
        .or_else(|| req.uri().authority().map(|a| a.to_string()));
    if !host.as_deref().map(is_local_authority).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, "krit: refusing a non-local Host").into_response();
    }
    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        let authority = origin
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(origin);
        if !is_local_authority(authority) {
            return (StatusCode::FORBIDDEN, "krit: refusing a cross-site Origin").into_response();
        }
    }
    next.run(req).await
}

// ---------- access token ----------
//
// The token travels as `krit_token`: a query param on the launch URL, which
// the first response converts into a cookie the browser replays on every
// later request. fetch, EventSource and WebSocket all send same-origin
// cookies, so nothing in the UI has to know the token exists.

/// True for a bind that only accepts connections originating on this machine.
pub fn is_loopback_bind(host: &str) -> bool {
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// The session's API token, minted only for a bind that is reachable from
/// other machines. A loopback bind gets `None`: the port is already
/// unreachable off-box, so there is no secret to print, store or leak, and
/// every existing local workflow keeps working untouched.
///
/// 122 bits from the OS CSPRNG — `uuid` v4 draws from `getrandom`, which is
/// why this needs no crate of its own.
pub fn mint_api_token(host: &str) -> Option<String> {
    (!is_loopback_bind(host)).then(|| uuid::Uuid::new_v4().simple().to_string())
}

fn token_from_query(query: &str) -> Option<&str> {
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("krit_token="))
}

fn token_from_cookie(cookie_header: &str) -> Option<&str> {
    cookie_header
        .split(';')
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix("krit_token="))
}

/// Length-independent-of-position comparison: a byte-by-byte early return
/// would let a caller who can time requests recover the token one byte at a
/// time.
fn secret_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// The whole authorization rule, in one predicate.
///
/// No token (loopback bind) means the server is exactly as open as it always
/// was. With a token, a peer that is this machine still needs none — the CLI
/// subcommands, the agent's WebSocket and the auto-opened browser all connect
/// over loopback even when the listener is bound to `0.0.0.0`, so the two
/// modes differ only for the requests that a loopback bind would never have
/// accepted at all.
fn is_authorized(token: Option<&str>, peer_is_local: bool, presented: Option<&str>) -> bool {
    match token {
        None => true,
        Some(_) if peer_is_local => true,
        Some(expected) => presented.map(|p| secret_eq(p, expected)) == Some(true),
    }
}

/// Whether the peer that opened this connection is on this machine — the one
/// fact that decides whether the token is demanded. Absent connect info fails
/// closed: without a peer address there is no evidence of where it came from.
fn peer_is_local(req: &axum::extract::Request) -> bool {
    req.extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().is_loopback())
        .unwrap_or(false)
}

async fn require_api_token(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Some(expected) = state.api_token.as_deref() else {
        return next.run(req).await;
    };
    let peer_is_local = peer_is_local(&req);
    let (authorized, carried_in_url) = {
        let from_query = req.uri().query().and_then(token_from_query);
        let from_cookie = req
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(token_from_cookie);
        (
            is_authorized(Some(expected), peer_is_local, from_query.or(from_cookie)),
            from_query.is_some(),
        )
    };
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            "krit: this server is bound to a non-loopback address, so requests from other \
             machines must carry the access token krit printed at startup \
             (?krit_token=... on the URL, which then sets a cookie)",
        )
            .into_response();
    }
    let mut res = next.run(req).await;
    // Hand the browser a cookie the moment it arrives with the token in the
    // URL, so the token need not be threaded through every later API call.
    // HttpOnly keeps it out of `document.cookie`; SameSite=Strict keeps a
    // third-party page from riding it.
    if carried_in_url
        && let Ok(value) = header::HeaderValue::from_str(&format!(
            "krit_token={expected}; Path=/; HttpOnly; SameSite=Strict"
        ))
    {
        res.headers_mut().insert(header::SET_COOKIE, value);
    }
    res
}

/// KRIT_LOG=1 traces every request — debugging aid for embedded-webview
/// clients where devtools aren't reachable.
async fn log_requests(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if std::env::var("KRIT_LOG").is_err() {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let uri = req.uri().clone();
    let res = next.run(req).await;
    eprintln!("krit: {method} {uri} -> {}", res.status());
    res
}

pub fn build_router(state: AppState) -> Router {
    let auth_state = state.clone();
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
        .route("/api/queued/post", post(api_queued_post))
        .route(
            "/api/pending-drafts",
            get(api_pending_get).put(api_pending_put),
        )
        .route("/api/pending-drafts/delete", post(api_pending_delete))
        .route(
            "/api/comments/{id}",
            put(api_comment_put).delete(api_comment_delete),
        )
        .route("/api/comments/{id}/replies", post(api_reply_post))
        .route("/api/submit", get(api_submit_get).post(api_submit_post))
        .route("/api/events", get(api_events))
        .route("/api/events-ws", get(api_events_ws))
        .fallback(serve_ui)
        .layer(axum::middleware::from_fn(log_requests))
        // Above the log and every handler, below the rebinding guard:
        // rebinding protection and authentication are independent controls,
        // and neither answer depends on the other's.
        .layer(axum::middleware::from_fn_with_state(
            auth_state,
            require_api_token,
        ))
        // Outermost: a rebound request is refused before any handler or the
        // request log sees it.
        .layer(axum::middleware::from_fn(guard_local_requests))
        .with_state(state)
}
#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/src/a.rs b/src/a.rs\nindex 111..222 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/img.png b/img.png\nnew file mode 100644\nBinary files /dev/null and b/img.png differ\ndiff --git a/b.txt b/b.txt\ndeleted file mode 100644\nBinary files a/b.txt and /dev/null differ";

    /// In-memory state (no comment-store file, no custom diff args) rooted at
    /// the crate's own cwd — good enough for the branch-cache tests below,
    /// which only need `state.branch_cache` and a repo that `git` can read.
    fn test_state() -> AppState {
        new_state(
            Hub::new(),
            CommentStore::new(None),
            std::env::current_dir().unwrap(),
            None,
            None,
            None,
        )
    }

    #[test]
    fn submit_reads_concluding_notes_when_they_are_there() {
        assert_eq!(
            parse_submit_summary(r#"{"summary":"ship it"}"#),
            Some("ship it".to_string())
        );
        // Trimmed, so the textarea's trailing newline never reaches an agent.
        assert_eq!(
            parse_submit_summary("{\"summary\":\"  ship it\\n\"}"),
            Some("ship it".to_string())
        );
        // Interior newlines are the reviewer's paragraphs and must survive.
        assert_eq!(
            parse_submit_summary("{\"summary\":\"one\\n\\ntwo\"}"),
            Some("one\n\ntwo".to_string())
        );
    }

    #[test]
    fn a_review_can_always_be_ended_whatever_the_body_looks_like() {
        // Every one of these means "no notes", not "bad request". Refusing to
        // end a review over a malformed courtesy field would strand the
        // reviewer in the UI with no way out but killing the server; the
        // no-body case is also how `curl -X POST /api/submit` and every
        // pre-existing caller behaves.
        for body in [
            "",
            "{}",
            r#"{"summary":null}"#,
            r#"{"summary":""}"#,
            r#"{"summary":"   \n  "}"#,
            "not json at all",
            r#"{"summary":42}"#,
            r#"{"summary":"x""#,
        ] {
            assert_eq!(parse_submit_summary(body), None, "body: {body:?}");
        }
    }

    #[test]
    fn parses_file_paths_in_order() {
        assert_eq!(
            parse_file_paths(PATCH),
            vec!["src/a.rs", "img.png", "b.txt"]
        );
    }

    #[test]
    fn parse_file_paths_dedupes_keeping_first_seen_order() {
        // A repeated header for an already-seen file collapses to one entry,
        // and first-seen order is preserved (the response orders by it).
        let patch = "diff --git a/z.rs b/z.rs\n@@ -1 +1 @@\n-a\n+b\n\
                     diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-c\n+d\n\
                     diff --git a/z.rs b/z.rs\n@@ -2 +2 @@\n-e\n+f";
        assert_eq!(parse_file_paths(patch), vec!["z.rs", "a.rs"]);
    }

    #[test]
    fn extracts_one_file_fragment() {
        let frag = extract_file_patch(PATCH, "src/a.rs");
        assert!(frag.starts_with("diff --git a/src/a.rs"));
        assert!(frag.ends_with("+new"));
        assert!(!frag.contains("img.png"));
        assert_eq!(extract_file_patch(PATCH, "absent.rs"), "");
    }

    /// One binary entry per `change_type` `parse_binary_files` can produce:
    /// a new file the untracked set also knows about, a new file it does not,
    /// a delete, and a plain modification (no mode line at all).
    const BINARY_PATCH: &str = concat!(
        "diff --git a/img.png b/img.png\nnew file mode 100644\n",
        "Binary files /dev/null and b/img.png differ\n",
        "diff --git a/added.bin b/added.bin\nnew file mode 100644\n",
        "Binary files /dev/null and b/added.bin differ\n",
        "diff --git a/b.txt b/b.txt\ndeleted file mode 100644\n",
        "Binary files a/b.txt and /dev/null differ\n",
        "diff --git a/logo.ico b/logo.ico\nindex 111..222 100644\n",
        "Binary files a/logo.ico and b/logo.ico differ",
    );

    #[test]
    fn classifies_binary_files() {
        // The untracked set outranks the patch's own `new file mode`, but only
        // for the paths actually in it — `added.bin` stays `added`.
        let untracked: HashSet<String> = ["img.png".to_string()].into();
        let bins = parse_binary_files(BINARY_PATCH, &untracked);
        assert_eq!(
            bins,
            vec![
                json!({"path": "img.png", "type": "untracked"}),
                json!({"path": "added.bin", "type": "added"}),
                json!({"path": "b.txt", "type": "deleted"}),
                json!({"path": "logo.ico", "type": "changed"}),
            ]
        );
    }

    #[test]
    fn a_path_containing_b_slash_is_keyed_by_its_whole_name() {
        // `foo b/bar.rs` puts a second `" b/"` inside each side of the header,
        // so the first separator splits in the wrong place. `diff_header_path`
        // and its cases are krit-core's; what this pins is that the routes
        // built on it agree — this key is what scoped refetch and comment
        // anchoring look each other up by, and a disagreement silently
        // detaches comments from the file.
        let header = "diff --git a/foo b/bar.rs b/foo b/bar.rs";
        let patch = format!("{header}\nindex 111..222 100644\n@@ -1 +1 @@\n-old\n+new");
        let frag = extract_file_patch(&patch, "foo b/bar.rs");
        assert!(frag.starts_with(header), "{frag}");
        assert!(frag.ends_with("+new"));
        assert_eq!(parse_file_paths(&patch), vec!["foo b/bar.rs"]);
    }

    // ---------- multi-file /api/diff assembly ----------
    //
    // `join_requested_fragments` / `filter_values_by_path` /
    // `filter_paths_by_set` are the pure pieces `api_diff`'s `file=`-scoped
    // branch is built from — tested directly rather than through a full
    // axum handler.

    #[test]
    fn join_requested_fragments_pulls_only_the_requested_paths_in_request_order() {
        // Request order (b.txt, then src/a.rs) is the reverse of PATCH's own
        // header order — the joined result must follow the request, not the
        // patch.
        let files = vec!["b.txt".to_string(), "src/a.rs".to_string()];
        let joined = join_requested_fragments(PATCH, &files);
        assert!(joined.starts_with("diff --git a/b.txt"));
        assert!(joined.contains("diff --git a/src/a.rs"));
        assert!(!joined.contains("img.png"));
    }

    #[test]
    fn join_requested_fragments_drops_paths_with_no_pending_diff() {
        // "reverted between the watcher event and this request" — an absent
        // path contributes nothing, not an empty fragment marker.
        let files = vec!["src/a.rs".to_string(), "absent.rs".to_string()];
        let joined = join_requested_fragments(PATCH, &files);
        assert!(joined.starts_with("diff --git a/src/a.rs"));
        assert!(joined.ends_with("+new"));
    }

    #[test]
    fn join_requested_fragments_single_file_matches_the_multi_file_shape() {
        // A single `file=` must produce the exact same fragment text as the
        // same file requested alongside others — the 1-file case is not a
        // separate code path.
        let one = vec!["src/a.rs".to_string()];
        let two = vec!["src/a.rs".to_string(), "b.txt".to_string()];
        let single = join_requested_fragments(PATCH, &one);
        let multi = join_requested_fragments(PATCH, &two);
        assert!(!single.is_empty());
        assert!(multi.starts_with(&single));
    }

    #[test]
    fn filter_values_by_path_scopes_binary_files_to_the_requested_set() {
        let untracked: HashSet<String> = ["img.png".to_string()].into();
        let bins = parse_binary_files(PATCH, &untracked);
        let files_set: HashSet<&str> = ["b.txt"].into_iter().collect();
        let scoped = filter_values_by_path(&bins, &files_set);
        assert_eq!(scoped, vec![&json!({"path": "b.txt", "type": "deleted"})]);
    }

    #[test]
    fn filter_paths_by_set_scopes_untracked_files_to_the_requested_set() {
        let untracked = vec!["img.png".to_string(), "other.png".to_string()];
        let files_set: HashSet<&str> = ["img.png"].into_iter().collect();
        let scoped = filter_paths_by_set(&untracked, &files_set);
        assert_eq!(scoped, vec![&"img.png".to_string()]);
    }

    // ---------- request-origin guard ----------

    #[test]
    fn local_authorities_are_accepted() {
        assert!(is_local_authority("127.0.0.1:8080"));
        assert!(is_local_authority("localhost:8080"));
        assert!(is_local_authority("LocalHost"));
        assert!(is_local_authority("[::1]:8080"));
        assert!(is_local_authority("192.168.1.7:8080"));
    }

    #[test]
    fn dns_names_are_rejected() {
        // The rebinding vector: a name the attacker controls, resolving to
        // this loopback port.
        assert!(!is_local_authority("evil.example.com:8080"));
        assert!(!is_local_authority("localhost.evil.com"));
        assert!(!is_local_authority("null"));
    }

    // ---------- access token ----------

    #[test]
    fn only_a_non_loopback_bind_mints_a_token() {
        assert!(is_loopback_bind("127.0.0.1"));
        assert!(is_loopback_bind("127.5.5.5"));
        assert!(is_loopback_bind("::1"));
        assert!(is_loopback_bind("localhost"));
        assert!(!is_loopback_bind("0.0.0.0"));
        assert!(!is_loopback_bind("192.168.1.7"));
        assert!(mint_api_token("127.0.0.1").is_none());
        let token = mint_api_token("0.0.0.0").expect("non-loopback bind mints a token");
        assert_eq!(token.len(), 32);
        assert_ne!(token, mint_api_token("0.0.0.0").unwrap());
    }

    #[test]
    fn authorization_turns_on_only_for_off_machine_peers() {
        // Loopback bind: no token exists, so nothing is ever demanded.
        assert!(is_authorized(None, true, None));
        assert!(is_authorized(None, false, None));
        // Token minted, but a peer on this machine is exempt — that is what
        // keeps the CLI, the agent ws and the auto-opened tab working.
        assert!(is_authorized(Some("secret"), true, None));
        // Off-machine: missing, wrong and right. These results are all `==`
        // would give too; the comparison goes through `secret_eq` for a
        // property no assertion here can observe — it must not return early on
        // the first differing byte, or a caller who can time requests recovers
        // the token one byte at a time. Keep `secret_eq`, don't "simplify".
        assert!(!is_authorized(Some("secret"), false, None));
        assert!(!is_authorized(Some("secret"), false, Some("")));
        assert!(!is_authorized(Some("secret"), false, Some("secre")));
        assert!(!is_authorized(Some("secret"), false, Some("Secret")));
        assert!(is_authorized(Some("secret"), false, Some("secret")));
    }

    #[test]
    fn token_is_read_from_either_query_or_cookie() {
        assert_eq!(token_from_query("krit_token=abc"), Some("abc"));
        assert_eq!(token_from_query("file=x&krit_token=abc"), Some("abc"));
        assert_eq!(token_from_query("krit_tokens=abc"), None);
        assert_eq!(token_from_query("file=x"), None);
        assert_eq!(token_from_cookie("krit_token=abc"), Some("abc"));
        assert_eq!(token_from_cookie("other=1; krit_token=abc"), Some("abc"));
        assert_eq!(token_from_cookie("other=1"), None);
    }

    #[test]
    fn only_an_explicit_role_ui_counts_as_a_browser() {
        assert_eq!(subscriber_role(Some("ui")), Role::Ui);
        // Everything else is a CLI. The pre-2026-07 default was the reverse,
        // which let a bare `curl /api/events` set ever_had_browser and keep a
        // finished review alive until the process was killed by hand.
        assert_eq!(subscriber_role(None), Role::Cli);
        assert_eq!(subscriber_role(Some("cli")), Role::Cli);
        assert_eq!(subscriber_role(Some("agent")), Role::Cli);
        assert_eq!(subscriber_role(Some("UI")), Role::Cli);
        assert_eq!(subscriber_role(Some("")), Role::Cli);
    }

    // ---------- token middleware, end to end ----------

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef";

    /// Serves `build_router` on a fresh loopback port and returns it.
    /// `with_connect_info` false drops the peer address, which is exactly how
    /// the middleware sees an off-machine request: it fails closed, so this
    /// exercises the token-required path without needing a second host.
    fn spawn_server(
        rt: &tokio::runtime::Runtime,
        token: Option<String>,
        with_connect_info: bool,
    ) -> u16 {
        spawn_server_rooted(
            rt,
            token,
            with_connect_info,
            std::env::current_dir().unwrap(),
        )
    }

    fn spawn_server_rooted(
        rt: &tokio::runtime::Runtime,
        token: Option<String>,
        with_connect_info: bool,
        repo_root: PathBuf,
    ) -> u16 {
        spawn_server_full(rt, token, with_connect_info, repo_root, None)
    }

    fn spawn_server_full(
        rt: &tokio::runtime::Runtime,
        token: Option<String>,
        with_connect_info: bool,
        repo_root: PathBuf,
        base_ref: Option<String>,
    ) -> u16 {
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let router = build_router(new_state(
                Hub::new(),
                CommentStore::new(None),
                repo_root,
                None,
                base_ref,
                token,
            ));
            tokio::spawn(async move {
                let _ = if with_connect_info {
                    axum::serve(
                        listener,
                        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                    )
                    .await
                } else {
                    axum::serve(listener, router).await
                };
            });
            port
        })
    }

    #[test]
    fn a_loopback_peer_is_served_without_a_token() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let port = spawn_server(&rt, Some(TEST_TOKEN.to_string()), true);
        let res = ureq::get(&format!("http://127.0.0.1:{port}/api/comments"))
            .call()
            .expect("loopback peer needs no token even with one minted");
        assert_eq!(res.status(), 200);
    }

    #[test]
    fn a_loopback_bind_mints_nothing_and_demands_nothing() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        // No token and no peer address: still open, because a loopback bind
        // must behave exactly as it did before any of this existed.
        let port = spawn_server(&rt, None, false);
        let res = ureq::get(&format!("http://127.0.0.1:{port}/api/comments"))
            .call()
            .expect("no token configured means no token required");
        assert_eq!(res.status(), 200);
    }

    #[test]
    fn an_off_machine_peer_needs_the_right_token() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let port = spawn_server(&rt, Some(TEST_TOKEN.to_string()), false);
        let base = format!("http://127.0.0.1:{port}/api/comments");

        // 401, not a 404 or a hang: the caller learns what is wrong.
        let missing = ureq::get(&base).call().unwrap_err();
        assert!(matches!(&missing, ureq::Error::Status(401, _)), "{missing}");
        let wrong = ureq::get(&format!("{base}?krit_token=wrong"))
            .call()
            .unwrap_err();
        assert!(matches!(&wrong, ureq::Error::Status(401, _)), "{wrong}");

        // The token in the URL is accepted and handed back as a cookie, which
        // is the whole reason the UI needs no change.
        let ok = ureq::get(&format!("{base}?krit_token={TEST_TOKEN}"))
            .call()
            .expect("the minted token is accepted");
        assert_eq!(ok.status(), 200);
        let cookie = ok.header("set-cookie").expect("token becomes a cookie");
        assert!(
            cookie.starts_with(&format!("krit_token={TEST_TOKEN}")),
            "{cookie}"
        );
        assert!(cookie.contains("HttpOnly"), "{cookie}");

        // And that cookie alone authorizes the next request.
        let replayed = ureq::get(&base)
            .set("Cookie", &format!("krit_token={TEST_TOKEN}"))
            .call()
            .expect("the cookie authorizes later calls");
        assert_eq!(replayed.status(), 200);
    }

    /// A request carrying `ConnectInfo` for `peer`, as axum's
    /// `into_make_service_with_connect_info` would attach it.
    fn request_from(peer: &str) -> axum::extract::Request {
        let mut req = axum::extract::Request::new(axum::body::Body::empty());
        req.extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::new(
                peer.parse().unwrap(),
                4321,
            )));
        req
    }

    #[test]
    fn only_a_loopback_peer_address_counts_as_this_machine() {
        assert!(peer_is_local(&request_from("127.0.0.1")));
        assert!(peer_is_local(&request_from("::1")));
        // The case the token exists for: a real off-box peer, reaching a
        // `0.0.0.0` bind. It has connect info, so the fail-closed arm below
        // never sees it — only the loopback test itself can refuse it.
        assert!(!peer_is_local(&request_from("192.168.1.7")));
        assert!(!peer_is_local(&request_from("8.8.8.8")));
        // No connect info at all: no evidence of locality, so no exemption.
        assert!(!peer_is_local(&axum::extract::Request::new(
            axum::body::Body::empty()
        )));
    }

    // ---------- rebinding guard, through the router ----------

    /// A hand-rolled GET, because the point is to send headers (`Host`,
    /// `Origin`) that an HTTP client derives from the URL and will not let a
    /// caller contradict. Returns the response's status code.
    fn raw_get(port: u16, path: &str, headers: &str) -> u16 {
        use std::io::{Read, Write};
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let request = format!("GET {path} HTTP/1.1\r\n{headers}Connection: close\r\n\r\n");
        sock.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        sock.read_to_string(&mut response).unwrap();
        response
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("no status line in {response:?}"))
    }

    #[test]
    fn a_rebound_host_is_refused_by_the_router() {
        // The layer, not just `is_local_authority`: this is what makes the
        // loopback token exemption safe, so it must be un-deletable from
        // `build_router` without a red test.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let port = spawn_server(&rt, None, true);
        assert_eq!(
            raw_get(port, "/api/comments", "Host: evil.example.com\r\n"),
            403
        );
    }

    #[test]
    fn a_cross_site_origin_is_refused_but_a_same_origin_one_is_served() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let port = spawn_server(&rt, None, true);
        let host = format!("Host: 127.0.0.1:{port}\r\n");
        assert_eq!(
            raw_get(
                port,
                "/api/comments",
                &format!("{host}Origin: https://evil.example.com\r\n"),
            ),
            403
        );
        // And the guard is a filter, not a blanket deny: the UI's own page
        // sends an Origin on every fetch.
        assert_eq!(
            raw_get(
                port,
                "/api/comments",
                &format!("{host}Origin: http://127.0.0.1:{port}\r\n"),
            ),
            200
        );
    }

    // ---------- pending drafts ----------

    #[test]
    fn pending_drafts_round_trip_and_reject_a_path_outside_the_repo() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let port = spawn_server(&rt, None, true);
        let url = format!("http://127.0.0.1:{port}/api/pending-drafts");
        let draft = json!({
            "filePath": "src/a.rs",
            "side": "additions",
            "startLine": 10,
            "endLine": 12,
            "body": "half a thought",
            "suggestMode": false,
            "suggestionText": "",
            "updatedAt": 1
        });

        ureq::put(&url).send_json(draft.clone()).expect("put lands");
        let listed: Value = ureq::get(&url).call().unwrap().into_json().unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["body"], "half a thought");

        // The same guard `file=` params get: a draft keyed to `../../etc` would
        // put an attacker-chosen path into a store the UI reads back.
        let escaped = ureq::put(&url)
            .send_json(json!({
                "filePath": "../../etc/passwd",
                "side": "additions",
                "startLine": 1, "endLine": 1,
                "body": "x", "suggestMode": false, "suggestionText": "",
                "updatedAt": 1
            }))
            .unwrap_err();
        assert!(
            matches!(escaped, ureq::Error::Status(400, _)),
            "a path outside the repo must be refused: {escaped:?}"
        );

        let deleted: Value = ureq::post(&format!("{url}/delete"))
            .send_json(json!({
                "filePath": "src/a.rs", "side": "additions",
                "startLine": 10, "endLine": 12
            }))
            .unwrap()
            .into_json()
            .unwrap();
        assert_eq!(deleted["removed"], true);
        let after: Value = ureq::get(&url).call().unwrap().into_json().unwrap();
        assert!(after.as_array().unwrap().is_empty());
    }

    // ---------- diff scope ----------

    #[test]
    fn the_scope_param_selects_the_range_and_an_unknown_value_does_not() {
        // What this pins is the wiring, not the range semantics (git.rs covers
        // those): a typo in the param name, or a value the server doesn't
        // recognize, must not quietly serve the uncommitted diff under a label
        // that says otherwise. Silent fall-through is the failure mode.
        let root = std::env::temp_dir().join(format!("krit-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        git(&["branch", "-M", "trunk"]);

        git(&["checkout", "-q", "-b", "topic"]);
        std::fs::write(root.join("committed.txt"), "on the branch\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "branch work"]);
        std::fs::write(root.join("base.txt"), "base edited\n").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let port = spawn_server_full(&rt, None, true, root.clone(), Some("trunk".into()));
        let patch_for = |query: &str| -> String {
            let res: Value = ureq::get(&format!("http://127.0.0.1:{port}/api/diff?{query}"))
                .call()
                .expect("the diff lands")
                .into_json()
                .unwrap();
            res["patch"].as_str().unwrap_or_default().to_string()
        };

        let branch = patch_for("staged=false&untracked=false&scope=branch");
        assert!(
            branch.contains("committed.txt") && branch.contains("base.txt"),
            "the branch scope covers the branch's commit and the working tree: {branch}"
        );

        for query in [
            "staged=false&untracked=false",
            "staged=false&untracked=false&scope=uncommitted",
            "staged=false&untracked=false&scope=nonsense",
        ] {
            let patch = patch_for(query);
            assert!(
                !patch.contains("committed.txt"),
                "`{query}` must not silently widen to the branch range: {patch}"
            );
            assert!(patch.contains("base.txt"), "`{query}` still shows the edit");
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- delete/undo content-tag handshake ----------

    /// A scratch repo root holding one file, plus a server serving it.
    fn spawn_edit_server(rt: &tokio::runtime::Runtime, name: &str) -> (PathBuf, u16) {
        let root = std::env::temp_dir().join(format!("krit-edits-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let port = spawn_server_rooted(rt, None, true, root.clone());
        (root, port)
    }

    fn post_delete_line_two(port: u16) -> String {
        let res: Value = ureq::post(&format!("http://127.0.0.1:{port}/api/edits/delete"))
            .send_json(json!({
                "filePath": "a.txt",
                "startLine": 2, "startColumn": 0,
                "endLine": 2, "endColumn": 3,
            }))
            .expect("the delete lands")
            .into_json()
            .unwrap();
        res["undoId"].as_str().unwrap().to_string()
    }

    #[test]
    fn undo_restores_the_deleted_text_when_the_file_is_untouched() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (root, port) = spawn_edit_server(&rt, "clean");
        let undo_id = post_delete_line_two(port);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n\nthree\n"
        );

        let res = ureq::post(&format!("http://127.0.0.1:{port}/api/edits/undo"))
            .send_json(json!({"id": undo_id}))
            .expect("an unmodified file undoes cleanly");
        assert_eq!(res.status(), 200);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\ntwo\nthree\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn undo_refuses_a_file_that_changed_since_the_delete() {
        // The tag stored by `api_edits_delete` is what `api_edits_undo`
        // compares — re-reading the file at undo time would make the check a
        // tautology, and the deleted text would be re-inserted at a position
        // someone else's edit has already moved.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (root, port) = spawn_edit_server(&rt, "conflict");
        let undo_id = post_delete_line_two(port);

        let meddled = "PREPENDED\none\n\nthree\n";
        std::fs::write(root.join("a.txt"), meddled).unwrap();

        let err = ureq::post(&format!("http://127.0.0.1:{port}/api/edits/undo"))
            .send_json(json!({"id": undo_id}))
            .unwrap_err();
        assert!(matches!(&err, ureq::Error::Status(409, _)), "{err}");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            meddled,
            "a refused undo writes nothing"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- pathspec-safe file params ----------

    #[test]
    fn rejects_pathspec_magic_and_traversal() {
        assert!(is_plain_repo_path("src/main.rs"));
        assert!(!is_plain_repo_path(""));
        assert!(!is_plain_repo_path(":(exclude)src/*"));
        assert!(!is_plain_repo_path(":/"));
        assert!(!is_plain_repo_path("../etc/passwd"));
    }

    // ---------- branch-name TTL cache ----------

    #[test]
    fn cached_branch_name_returns_the_cached_value_within_ttl() {
        let state = test_state();
        // Seed a synthetic value that could never be `git`'s real answer —
        // if `cached_branch_name` forked `git` instead of reading the cache,
        // this assertion would fail.
        *lock(&state.branch_cache) = Some(("sentinel-branch".to_string(), Instant::now()));
        assert_eq!(cached_branch_name(&state), "sentinel-branch");
    }

    #[test]
    fn cached_branch_name_refreshes_once_the_ttl_has_elapsed() {
        let state = test_state();
        let stale_at = Instant::now() - BRANCH_CACHE_TTL - Duration::from_millis(50);
        *lock(&state.branch_cache) = Some(("sentinel-branch".to_string(), stale_at));
        let refreshed = cached_branch_name(&state);
        // A stale entry is not returned as-is; it's replaced by exactly what a
        // fresh `git::branch_name()` returns. Asserting the value, not just
        // "not the sentinel": the refreshed name keys the review identity in
        // the comment store, so an empty or wrong answer would be silent.
        assert_eq!(refreshed, git::branch_name());
        assert!(!refreshed.is_empty(), "the test runs inside a git repo");
        // And the cache itself now holds the fresh value + a recent timestamp.
        let (cached, fetched_at) = lock(&state.branch_cache).clone().unwrap();
        assert_eq!(cached, refreshed);
        assert!(fetched_at.elapsed() < BRANCH_CACHE_TTL);
    }
}
