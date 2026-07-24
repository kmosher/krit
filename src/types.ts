// SSE `/api/events` frame: a debounced fs-watcher tick found one or more
// changed files and is delivering them as a single batch (replaces the old
// per-file `file-changed` fanout on the watcher path — see
// docs/design/reactive-loop-perf.md). Mirrors Rust's `Event::FilesChanged`
// (krit/src/types.rs), `#[serde(rename_all = "kebab-case")]`.
export interface FilesChangedEvent {
  type: 'files-changed'
  paths: string[]
}

export interface CommentReply {
  id: string
  body: string
  createdAt: number
  // 'user' = added from the browser UI by the human reviewer.
  // 'agent' = added by the bot via the comments API during /diffx-finish-review.
  // Optional for backward compatibility with replies persisted before the field existed;
  // consumers should treat a missing author as 'agent' (the original sole writer).
  author?: 'user' | 'agent'
}

export interface ReviewComment {
  id: string
  filePath: string
  side: 'deletions' | 'additions'
  // For multi-line ranges, lineNumber is the (inclusive) start and endLine the (inclusive) end.
  // For a single-line comment, endLine === lineNumber. Optional so external CommentStore
  // implementations migrating from a pre-multiline schema can return rows without it;
  // every in-tree consumer treats a missing endLine as equal to lineNumber.
  lineNumber: number
  endLine?: number
  // Single line: the one line's text. Range: lines joined with '\n' (one entry per row in
  // [lineNumber, endLine]). Consumers that split on newline or take .length need to branch
  // on whether endLine > lineNumber.
  lineContent: string
  body: string
  // 'draft' = saved but not yet visible to the agent — suppressed from every
  // watcher/ws broadcast (comment-added, comment-updated) until "Post
  // drafts" or "Done reviewing" flips it to 'open' in one batch. Server-side
  // so a draft survives a tab reload, unlike a client-only queue.
  status: 'open' | 'resolved' | 'draft'
  createdAt: number
  replies: CommentReply[]
  // GitHub-style staleness flag, independent of status: a live file edit
  // moved or removed the text this comment was anchored to and re-anchoring
  // (see reanchor.ts) couldn't find a confident new position. The comment
  // stays at its last-known lineNumber/endLine — still useful context, just
  // not guaranteed to point at the right lines anymore. Absent/false means
  // current.
  outdated?: boolean
  // Optional inline-suggestion payload. When present, the comment is a
  // proposed rewrite: lineContent holds the original lines being replaced
  // (one per row in [lineNumber, endLine]); suggestion.newLines is the
  // replacement. Rendered to the agent as a ```suggestion fenced block.
  suggestion?: {
    newLines: string[]
  }
  // Schema v3: optional character-level anchor, on top of the line-level
  // anchor above (lineNumber/endLine/lineContent stay valid and are what
  // every pre-v3 consumer already understands -- a line-only comment simply
  // omits these three fields). When present, they narrow the comment to an
  // exact substring: startColumn is a 0-based offset into the first
  // anchored line (lineNumber), endColumn a 0-based *exclusive* offset into
  // the last anchored line (endLine ?? lineNumber) -- i.e. selectedText ===
  // the text between those two points, which may span multiple lines.
  // selectedText is redundant with (lineContent + start/endColumn) but
  // included directly so agent-facing rendering doesn't have to recompute
  // a multi-line substring from column offsets.
  startColumn?: number
  endColumn?: number
  selectedText?: string
}
