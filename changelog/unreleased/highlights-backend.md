### Changed

- Syntax highlighting now uses Pierre's Highlights backend on the main thread
  for files up to 100k characters, so code arrives already colored instead of
  as plain text first. A language it has no lexer for renders plain.
- Updated `@pierre/diffs` to 1.6.2, plus patch updates to `@types/node` and
  `lucide-react`.
