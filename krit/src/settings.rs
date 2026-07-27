//! UI settings at ~/.config/krit/settings.json — krit's own namespace,
//! deliberately not shared with ~/.config/diffx (disjoint side-by-side
//! installs). Same keys and defaults as v1. Values are handled as loose JSON
//! merged over defaults: the settings surface belongs to the UI, and the
//! server shouldn't need a release to pass through a new key. The file holds
//! only what a user set; defaults stay a read-time overlay so changing one
//! reaches everybody who hasn't overridden it.

use serde_json::{Map, Value, json};
use std::path::PathBuf;

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
fn saved_settings() -> Map<String, Value> {
    let mut saved = match std::fs::read_to_string(settings_file())
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
    over_defaults(saved_settings())
}

/// Applies `partial` to the saved file and returns the full effective
/// settings.
pub fn save_settings(partial: &Value) -> Value {
    let mut saved = saved_settings();
    apply_partial(&mut saved, partial);

    let path = settings_file();
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
        if std::fs::write(&tmp, s).is_ok() && std::fs::rename(&tmp, &path).is_err() {
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
}
