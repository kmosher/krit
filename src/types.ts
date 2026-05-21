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
  status: 'open' | 'resolved'
  createdAt: number
  replies: CommentReply[]
}
