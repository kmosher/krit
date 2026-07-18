//! UI settings at ~/.config/krit/settings.json — krit's own namespace,
//! deliberately not shared with ~/.config/diffx (disjoint side-by-side
//! installs). Same keys and defaults as v1. Values are handled as loose JSON
//! merged over defaults: the settings surface belongs to the UI, and the
//! server shouldn't need a release to pass through a new key.

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

pub fn load_settings() -> Value {
    let mut merged = defaults();
    if let Ok(content) = std::fs::read_to_string(settings_file())
        && let Ok(Value::Object(saved)) = serde_json::from_str::<Value>(&content)
    {
        for (k, v) in saved {
            merged.insert(k, v);
        }
    }
    Value::Object(merged)
}

pub fn save_settings(partial: &Value) -> Value {
    let mut merged = match load_settings() {
        Value::Object(m) => m,
        _ => defaults(),
    };
    if let Value::Object(partial) = partial {
        for (k, v) in partial {
            merged.insert(k.clone(), v.clone());
        }
    }
    let path = settings_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let result = Value::Object(merged);
    if let Ok(s) = serde_json::to_string_pretty(&result) {
        let _ = std::fs::write(&path, s);
    }
    result
}
