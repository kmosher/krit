# krit development entry points. `just` alone lists targets.

default:
    @just --list

# Build and install krit (build.rs embeds a fresh UI automatically)
install:
    cargo install --path krit

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
