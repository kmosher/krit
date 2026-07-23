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
use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEBOUNCE_MS: u64 = 200;

/// Files at or above this size skip the full byte read in `content_hash`.
/// Reading a multi-hundred-MB build artifact (a checkout or `cargo build`
/// drops one under the root faster than filtering can catch it) pulls the
/// whole thing into RAM just to hash it — the observed ~2 GB RSS spikes.
/// 8 MiB is well above any hand-authored source file we'd diff, so the full
/// read still covers everything a human is actually reviewing.
const HASH_SIZE_CAP: u64 = 8 * 1024 * 1024;

/// Fast-path filter, checked before the git-aware one: cheap enough to run on
/// every post-debounce path so the highest-churn directories never spawn a
/// `git check-ignore` subprocess (a `pnpm install` / `cargo build` under the
/// root is tens of thousands of paths — one fork each is the storm we're
/// avoiding). Two tiers:
///   - names that are never tracked content and flood hardest: `.git` (which
///     check-ignore wouldn't catch anyway — it isn't gitignored), plus
///     `node_modules` and `.claude` (installs, and sibling worktrees live at
///     `.claude/worktrees/*`);
///   - build outputs `target`/`dist`, but *only* when a sibling manifest marks
///     the directory as a build root. The manifest gate preserves v1's
///     invariant that these are legitimate tracked-dir names elsewhere (a
///     committed docs `target/`, a checked-in web `dist/`): we skip them solely
///     where Cargo/npm are generating them — exactly where check-ignore would
///     also say "ignored", minus the per-path fork. A stat is orders of
///     magnitude cheaper than spawning git.
fn is_ignored(root: &Path, rel: &Path) -> bool {
    // Walk components with the absolute parent alongside, so the manifest probe
    // looks beside the build dir rather than at the repo root.
    let mut parent = root.to_path_buf();
    for c in rel.components() {
        let name = c.as_os_str();
        match name.to_str() {
            Some(".git") | Some("node_modules") | Some(".claude") => return true,
            Some("target") if parent.join("Cargo.toml").exists() => return true,
            Some("dist") if parent.join("package.json").exists() => return true,
            _ => {}
        }
        parent.push(name);
    }
    false
}

/// The repo's own opinion: anything .gitignore (or global excludes) would
/// ignore, the watcher ignores too — build artifacts like dist/ stop
/// generating events without krit hardcoding every ecosystem's output dir.
/// One subprocess per post-debounce changed path is noise-level cost.
fn is_git_ignored(root: &Path, rel: &Path) -> bool {
    std::process::Command::new("git")
        .args(["check-ignore", "-q", "--"])
        .arg(rel)
        .current_dir(root)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub struct RepoWatcher {
    // Held for its lifetime; dropping stops the watch.
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
}

fn content_hash(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let mut h = DefaultHasher::new();
    // Oversized files (build artifacts, checkout debris) hash a cheap signature
    // — length + mtime — instead of their bytes. This trades one property of
    // the byte hash: a genuinely byte-identical rewrite of a >8 MiB file whose
    // mtime moved will now emit a spurious change (mtime churn we'd otherwise
    // swallow). We accept that at this size — such files are almost always
    // ignored build output that never reaches `on_change` anyway — because the
    // property we must not lose, "never miss a real change", still holds, and
    // we never read gigabytes to learn it.
    if meta.len() >= HASH_SIZE_CAP {
        meta.len().hash(&mut h);
        if let Ok(mtime) = meta.modified() {
            mtime.hash(&mut h);
        }
        return Some(h.finish());
    }
    let bytes = std::fs::read(path).ok()?;
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
            // A HashSet, not a Vec+contains: a churn burst is easily 10k paths,
            // and O(n²) membership there is 100M comparisons per tick.
            let mut seen: HashSet<PathBuf> = HashSet::new();
            for event in events {
                for path in &event.paths {
                    if !seen.insert(path.clone()) {
                        continue; // already handled this path this tick
                    }
                    let Ok(rel) = path.strip_prefix(&handler_root) else {
                        continue;
                    };
                    if is_ignored(&handler_root, rel)
                        || path.is_dir()
                        || is_git_ignored(&handler_root, rel)
                    {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("krit-watcher-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cheap_filter_catches_always_ignored_names() {
        let root = Path::new("/repo");
        assert!(is_ignored(root, Path::new(".git/HEAD")));
        assert!(is_ignored(root, Path::new("node_modules/foo/index.js")));
        assert!(is_ignored(
            root,
            Path::new(".claude/worktrees/x/src/lib.rs")
        ));
        assert!(!is_ignored(root, Path::new("src/lib.rs")));
    }

    #[test]
    fn build_dirs_gated_on_a_sibling_manifest() {
        let root = scratch("build-gate");

        // A `target/` with no Cargo.toml beside it is a legitimate tracked dir
        // (e.g. a docs tree) — the cheap filter must leave it to check-ignore.
        assert!(!is_ignored(&root, Path::new("docs/target/plan.md")));
        // Drop the manifest beside it and the same path is now a Cargo build
        // root we skip without forking git.
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/Cargo.toml"), "[package]").unwrap();
        assert!(is_ignored(&root, Path::new("docs/target/plan.md")));

        // `dist/` is gated on package.json the same way.
        assert!(!is_ignored(&root, Path::new("web/dist/bundle.js")));
        std::fs::create_dir_all(root.join("web")).unwrap();
        std::fs::write(root.join("web/package.json"), "{}").unwrap();
        assert!(is_ignored(&root, Path::new("web/dist/bundle.js")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn small_files_hash_by_content() {
        let dir = scratch("small-hash");
        let a = dir.join("a");
        std::fs::write(&a, b"hello").unwrap();
        let h1 = content_hash(&a).unwrap();
        std::fs::write(&a, b"hello world").unwrap();
        let h2 = content_hash(&a).unwrap();
        assert_ne!(h1, h2, "a byte change must change the hash");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_files_use_the_size_signature_not_their_bytes() {
        let dir = scratch("big-hash");
        // Two files above the cap, identical length but different bytes. Under
        // the signature path they hash the same (len+mtime dominates); that
        // collision is the proof the cap short-circuits the full byte read.
        let big = (HASH_SIZE_CAP + 4096) as usize;
        let x = dir.join("x");
        let y = dir.join("y");
        std::fs::write(&x, vec![b'a'; big]).unwrap();
        std::fs::write(&y, vec![b'b'; big]).unwrap();
        // Pin both mtimes equal so only the byte difference could distinguish
        // them; above the cap the signature ignores bytes, so the hashes match.
        let t = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::options()
            .write(true)
            .open(&x)
            .unwrap()
            .set_modified(t)
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(&y)
            .unwrap()
            .set_modified(t)
            .unwrap();
        assert_eq!(
            content_hash(&x).unwrap(),
            content_hash(&y).unwrap(),
            "above the cap, differing bytes at equal len+mtime hash the same"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
