import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import {
  backgroundProjectionPrefix, maxProvenanceAncestors, ProvenancePublicationRefused,
  type ProvenanceMessageSource, type ProvenanceParent, type ProvenancePublication, type ProvenanceRevisionState,
} from "../../application/provenance/provenance-graph.js";

export interface ParentRow { id: string; guildId: string; channelId: string; state: ProvenanceRevisionState; ordinal: number }

// One edge per parent and projection; repeating an entry in the input is not an error.
export function uniqueParents(parents: readonly ProvenanceParent[]): ProvenanceParent[] {
  return [...new Map(parents.map((parent) => [JSON.stringify([parent.revisionId, parent.projection]), parent])).values()];
}

// Direct parents must exist, share the child's scope, be published and have a smaller ordinal. Ordinals
// only compare within one scope, which is why parents may not cross scopes.
export function checkParents(input: ProvenancePublication, rows: readonly ParentRow[], ordinal: number): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parents = input.parents.map((parent) => byId.get(parent.revisionId));
  if (parents.some((row) => !row)) throw new ProvenancePublicationRefused("missing_parent");
  if (parents.some((row) => row!.guildId !== input.guildId || row!.channelId !== input.channelId)) throw new ProvenancePublicationRefused("cross_scope_parent");
  if (parents.some((row) => row!.state !== "published")) throw new ProvenancePublicationRefused("unpublished_parent");
  if (parents.some((row) => row!.ordinal >= ordinal)) throw new ProvenancePublicationRefused("forward_parent");
}

const reach = (childId: string): SQL => sql`WITH RECURSIVE reach(id) AS (
  SELECT ${childId} UNION SELECT e.parent_id FROM provenance_edges e JOIN reach ON e.child_id = reach.id)`;

// How many revisions the new child reaches, stopping one past the limit.
export const ancestorCountQuery = (childId: string): SQL =>
  sql`${reach(childId)} SELECT count(*) AS visited FROM (SELECT id FROM reach LIMIT ${maxProvenanceAncestors + 1}) bounded`;

// Kinds whose artifact ID is a Discord message ID, so a message revocation applies to them: a person's
// message and a delivered bot reply part.
const discordMessageKinds = sql.raw("('message', 'reply_part')");

// Unpublished ancestors, and revoked Discord messages reached as conversation. A message reached only
// through a background_text edge keeps the guild's retention policy, as on v1. The child itself counts
// when it is a Discord message: a revoked message cannot get a new revision.
export const ancestryProblemsQuery = (childId: string): SQL => sql`${reach(childId)} SELECT
  (SELECT count(*) FROM reach JOIN provenance_revisions r ON r.id = reach.id WHERE r.id <> ${childId} AND r.state <> 'published') AS unpublished,
  (SELECT count(*) FROM provenance_edges e JOIN reach ON e.child_id = reach.id JOIN provenance_revisions p ON p.id = e.parent_id
    JOIN message_revocations m ON m.guild_id = p.guild_id AND m.channel_id = p.channel_id AND m.message_id = p.artifact_id
    WHERE p.kind IN ${discordMessageKinds} AND e.projection NOT LIKE ${`${backgroundProjectionPrefix}%`})
  + (SELECT count(*) FROM provenance_revisions c JOIN message_revocations m ON m.guild_id = c.guild_id AND m.channel_id = c.channel_id AND m.message_id = c.artifact_id
    WHERE c.id = ${childId} AND c.kind IN ${discordMessageKinds}) AS revoked`;

export function checkAncestry(visited: number, problems: { unpublished: number; revoked: number }): void {
  if (visited > maxProvenanceAncestors) throw new ProvenancePublicationRefused("ancestry_limit");
  if (problems.revoked > 0) throw new ProvenancePublicationRefused("revoked_ancestry");
  if (problems.unpublished > 0) throw new ProvenancePublicationRefused("unpublished_parent");
}

export function revisionValues(input: ProvenancePublication, id: string, ordinal: number): {
  id: string; guildId: string; channelId: string; kind: ProvenancePublication["kind"]; artifactId: string; version: number; ordinal: number;
  state: "published"; completeness: ProvenancePublication["completeness"]; purpose: string | null; audienceUserId: string | null;
  outputHash: string | null; attachmentHash: string | null; authorId: string | null; sourceTimestampMs: number | null; representationHash: string | null;
  subjectId: string | null; ownerId: string | null; asserterId: string | null; lineage: ProvenancePublication["lineage"]; createdAt: Date;
} {
  return {
    id, guildId: input.guildId, channelId: input.channelId, kind: input.kind, artifactId: input.artifactId, version: input.version, ordinal,
    state: "published", completeness: input.completeness, purpose: input.purpose ?? null, audienceUserId: input.audienceUserId ?? null,
    outputHash: input.outputHash ?? null, attachmentHash: input.attachmentHash ?? null, authorId: input.authorId ?? null,
    sourceTimestampMs: input.sourceTimestampMs ?? null, representationHash: input.representationHash ?? null,
    subjectId: input.subjectId ?? null, ownerId: input.ownerId ?? null, asserterId: input.asserterId ?? null,
    lineage: input.lineage ?? null, createdAt: new Date(input.publishedAt),
  };
}

// First revisions of Discord messages, with ordinals after base. A message revision stands for the
// message itself; each edge pins the exact representation a child was given.
export function newMessageRevisions(guildId: string, channelId: string, messages: readonly ProvenanceMessageSource[], base: number, at: number):
  { revision: ReturnType<typeof revisionValues>; pointer: { guildId: string; channelId: string; kind: "message"; artifactId: string; revisionId: string; version: number } }[] {
  return messages.map((message, index) => {
    const id = randomUUID();
    const revision = revisionValues({ guildId, channelId, kind: "message", artifactId: message.messageId, version: 1, completeness: "complete",
      authorId: message.authorId, sourceTimestampMs: message.timestampMs, parents: [], publishedAt: at }, id, base + index + 1);
    return { revision, pointer: { guildId, channelId, kind: "message" as const, artifactId: message.messageId, revisionId: id, version: 1 } };
  });
}
