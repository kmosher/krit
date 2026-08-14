//! What a krit client needs before it can be one: the wire types, the state
//! file that says where the server is, and the repo identity both are keyed
//! by. Nothing here reaches for the network or the diff — this is the part
//! the server and its clients must agree on exactly, extracted so that
//! agreement is a compile error rather than a convention.
//!
//! `src/types.ts` is the third implementation of the same contract, and the
//! one that cannot be checked this way; see the note at the head of `types`.

pub mod patch;
pub mod repo;
pub mod state;
pub mod types;

/// The largest response body a client will read, in bytes.
///
/// Both Rust clients need this and both need the same answer, which is what
/// puts it here rather than in each of them: it is a fact about the wire, not
/// about either client. `/api/diff` bundles both sides of every file's contents
/// (that is what makes expanding a gap a local operation), so a review of a few
/// large files clears ureq's 10 MiB default on its own — and a body refused for
/// being too large fails as a parse error naming no cap, which is a bad way to
/// learn a review is too big.
///
/// Generous rather than tuned. The cap is a defence against a hostile server
/// streaming until the client dies; this one is on loopback and was usually
/// started by the client reading it, so the number only has to be larger than
/// any real review.
pub const MAX_BODY: u64 = 512 * 1024 * 1024;

/// The largest *error* body a client will read.
///
/// Small on purpose, and separate for that reason: an error body only has to
/// carry the server's `error` field, so reading it under the same cap as a diff
/// would let anything on that port spend half a gigabyte of the client's memory
/// on one line of terminal output. Whatever is answering has already surprised
/// us by the time this is consulted.
pub const MAX_ERROR_BODY: u64 = 64 * 1024;
