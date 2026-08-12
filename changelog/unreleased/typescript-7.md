### Changed

- TypeScript 6 → 7 and `@types/node` 25 → 26. No source changes: the whole UI
  typechecks clean under the new compiler.
- The test toolchain (`vitest`, `happy-dom`, `@testing-library/*`) is now on
  carets rather than exact pins, so it picks up patches with the routine
  dependency refresh.
