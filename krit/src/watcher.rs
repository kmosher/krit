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

/// Bytes sampled from each end of an oversized file to build its content
/// signature. Large enough to catch the header/footer churn a real edit almost
/// always touches (an append, a re-serialized preamble), small enough that the
/// read stays negligible however large the file is.
const HASH_SAMPLE_BYTES: usize = 8 * 1024;

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
    use std::io::{Read, Seek, SeekFrom};
    let meta = std::fs::metadata(path).ok()?;
    let mut h = DefaultHasher::new();
    // Oversized files (build artifacts, checkout debris) are never read whole —
    // pulling a multi-hundred-MB file into RAM just to hash it is the observed
    // ~2 GB RSS spike. The signature is instead length plus a bounded sample of
    // the head and tail bytes. Like the small-file path it stays content-based,
    // not mtime-based, so an mtime-only touch (checkout/rebase) is still
    // swallowed rather than emitting a spurious change. The one thing it cannot
    // see is a change that keeps the exact length AND leaves both sampled ends
    // byte-identical — an edit buried in the middle of a >8 MiB file. That is
    // vanishingly unlikely for anything a human reviews, and such files are
    // almost always ignored build output the filters above drop before we hash.
    if meta.len() >= HASH_SIZE_CAP {
        meta.len().hash(&mut h);
        if let Ok(mut f) = std::fs::File::open(path) {
            let mut head = [0u8; HASH_SAMPLE_BYTES];
            if f.read_exact(&mut head).is_ok() {
                head.hash(&mut h);
            }
            // `len >= HASH_SIZE_CAP` (8 MiB) far exceeds the 8 KiB sample, so
            // the tail seek lands past the head and reads a full sample.
            let mut tail = [0u8; HASH_SAMPLE_BYTES];
            if f.seek(SeekFrom::End(-(HASH_SAMPLE_BYTES as i64))).is_ok()
                && f.read_exact(&mut tail).is_ok()
            {
                tail.hash(&mut h);
            }
        }
        return Some(h.finish());
    }
    let bytes = std::fs::read(path).ok()?;
    bytes.hash(&mut h);
    Some(h.finish())
}

/// Watches `root` and calls `on_change(paths)` once per debounce tick with
/// every repo-relative path whose content actually changed (or that
/// disappeared) — never per-path (that per-file fanout is exactly the
/// amplification this batches away; see
/// docs/design/reactive-loop-perf.md). Skipped entirely for a tick that
/// resolves to no real changes (an all-ignored or all-mtime-churn burst).
/// Returns None (with a warning) if the watcher can't start — losing live
/// refresh is degraded, not fatal; the rest of the server keeps working.
pub fn watch_repo(
    root: PathBuf,
    on_change: impl Fn(Vec<String>) + Send + 'static,
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
            // The tick's actually-changed, filtered, deduped paths — collected
            // and handed to on_change once, not per path.
            let mut changed: Vec<String> = Vec::new();
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
                                changed.push(rel_str);
                            }
                        }
                        Some(h) => {
                            if hashes.get(&rel_str) == Some(&h) {
                                continue; // mtime-only churn
                            }
                            hashes.insert(rel_str.clone(), h);
                            changed.push(rel_str);
                        }
                    }
                }
            }
            if !changed.is_empty() {
                on_change(changed);
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
    use std::sync::{Arc, Mutex};

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
    fn oversized_files_hash_a_bounded_signature_not_the_whole_file() {
        let dir = scratch("big-hash-middle");
        // Two files above the cap, equal length, differing only deep in the
        // middle — far from either sampled end. They collide: that's the proof
        // the signature samples bounded head+tail bytes rather than reading the
        // whole file into RAM. (The unsampled-middle miss is the documented,
        // accepted edge — see content_hash.)
        let big = (HASH_SIZE_CAP as usize) + 4096;
        let mut a = vec![b'a'; big];
        let mut b = vec![b'a'; big];
        let mid = big / 2;
        a[mid] = b'X';
        b[mid] = b'Y';
        let pa = dir.join("a");
        let pb = dir.join("b");
        std::fs::write(&pa, &a).unwrap();
        std::fs::write(&pb, &b).unwrap();
        assert_eq!(
            content_hash(&pa).unwrap(),
            content_hash(&pb).unwrap(),
            "a middle-only change at equal length is below the signature's resolution"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_files_detect_edits_at_either_end() {
        let dir = scratch("big-hash-ends");
        // The common real change (an append, a rewritten preamble) lands in the
        // sampled head or tail and must still move the hash.
        let big = (HASH_SIZE_CAP as usize) + 4096;
        let base = vec![b'a'; big];
        let p = dir.join("f");
        std::fs::write(&p, &base).unwrap();
        let h0 = content_hash(&p).unwrap();

        let mut head_edit = base.clone();
        head_edit[0] = b'Z';
        std::fs::write(&p, &head_edit).unwrap();
        assert_ne!(
            h0,
            content_hash(&p).unwrap(),
            "an edit in the head sample must change the hash"
        );

        let mut tail_edit = base.clone();
        let last = big - 1;
        tail_edit[last] = b'Z';
        std::fs::write(&p, &tail_edit).unwrap();
        assert_ne!(
            h0,
            content_hash(&p).unwrap(),
            "an edit in the tail sample must change the hash"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_files_swallow_mtime_only_churn() {
        let dir = scratch("big-hash-mtime");
        // Consistency with the small-file path: an mtime bump over identical
        // bytes is not a change. (The old len+mtime signature emitted a
        // spurious event here; the content signature does not.)
        let big = (HASH_SIZE_CAP as usize) + 4096;
        let p = dir.join("f");
        std::fs::write(&p, vec![b'a'; big]).unwrap();
        let h0 = content_hash(&p).unwrap();
        let t = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(t)
            .unwrap();
        assert_eq!(
            h0,
            content_hash(&p).unwrap(),
            "mtime-only churn on an oversized file must not change the hash"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_burst_of_changes_yields_one_batched_callback_invocation() {
        // The whole point of A2: two files changed inside one debounce
        // window must arrive as ONE Vec, not two per-path callbacks.
        let dir = scratch("batch-callback");
        std::fs::write(dir.join("a.txt"), b"a1").unwrap();
        std::fs::write(dir.join("b.txt"), b"b1").unwrap();

        let batches: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let batches_cb = batches.clone();
        let watcher = watch_repo(dir.clone(), move |paths| {
            batches_cb.lock().unwrap().push(paths);
        })
        .expect("watcher starts");

        // Let the debouncer's startup file-ID scan settle before writing —
        // otherwise the initial scan itself can race the burst below. Generous
        // margin: this runs alongside whatever else is loading the box.
        std::thread::sleep(Duration::from_millis(1500));

        std::fs::write(dir.join("a.txt"), b"a2").unwrap();
        std::fs::write(dir.join("b.txt"), b"b2").unwrap();

        // Poll rather than one fixed sleep — robust to a loaded scheduler
        // pushing the debounce tick out further than DEBOUNCE_MS.
        for _ in 0..50 {
            if !batches.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        drop(watcher);

        let batches = batches.lock().unwrap();
        assert_eq!(
            batches.len(),
            1,
            "one burst of changes must produce exactly one callback invocation, not one per file: {batches:?}"
        );
        let mut got = batches[0].clone();
        got.sort();
        assert_eq!(got, vec!["a.txt".to_string(), "b.txt".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tick_with_no_real_changes_never_calls_back() {
        // mtime-only churn (a touch) must not invoke on_change at all — an
        // empty Vec is never a valid frame on the wire, so the watcher must
        // suppress the call entirely rather than pass one through.
        let dir = scratch("empty-tick-no-callback");
        let f = dir.join("f.txt");
        std::fs::write(&f, b"same").unwrap();

        let calls: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
        let calls_cb = calls.clone();
        let watcher = watch_repo(dir.clone(), move |_paths| {
            *calls_cb.lock().unwrap() += 1;
        })
        .expect("watcher starts");

        // The watcher only learns a path's baseline hash from events it
        // observes AFTER it starts — a file written before `watch_repo` was
        // called has no recorded baseline yet, so its first-ever observed
        // event is unconditionally "new". Establish that baseline for real
        // first (poll for it), THEN touch with unchanged bytes and confirm
        // that second, content-identical event adds no further call.
        std::fs::write(&f, b"baseline").unwrap();
        for _ in 0..50 {
            if *calls.lock().unwrap() >= 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let after_baseline = *calls.lock().unwrap();
        assert_eq!(
            after_baseline, 1,
            "the baseline-establishing write must itself call back once"
        );

        // Touch: same bytes as the baseline, new mtime — content_hash, now
        // primed with a real baseline, must swallow this one.
        let t = std::time::SystemTime::now() + Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&f)
            .unwrap()
            .set_modified(t)
            .unwrap();

        std::thread::sleep(Duration::from_millis(1500));
        drop(watcher);

        assert_eq!(
            *calls.lock().unwrap(),
            after_baseline,
            "mtime-only churn over an already-known baseline must not call back again"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
