//! UI settings at ~/.config/krit/settings.json — krit's own namespace,
//! deliberately not shared with ~/.config/diffx (disjoint side-by-side
//! installs). Same keys and defaults as v1. Values are handled as loose JSON
//! merged over defaults: the settings surface belongs to the UI, and the
//! server shouldn't need a release to pass through a new key. The file holds
//! only what a user set; defaults stay a read-time overlay so changing one
//! reaches everybody who hasn't overridden it.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

fn settings_file() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".config")
        .join("krit")
        .join("settings.json")
}

fn defaults() -> Map<String, Value> {
    let Value::Object(map) = json!({
        "staged": true,
        "untracked": true,
        "diffStyle": "split",
        "defaultTabSize": 4,
        "refreshMode": "live-unless-active",
    }) else {
        unreachable!()
    };
    map
}

/// Bumped when the saved key set changes incompatibly. Files written before
/// it existed carry no marker and read as version 0.
const SCHEMA_VERSION: u32 = 1;

const SCHEMA_VERSION_KEY: &str = "schemaVersion";

/// What the file actually holds — only the keys a user has explicitly set.
/// Defaults are never written into it, so a later change to `defaults()`
/// still reaches everyone who hasn't overridden that key.
fn saved_settings_at(path: &Path) -> Map<String, Value> {
    let mut saved = match std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
    {
        Some(Value::Object(saved)) => saved,
        _ => Map::new(),
    };
    saved.remove(SCHEMA_VERSION_KEY);
    saved
}

/// Defaults are a read-time overlay only — see `saved_settings`.
fn over_defaults(saved: Map<String, Value>) -> Value {
    let mut merged = defaults();
    for (k, v) in saved {
        merged.insert(k, v);
    }
    Value::Object(merged)
}

/// An explicit null deletes the key, which is the only way a retired or
/// renamed key ever leaves a user's file.
fn apply_partial(saved: &mut Map<String, Value>, partial: &Value) {
    let Value::Object(partial) = partial else {
        return;
    };
    for (k, v) in partial {
        if k == SCHEMA_VERSION_KEY {
            continue;
        }
        if v.is_null() {
            saved.remove(k);
        } else {
            saved.insert(k.clone(), v.clone());
        }
    }
}

pub fn load_settings() -> Value {
    load_settings_at(&settings_file())
}

fn load_settings_at(path: &Path) -> Value {
    over_defaults(saved_settings_at(path))
}

/// Applies `partial` to the saved file and returns the full effective
/// settings.
pub fn save_settings(partial: &Value) -> Value {
    save_settings_at(&settings_file(), partial)
}

/// The `$HOME` lookup lives only in the wrappers above: the read/merge/write
/// behavior is the part worth pinning, and it can't be exercised through a
/// process-global environment variable without racing every other test.
fn save_settings_at(path: &Path, partial: &Value) -> Value {
    let mut saved = saved_settings_at(path);
    apply_partial(&mut saved, partial);

    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut to_write = saved.clone();
    to_write.insert(SCHEMA_VERSION_KEY.into(), Value::from(SCHEMA_VERSION));
    // Rename rather than write in place: this file is shared by every krit
    // process on the machine, and a truncated one reads as "no settings at
    // all" — silently reverting the user to defaults.
    if let Ok(s) = serde_json::to_string_pretty(&Value::Object(to_write)) {
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, s).is_ok() && std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    over_defaults(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    #[test]
    fn only_explicitly_set_keys_are_saved() {
        let mut saved = Map::new();
        apply_partial(&mut saved, &json!({"diffStyle": "unified"}));
        assert_eq!(saved.len(), 1);

        // The effective settings still carry the defaults...
        let effective = over_defaults(saved.clone());
        assert_eq!(effective["diffStyle"], "unified");
        assert_eq!(effective["staged"], true);
        // ...but nothing froze them into the file, so a later change to
        // defaults() still reaches this user.
        assert!(!saved.contains_key("staged"));
    }

    #[test]
    fn null_deletes_a_key_and_the_default_returns() {
        let mut saved = map(json!({"diffStyle": "unified", "retired": 1}));
        apply_partial(&mut saved, &json!({"retired": null, "diffStyle": null}));
        assert!(saved.is_empty());
        assert_eq!(over_defaults(saved)["diffStyle"], "split");
    }

    #[test]
    fn unknown_keys_pass_through_but_the_version_marker_does_not() {
        let mut saved = Map::new();
        apply_partial(
            &mut saved,
            &json!({"futureKey": {"nested": true}, "schemaVersion": 99}),
        );
        assert_eq!(saved["futureKey"], json!({"nested": true}));
        assert!(!saved.contains_key(SCHEMA_VERSION_KEY));
    }

    fn settings_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("krit-settings-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_version_marker_is_written_but_never_read_back_as_a_setting() {
        let dir = settings_dir("version-marker");
        let path = dir.join("settings.json");

        let effective = save_settings_at(&path, &json!({"diffStyle": "unified"}));
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk[SCHEMA_VERSION_KEY], json!(SCHEMA_VERSION));
        assert_eq!(on_disk["diffStyle"], "unified");

        // The marker is file metadata, not a setting: it must not reach the UI
        // in the effective settings, nor round-trip back into the saved map.
        assert!(effective.get(SCHEMA_VERSION_KEY).is_none());
        assert!(
            load_settings_at(&path).get(SCHEMA_VERSION_KEY).is_none(),
            "a reloaded file must strip the marker it wrote"
        );
        assert!(!saved_settings_at(&path).contains_key(SCHEMA_VERSION_KEY));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_leaves_no_temp_file_beside_the_settings() {
        // The file is shared by every krit process on the machine, so it is
        // written to a per-process temp name and renamed into place. A leftover
        // tmp means the rename never happened.
        let dir = settings_dir("atomic-save");
        let path = dir.join("settings.json");
        save_settings_at(&path, &json!({"diffStyle": "unified"}));
        save_settings_at(&path, &json!({"defaultTabSize": 2}));

        let strays: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != "settings.json")
            .collect();
        assert!(
            strays.is_empty(),
            "unexpected files beside the store: {strays:?}"
        );

        // Successive saves accumulate rather than replacing the file.
        let effective = load_settings_at(&path);
        assert_eq!(effective["diffStyle"], "unified");
        assert_eq!(effective["defaultTabSize"], 2);
        assert_eq!(effective["staged"], true, "untouched keys still default");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_concurrent_reader_never_sees_a_half_written_file() {
        // Every krit process on the machine shares this file, and a truncated
        // one reads as "no settings at all" — silently reverting the user to
        // defaults. Writing in place exposes exactly that window; renaming a
        // complete temp file into place has none.
        let dir = settings_dir("no-torn-read");
        let path = dir.join("settings.json");
        save_settings_at(&path, &json!({"diffStyle": "unified"}));

        let reader_path = path.clone();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader_stop = stop.clone();
        let reader = std::thread::spawn(move || {
            let mut torn = 0usize;
            while !reader_stop.load(std::sync::atomic::Ordering::Relaxed) {
                if let Ok(text) = std::fs::read_to_string(&reader_path)
                    && serde_json::from_str::<Value>(&text).is_err()
                {
                    torn += 1;
                }
            }
            torn
        });

        for i in 0..2000 {
            save_settings_at(&path, &json!({"defaultTabSize": i}));
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let torn = reader.join().unwrap();
        assert_eq!(torn, 0, "a reader observed the file mid-write {torn} times");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
