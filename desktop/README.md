# diffx desktop

A thin [Tauri](https://v2.tauri.app/) shell that gives diffx its own macOS app:
each review opens as its own window under a single **diffx** dock icon, instead
of a tab in your default browser.

It owns no UI of its own. Every window is pointed at a running diffx server
(`http://127.0.0.1:<port>`); the diffx CLI hands reviews over with a deep link:

```
diffx://review?url=http://127.0.0.1:51234&title=my-repo · my-branch
```

The app claims the `diffx://` scheme on first launch. A link that arrives while
it's running opens a new window; a cold start opens the launch link's window.
Windows are keyed by server port, so re-running diffx for a review that's still
open just focuses it.

Multiple reviews in flight → multiple windows in one app process. Close the last
window and the app exits; the next review cold-starts it again (~1s).

## Wiring diffx to the app

Set the launcher in `~/.config/diffx/settings.json`:

```json
{ "launcher": "app" }
```

With that, `diffx` fires the deep link instead of opening a browser tab. Without
it (the default), nothing here is involved. If the app isn't installed, the CLI
notes it and falls back to printing the URL.

## Building

Requires the Rust toolchain and the Tauri CLI:

```sh
cargo install tauri-cli --version "^2"   # one time
cd desktop/src-tauri

# Dev (hot-reloads the Rust shell; opens nothing until it gets a deep link):
cargo tauri dev

# Release bundle → src-tauri/target/release/bundle/macos/diffx.app:
cargo tauri build
```

Then move `diffx.app` into `/Applications` (and launch it once so macOS
registers the `diffx://` scheme).

### Icons

The icon set under `src-tauri/icons/` is generated from a single source PNG:

```sh
cargo tauri icon path/to/source-1024.png
```

## Known limitations / follow-ups

- **macOS-first.** Deep links rely on Apple-event delivery to the running app.
  Linux/Windows would also want `tauri-plugin-single-instance` (with its
  `deep-link` feature) to forward links from a second launch via argv.
- **No window restore.** Closing a review window doesn't end the review; the
  diffx server keeps running until you click *Done reviewing* or Ctrl-C the CLI.
- **Code signing.** The local bundle is unsigned. Fine for personal use; a
  notarized build would need an Apple Developer cert.
