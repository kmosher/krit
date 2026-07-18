//! Always-on fs-watcher: catches changes made outside the in-browser editor
//! (an agent's Edit tool, `git checkout`, a build) without relying on anyone
//! remembering to call `krit refresh`. FSEvents-native on macOS via `notify`
//! — one recursive watcher for the whole repo, no per-directory bookkeeping.
//!
//! Two layers keep it quiet (same design as v1): the debouncer collapses
//! write bursts, and a per-path content hash swallows events that didn't
//! change bytes (mtime churn from checkout/rebase/touch).

use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, new_debouncer};
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEBOUNCE_MS: u64 = 200;

/// Directory names ignored anywhere in the path. v1's set plus `target`
/// (cargo build churn — krit reviewing its own repo would otherwise spray
/// events on every build).
fn is_ignored(rel: &Path) -> bool {
    rel.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some(".git") | Some("node_modules") | Some(".claude") | Some("target")
        )
    })
}

pub struct RepoWatcher {
    // Held for its lifetime; dropping stops the watch.
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
}

fn content_hash(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    Some(h.finish())
}

/// Watches `root` and calls `on_change(relative_path)` for each file whose
/// content actually changed (or that disappeared). Returns None (with a
/// warning) if the watcher can't start — losing live refresh is degraded,
/// not fatal; the rest of the server keeps working.
pub fn watch_repo(
    root: PathBuf,
    on_change: impl Fn(String) + Send + 'static,
) -> Option<RepoWatcher> {
    let mut hashes: HashMap<String, u64> = HashMap::new();
    let handler_root = root.clone();

    let mut debouncer = match new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(_) => return, // transient backend error; keep watching
            };
            // Dedupe paths within the batch — one decision per file per tick.
            let mut seen: Vec<PathBuf> = Vec::new();
            for event in events {
                for path in &event.paths {
                    if seen.contains(path) {
                        continue;
                    }
                    seen.push(path.clone());
                    let Ok(rel) = path.strip_prefix(&handler_root) else {
                        continue;
                    };
                    if is_ignored(rel) || path.is_dir() {
                        continue;
                    }
                    let rel_str = rel.to_string_lossy().into_owned();
                    match content_hash(path) {
                        None => {
                            // Deleted/unreadable: only an event if we'd seen it.
                            if hashes.remove(&rel_str).is_some() {
                                on_change(rel_str);
                            }
                        }
                        Some(h) => {
                            if hashes.get(&rel_str) == Some(&h) {
                                continue; // mtime-only churn
                            }
                            hashes.insert(rel_str.clone(), h);
                            on_change(rel_str);
                        }
                    }
                }
            }
        },
    ) {
        Ok(d) => d,
        Err(err) => {
            eprintln!(
                "krit: fs-watcher failed to start, live refresh disabled for this session: {err}"
            );
            return None;
        }
    };

    if let Err(err) = debouncer.watch(&root, RecursiveMode::Recursive) {
        eprintln!("krit: fs-watcher error, live refresh disabled for this session: {err}");
        return None;
    }

    Some(RepoWatcher {
        _debouncer: debouncer,
    })
}
