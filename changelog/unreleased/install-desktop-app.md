### Added

- `just install` now builds and installs `krit.app` to `/Applications`
  (`just install-app` on its own; a no-op off macOS). The app is a separate
  cargo workspace and previously only a manual `cargo tauri build` ever touched
  it, so an installed bundle could sit many versions behind the UI it frames —
  which is how Done reviewing came to leave the window open, its capabilities
  predating `core:window:allow-close`.
