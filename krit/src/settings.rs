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
        // Ladder for the branch scope's base, first match wins — see
        // git::resolve_base_ref. One list covers repos with different trunks,
        // which is why it isn't a single name.
        "baseBranches": ["main", "master"],
    }) else {
        unreachable!()
    };
    map
}

/// Bumped when the saved key set changes incompatibly. Files written before
/// it existed carry no marker and read as version 0.
const SCHEMA_VERSION: u32 = 1;

const SCHEMA_VERSION_KEY: &str = "schemaVersion";

/// Keys the server owns inside the settings object. They travel in the same
/// JSON as the settings — `schemaVersion` on the way out to disk,
/// `settingsError` on the way out to the UI — so a client that PUTs back a
/// whole settings object it was handed must not thereby write them into the
/// user's file.
const SERVER_OWNED_KEYS: [&str; 2] = [SCHEMA_VERSION_KEY, "settingsError"];

/// Settings as read, plus the reason they are not the user's if they aren't.
///
/// The distinction that matters is **absent** versus **unreadable**. No file is
/// the normal state and means "defaults"; a file that won't parse means the
/// user has settings and we are ignoring all of them. Collapsing the two — a
/// bare `.ok()` — spends a reviewer's session on defaults they never chose,
/// with nothing anywhere saying so. That is the same silent-asymmetry failure
/// the atomic write below already exists to prevent, arrived at from the read
/// side: `save_settings_at` renames a complete file into place precisely so no
/// reader sees a torn one, and then the reader swallowed torn files anyway.
pub struct Loaded {
    pub effective: Value,
    /// `None` when the file is absent or valid. Prose, aimed at whoever has to
    /// go fix the file.
    pub error: Option<String>,
}

/// What the file actually holds — only the keys a user has explicitly set.
/// Defaults are never written into it, so a later change to `defaults()`
/// still reaches everyone who hasn't overridden that key.
///
/// `Err` carries a description of why an existing file could not be used.
/// Unknown keys and unexpected value types are **not** errors: the settings
/// surface belongs to the UI (see the module header), so anything that parses
/// as a JSON object is passed through whether this build knows the keys or not.
fn saved_settings_at(path: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // Absent is the overwhelmingly common case and is not a problem;
        // anything else (a directory, no permission, an I/O error) is one.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("{} could not be read: {e}", path.display())),
    };
    let mut saved = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(saved)) => saved,
        Ok(other) => {
            let kind = match other {
                Value::Null => "null",
                Value::Bool(_) => "a boolean",
                Value::Number(_) => "a number",
                Value::String(_) => "a string",
                Value::Array(_) => "an array",
                Value::Object(_) => unreachable!("matched above"),
            };
            return Err(format!(
                "{} holds {kind}, not a JSON object of settings",
                path.display()
            ));
        }
        Err(e) => return Err(format!("{} is not valid JSON: {e}", path.display())),
    };
    for key in SERVER_OWNED_KEYS {
        saved.remove(key);
    }
    Ok(saved)
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
        if SERVER_OWNED_KEYS.contains(&k.as_str()) {
            continue;
        }
        if v.is_null() {
            saved.remove(k);
        } else {
            saved.insert(k.clone(), v.clone());
        }
    }
}

pub fn load_settings() -> Loaded {
    load_settings_at(&settings_file())
}

fn load_settings_at(path: &Path) -> Loaded {
    match saved_settings_at(path) {
        Ok(saved) => Loaded {
            effective: over_defaults(saved),
            error: None,
        },
        // Still serve defaults — a broken settings file must not take the
        // review down with it — but say so, so the UI can surface it.
        Err(error) => Loaded {
            effective: over_defaults(Map::new()),
            error: Some(error),
        },
    }
}

/// Applies `partial` to the saved file and returns the full effective
/// settings.
pub fn save_settings(partial: &Value) -> Loaded {
    save_settings_at(&settings_file(), partial)
}

/// The `$HOME` lookup lives only in the wrappers above: the read/merge/write
/// behavior is the part worth pinning, and it can't be exercised through a
/// process-global environment variable without racing every other test.
fn save_settings_at(path: &Path, partial: &Value) -> Loaded {
    // Refuse rather than overwrite. A save is a read-modify-write, and on an
    // unreadable file the "read" half yields nothing — so writing would drop
    // every setting the user has, replacing the file with just this partial.
    // Toggling one checkbox is not consent to discard the rest.
    let mut saved = match saved_settings_at(path) {
        Ok(saved) => saved,
        Err(error) => {
            return Loaded {
                effective: over_defaults(Map::new()),
                error: Some(format!("{error} — not overwriting it")),
            };
        }
    };
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

    Loaded {
        effective: over_defaults(saved),
        error: None,
    }
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

        let effective = save_settings_at(&path, &json!({"diffStyle": "unified"})).effective;
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk[SCHEMA_VERSION_KEY], json!(SCHEMA_VERSION));
        assert_eq!(on_disk["diffStyle"], "unified");

        // The marker is file metadata, not a setting: it must not reach the UI
        // in the effective settings, nor round-trip back into the saved map.
        assert!(effective.get(SCHEMA_VERSION_KEY).is_none());
        assert!(
            load_settings_at(&path)
                .effective
                .get(SCHEMA_VERSION_KEY)
                .is_none(),
            "a reloaded file must strip the marker it wrote"
        );
        assert!(
            !saved_settings_at(&path)
                .unwrap()
                .contains_key(SCHEMA_VERSION_KEY)
        );

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
        let effective = load_settings_at(&path).effective;
        assert_eq!(effective["diffStyle"], "unified");
        assert_eq!(effective["defaultTabSize"], 2);
        assert_eq!(effective["staged"], true, "untouched keys still default");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_absent_file_is_not_an_error_but_an_unparseable_one_is() {
        let dir = settings_dir("absent-vs-broken");
        let path = dir.join("settings.json");

        // Absent: the normal state for anyone who has never changed a setting.
        let loaded = load_settings_at(&path);
        assert!(loaded.error.is_none(), "no file is not a problem");
        assert_eq!(loaded.effective["diffStyle"], "split");

        // Present and broken: still serves defaults, but says so. Reporting it
        // is the whole point — the reviewer is running on settings they did not
        // choose, and the old `.ok()` made that indistinguishable from above.
        std::fs::write(&path, "{\"diffStyle\": \"unified\",").unwrap();
        let loaded = load_settings_at(&path);
        assert_eq!(
            loaded.effective["diffStyle"], "split",
            "defaults still work"
        );
        let error = loaded.error.expect("a broken file must be reported");
        assert!(
            error.contains("not valid JSON") && error.contains("settings.json"),
            "the error must name the file and the problem: {error}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn valid_json_that_is_not_an_object_is_reported_as_such() {
        let dir = settings_dir("not-an-object");
        let path = dir.join("settings.json");
        // Parses fine, so a parse check alone would accept it and then silently
        // find no keys on it.
        std::fs::write(&path, "[1, 2, 3]").unwrap();

        let error = load_settings_at(&path).error.expect("must be reported");
        assert!(
            error.contains("an array"),
            "the error should name what was found instead: {error}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_refuses_to_overwrite_a_file_it_could_not_read() {
        // A save is a read-modify-write. On an unreadable file the read yields
        // nothing, so writing anyway would replace every setting the user has
        // with just this one partial — data loss triggered by toggling a
        // checkbox. The file must survive untouched for them to go fix.
        let dir = settings_dir("no-clobber");
        let path = dir.join("settings.json");
        let broken = "{\"diffStyle\": \"unified\", \"defaultTabSize\":";
        std::fs::write(&path, broken).unwrap();

        let loaded = save_settings_at(&path, &json!({"staged": false}));
        assert!(loaded.error.is_some(), "the refusal must be reported");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            broken,
            "the unreadable file must be left exactly as it was"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_client_cannot_persist_the_servers_own_keys() {
        // GET /api/settings hands the UI `settingsError` inside the settings
        // object. A client that PUTs back what it was given must not thereby
        // write the server's metadata into the user's file — the same guarantee
        // schemaVersion already had, now that there are two such keys.
        let mut saved = Map::new();
        apply_partial(
            &mut saved,
            &json!({
                "diffStyle": "unified",
                "schemaVersion": 99,
                "settingsError": "some stale message",
            }),
        );
        assert_eq!(saved.len(), 1, "only the real setting is saved: {saved:?}");
        assert_eq!(saved["diffStyle"], "unified");
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
