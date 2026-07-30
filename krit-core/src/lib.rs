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
