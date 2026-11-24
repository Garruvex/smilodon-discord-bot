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

// The pinned projection of a parent, as stored on an edge: "full", or a v1 text projection with its limit.
export function projectionKey(projection?: { kind: "background_text" | "human_text"; chars: number }): string {
  return projection ? `${projection.kind}:${projection.chars}` : "full";
}
// A message reached through a background_text edge keeps the guild's retention policy: an observed delete
// does not revoke what was built from it.
export const backgroundProjectionPrefix = "background_text:";

export interface ProvenanceParent {
  revisionId: string;
  projection: string;
  representationHash: string;
  assetsHash?: string | null;
}

export interface ProvenancePublication {
  guildId: string;
  channelId: string;
  kind: ProvenanceRevisionKind;
  artifactId: string;
  // Caller-chosen output version. It must be greater than the current one.
  version: number;
  completeness: ProvenanceCompleteness;
  purpose?: string | null;
  audienceUserId?: string | null;
  outputHash?: string | null;
  attachmentHash?: string | null;
  authorId?: string | null;
  sourceTimestampMs?: number | null;
  representationHash?: string | null;
  subjectId?: string | null;
  ownerId?: string | null;
  asserterId?: string | null;
  lineage?: ProvenanceLineage | null;
  // The full parent set. Every parent must be published, in the same scope, with a smaller ordinal.
  parents: readonly ProvenanceParent[];
  publishedAt: number;
}

export type ProvenanceRefusal = "missing_parent" | "unpublished_parent" | "cross_scope_parent" | "forward_parent" |
  "revoked_ancestry" | "ancestry_limit" | "stale_version" | "duplicate_version";

export type ProvenancePublishResult =
  | { status: "published"; revisionId: string; ordinal: number }
  | { status: "refused"; reason: ProvenanceRefusal };

// Ancestors one publication may visit while checking for revocations and unpublished revisions.
export const maxProvenanceAncestors = 4096;

// Publishes a revision, its full parent set and the current pointer in one transaction, holding the
// scope row that revocation also takes. A revocation committed first is seen and refuses publication.
// One that commits afterwards finds the new revision through the edges.
export interface ProvenanceMessageSource { messageId: string; authorId: string; timestampMs: number }

export interface ProvenanceGraphStore {
  publish(input: ProvenancePublication): Promise<ProvenancePublishResult>;
  // The current revision of each Discord message, publishing a first one where there is none, in one
  // transaction under the scope lock. A revoked message gets none and is left out of the result.
  ensureMessages(guildId: string, channelId: string, messages: readonly ProvenanceMessageSource[], at: number): Promise<ReadonlyMap<string, string>>;
  // Current revisions of these artifacts, by artifact ID; absent ones are left out.
  currentMany(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  current(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string): Promise<{ revisionId: string; version: number } | null>;
  parents(revisionId: string): Promise<ProvenanceParent[]>;
  // Removes the current pointer if it still names this revision. The revision itself stays, immutable,
  // so descendants keep their ancestry; the artifact just has no usable version until a new one.
  retract(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string, revisionId: string): Promise<boolean>;
}

export class ProvenancePublicationRefused extends Error {
  public constructor(public readonly reason: ProvenanceRefusal) { super(`Provenance publication refused: ${reason}`); }
}

// How each message in a reply's v1 proof reached the turn. direct: read as an input this turn. carriers:
// the earlier artifacts whose proofs brought it in, as "reply:<message ID>", "claim:<memory ID>" or
// "derived:<purpose>". A message reached only through a reply already in the graph needs no edge of its
// own; its ancestry already covers it.
export interface ProvenanceInput {
  messageId: string;
  origin: "human" | "chat" | null;
  direct: boolean;
  carriers: readonly string[];
}
