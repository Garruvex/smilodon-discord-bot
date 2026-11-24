import type { ContextProvenance } from "../chat/context-provenance.js";

// The versioned provenance graph that shadows v1 proofs. A revision is one immutable version of a
// source or artifact in a scope. An edge says a parent revision was supplied, in a pinned projection,
// when the child revision was produced. A revocation reaches every descendant through these edges.

// "message" is a Discord source. The rest are artifacts the bot derived.
export type ProvenanceRevisionKind = "message" | "reply_part" | "session" | "claim" | "alias" | "relation" |
  "background_job" | "drift" | "callback" | "character_state";

// staged: written but not yet usable (a legacy import waiting for its parents). published: usable.
export type ProvenanceRevisionState = "staged" | "published";

// complete: the parent set is exactly the inputs supplied. flattened: imported from a legacy v1 proof,
// whose flat list cannot say which parent was immediate, so every entry is kept as a direct parent.
export type ProvenanceCompleteness = "complete" | "flattened";

// Validation material the v1 proof carries besides message dependencies, kept with its v1 meaning.
export type ProvenanceLineage = Pick<ContextProvenance, "actors" | "resources" | "publicWeb" | "publicTools">;

// "full" is the whole supplied representation; the other two are v1's text projections.
export type ProvenanceProjectionKind = "full" | "background_text" | "human_text";

// Artifacts that are not tied to one channel use this channel key.
export const guildWideScope = "*";
