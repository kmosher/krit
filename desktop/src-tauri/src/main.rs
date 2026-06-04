// diffx desktop — a thin window manager. It owns no UI of its own; each review
// is a window pointed at that review's local diffx server. The diffx CLI hands
// reviews over via a `diffx://review?url=...&title=...` deep link, so a single
// app process collects every in-flight review as its own window under one dock
// icon.
//
// macOS delivers deep links to the running app as Apple events (caught by
// `on_open_url`); a cold start carries its launch URL in `get_current()`. We
// handle both and dedupe by window label, so a link processed through both
// paths just focuses the existing window instead of opening a duplicate.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

// Fallback label counter for the (unexpected) case of a server URL with no port.
static WINDOW_SEQ: AtomicU32 = AtomicU32::new(0);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open_review_window(&handle, &url);
                }
            });
            // A deep link the app was cold-started with may not also arrive via
            // `on_open_url`, so drain it here too. Label dedupe makes the overlap safe.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    open_review_window(app.handle(), &url);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building diffx desktop")
        .run(|_app, _event| {});
}

// Open (or focus) a window for one review. Expects `diffx://review?url=<server>`
// with an optional `title`. Anything that isn't a local http diffx server is
// ignored — this app only ever frames localhost.
fn open_review_window(app: &tauri::AppHandle, deep_link: &url::Url) {
    let mut target: Option<String> = None;
    let mut title = String::from("diffx review");
    for (key, value) in deep_link.query_pairs() {
        match key.as_ref() {
            "url" => target = Some(value.into_owned()),
            "title" => title = value.into_owned(),
            _ => {}
        }
    }

    let Some(target) = target else { return };
    let Ok(parsed) = target.parse::<url::Url>() else { return };
    if parsed.scheme() != "http" {
        return;
    }
    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") => {}
        _ => return,
    }

    // One window per server port: re-running diffx for a review that's still open
    // focuses its window rather than stacking duplicates.
    let label = match parsed.port() {
        Some(port) => format!("review-{port}"),
        None => format!("review-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed)),
    };
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return;
    }

    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1400.0, 900.0)
        .build();
}
