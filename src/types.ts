// A debounced fs-watcher tick delivering every file whose content changed in
// that tick as one batch, instead of a `file-changed` per path (see
// docs/design/reactive-loop-perf.md).
export interface FilesChangedEvent {
  type: 'files-changed'
  paths: string[]
}

/** Character range of an inline edit; all offsets 0-based within the line. */
export interface EditRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

// Every frame on `/api/events` (SSE, all frames) and `/api/events-ws` (agent
// ws, human-originated frames only — see `agent_visible` in krit/src/server.rs).
// This union is the TypeScript face of Rust's `Event` enum in krit/src/types.rs
// (`#[serde(tag = "type", rename_all = "kebab-case")]`, camelCase fields); the
// two must be changed together, and Rust's snapshot tests pin the wire strings.
export type KritEvent =
  // Subscriber census, broadcast when any subscriber joins or leaves.
  | { type: 'state'; watcherCount: number; uiCount: number; agentCount: number }
  // Browser presence alone. Counts `role:ui` subscribers, and each tab opens
  // two EventSources, so one open tab reports `browsers: 2` (v1 contract).
  | { type: 'clients'; browsers: number }
  | { type: 'comment-added'; comment: ReviewComment }
  | { type: 'comment-updated'; comment: ReviewComment }
  // `commentStatus` is the comment's status *after* the reply was applied: a
  // human reply reopens a resolved comment, so it can differ from what the
  // client last saw.
  | {
      type: 'reply-added'
      commentId: string
      reply: CommentReply
      commentStatus: ReviewComment['status']
    }
  // A single file changed outside the watcher's batch path (direct edit/undo).
  | { type: 'file-changed'; path: string }
  | FilesChangedEvent
  // A save landed. `path: null` is the agent's "refetch everything" echo.
  | { type: 'file-written'; path: string | null }
  // A human edit in the inline editor. `range`/`deletedText`/`insertedText`
  // are absent for actions that don't carry them (e.g. a whole-file save).
  | {
      type: 'user-edit'
      action: string
      filePath: string
      range?: EditRange
      deletedText?: string
      insertedText?: string
    }
  // The reviewer clicked "Done reviewing"; queued comments are already posted.
  | { type: 'submitted'; timestamp: number; summary?: string }
  | { type: 'review-ended'; reason: string }

export interface CommentReply {
  id: string
  body: string
  createdAt: number
  // Set by the producer: 'user' for a reply posted through
  // POST /api/comments/{id}/replies?source=ui (the browser opts in
  // explicitly), 'agent' for the same route without it — so an unknown client
  // defaults to 'agent' and can't feed the agent's own event loop.
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
  // 'queued' = saved but not yet visible to the agent — suppressed from every
  // watcher/ws broadcast (comment-added, comment-updated) until "Post queued"
  // or "Done reviewing" flips it to 'open' in one batch. Server-side so it
  // survives a tab reload, unlike a client-only queue. Stores written before
  // the rename say 'draft'; the server migrates them on load.
  status: 'open' | 'resolved' | 'queued'
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

// Comment text the reviewer is still typing -- not a comment yet. Mirrors
// `PendingDraft` in krit/src/types.rs.
//
// Distinct from a ReviewComment with status 'queued', which *is* a comment:
// stored, listable, and merely withheld from the agent until posted. Both were
// once called "draft"; 'queued' took over the submitted one so that "draft"
// can mean only this.
//
// Identity is the anchor, not an id: one open form per file + side + line
// range, matching how CodeViewWrapper's `pending` map is keyed. A second draft
// in the same slot is the same draft.
export interface PendingDraft {
  filePath: string
  side: 'deletions' | 'additions'
  startLine: number
  endLine: number
  body: string
  // Whether the suggestion editor is open and what is in it. Both belong to the
  // draft: restoring the body alone would silently drop a typed rewrite.
  suggestMode: boolean
  suggestionText: string
  // Whether suggestionText was typed by the reviewer rather than seeded from
  // the file. Authoritative when present; absent (a store written before the
  // field existed), the UI falls back to comparing text against file.
  suggestionEdited?: boolean
  startColumn?: number
  endColumn?: number
  selectedText?: string
  updatedAt: number
}
