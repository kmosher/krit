# krit development entry points. `just` alone lists targets.

default:
    @just --list

# Build and install krit (build.rs embeds a fresh UI automatically)
install:
    cargo install --path krit
    # Belt-and-suspenders re-sign: `cargo install` signs correctly, but any
    # binary later cp'd into place (e.g. an artifact copied to dodge cargo's
    # lock) loses its signature and macOS SIGKILLs it on launch (exit 137) on
    # Apple Silicon. A forced ad-hoc sign is idempotent and cheap. No-op off macOS.
    [ "$(uname)" = Darwin ] && codesign --force -s - "${CARGO_HOME:-$HOME/.cargo}/bin/krit" || true

# Rust tests + TypeScript typecheck
test:
    cd krit && cargo test
    pnpm exec tsc --noEmit

# Formatting, lints, and typecheck — what should be green before landing
check:
    cd krit && cargo fmt --check && cargo clippy --all-targets -- -D warnings
    pnpm exec tsc --noEmit

# Build the web UI bundle (what release binaries embed)
ui:
    pnpm exec vite build

# Vite dev server for UI work — pair with a debug-build krit server,
# which serves dist/client from disk (rebuild with `just ui` to refresh)
dev:
    pnpm exec vite
