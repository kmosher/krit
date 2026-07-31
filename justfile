# krit development entry points. `just` alone lists targets.

default:
    @just --list

# Build and install both binaries (build.rs embeds a fresh UI automatically)
install:
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
# three version files. Leaves everything staged-but-uncommitted for review.
release version:
    ./scripts/changelog.py release {{version}}
