# krit development entry points. `just` alone lists targets.

default:
    @just --list

# Build and install both binaries and the desktop app (build.rs embeds a fresh
# UI automatically)
install: install-app
    cargo install --path krit
    cargo install --path krit-tui
    # Belt-and-suspenders re-sign: `cargo install` signs correctly, but any
    # binary later cp'd into place (e.g. an artifact copied to dodge cargo's
    # lock) loses its signature and macOS SIGKILLs it on launch (exit 137) on
    # Apple Silicon. A forced ad-hoc sign is idempotent and cheap. No-op off macOS.
    [ "$(uname)" = Darwin ] && codesign --force -s - "${CARGO_HOME:-$HOME/.cargo}/bin/krit" || true
    [ "$(uname)" = Darwin ] && codesign --force -s - "${CARGO_HOME:-$HOME/.cargo}/bin/krit-tui" || true

# Rust tests + TypeScript typecheck + UI unit tests (Vitest)
test:
    cargo test --workspace
    pnpm exec tsc --noEmit
    pnpm exec vitest run

# Formatting, lints, and typecheck — what should be green before landing
check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    # The desktop app is its own workspace (see desktop/src-tauri/Cargo.toml), so
    # nothing above reaches it — and it is the other half of the Done-reviewing
    # contract: window labels, capability names, and the global the UI probes
    # for. Without this it is compiled only by a manual `cargo tauri build`.
    cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
    cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
    pnpm exec tsc --noEmit

# Build the web UI bundle (what release binaries embed)
ui:
    pnpm exec vite build

# Vite dev server for UI work — pair with a debug-build krit server,
# which serves dist/client from disk (rebuild with `just ui` to refresh)
dev:
    pnpm exec vite

# The terminal client, against whatever krit server this worktree has running
tui:
    cargo run -p krit-tui

# Preview the changelog section the pending fragments would produce
changelog:
    ./scripts/changelog.py collate

# Cut a release: collate fragments into CHANGELOG.md, delete them, bump all
# three version files. Run this before every `wt-fold` — see CLAUDE.md.
# `bump` is `patch` (default), `minor`, or an explicit X.Y.Z.
release bump="patch":
    ./scripts/changelog.py release {{bump}}

# Build and install krit.app to /Applications (macOS only; no-op elsewhere).
#
# The app is a separate cargo workspace and ships separately from the UI it
# frames, so it drifts silently: an installed bundle whose capabilities predate
# a UI feature denies the call from an API that exists and looks callable. That
# is how Done reviewing came to leave a dead window behind for six weeks. It is
# part of `install` for that reason — the two halves are one contract.
install-app:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$(uname)" != Darwin ]; then
        echo "install-app: not macOS, skipping"
        exit 0
    fi
    if ! cargo tauri --version >/dev/null 2>&1; then
        echo "install-app: needs the tauri CLI — cargo install tauri-cli --version '^2'" >&2
        exit 1
    fi
    cd desktop
    cargo tauri build
    # Ask cargo where the bundle went rather than assuming: the app is its own
    # workspace, so its default target dir is not the one the rest of the repo
    # builds into, and CARGO_TARGET_DIR may redirect both.
    target="$(cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
    # A running app keeps the old code whatever is on disk, and cp'ing over a
    # live bundle is how you get a half-replaced one.
    osascript -e 'quit app "krit"' >/dev/null 2>&1 || true
    rm -rf /Applications/krit.app
    cp -R "$target/release/bundle/macos/krit.app" /Applications/krit.app
    echo "installed /Applications/krit.app $(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' /Applications/krit.app/Contents/Info.plist)"
