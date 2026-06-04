---
"diffx-cli": minor
---

Desktop app launcher — diffx can now open each review in its own window of a
dedicated **diffx** macOS app instead of a tab in your default browser. Set
`"launcher": "app"` in `~/.config/diffx/settings.json` and the CLI fires a
`diffx://review?url=…` deep link; the app (under `desktop/`, a thin Tauri shell)
turns each link into a window keyed by the review's server port, so multiple
reviews in flight become multiple windows under one dock icon. With the app not
installed, or the setting left at its `browser` default, behavior is unchanged —
and a failed deep link degrades to the usual "visit this URL" hint.

Build the app from `desktop/` (see `desktop/README.md`); the launcher setting is
the only change to the published `diffx-cli` package itself.
