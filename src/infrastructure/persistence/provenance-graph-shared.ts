import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  admissionFrom, type ProvenanceAdmission,
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

// Every revision each root reaches, deduplicated per root, for a batched admission check.
const reachFrom = (guildId: string, channelId: string, roots: readonly string[]): SQL => sql`WITH RECURSIVE reach(root, id) AS (
  SELECT r.id, r.id FROM provenance_revisions r WHERE r.guild_id = ${guildId} AND r.channel_id = ${channelId} AND r.id IN (${sql.join(roots.map((root) => sql`${root}`), sql`, `)})
  UNION SELECT reach.root, e.parent_id FROM provenance_edges e JOIN reach ON e.child_id = reach.id)`;

// Per root: revisions reached, and how many are missing, unpublished, in another scope or produced for
// another audience. An ancestor made for one person is admissible only in a read for that person.
export const ancestryCountsQuery = (guildId: string, channelId: string, roots: readonly string[], audienceUserId: string | null): SQL =>
  sql`${reachFrom(guildId, channelId, roots)} SELECT reach.root AS root, count(*) AS visited,
    sum(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END) AS missing,
    sum(CASE WHEN r.state <> 'published' THEN 1 ELSE 0 END) AS unpublished,
    sum(CASE WHEN r.guild_id <> ${guildId} OR r.channel_id <> ${channelId} THEN 1 ELSE 0 END) AS foreign_scope,
    sum(CASE WHEN r.audience_user_id IS NOT NULL AND (CAST(${audienceUserId} AS text) IS NULL OR r.audience_user_id <> CAST(${audienceUserId} AS text)) THEN 1 ELSE 0 END) AS audience
    FROM reach LEFT JOIN provenance_revisions r ON r.id = reach.id GROUP BY reach.root`;

// Per root: revoked Discord messages reached as conversation, the root itself included.
export const ancestryRevokedQuery = (guildId: string, channelId: string, roots: readonly string[]): SQL =>
  sql`${reachFrom(guildId, channelId, roots)} SELECT root, sum(revoked) AS revoked FROM (
    SELECT reach.root AS root, count(*) AS revoked FROM reach JOIN provenance_edges e ON e.child_id = reach.id JOIN provenance_revisions p ON p.id = e.parent_id
      JOIN message_revocations m ON m.guild_id = p.guild_id AND m.channel_id = p.channel_id AND m.message_id = p.artifact_id
      WHERE p.kind IN ${discordMessageKinds} AND e.projection NOT LIKE ${`${backgroundProjectionPrefix}%`} GROUP BY reach.root
    UNION ALL
    SELECT r.id AS root, count(*) AS revoked FROM provenance_revisions r JOIN message_revocations m ON m.guild_id = r.guild_id AND m.channel_id = r.channel_id AND m.message_id = r.artifact_id
      WHERE r.id IN (${sql.join(roots.map((root) => sql`${root}`), sql`, `)}) AND r.kind IN ${discordMessageKinds} GROUP BY r.id
  ) found GROUP BY root`;

const countsRow = z.object({ root: z.string(), visited: z.coerce.number(), missing: z.coerce.number(), unpublished: z.coerce.number(),
  foreign_scope: z.coerce.number(), audience: z.coerce.number() });
const revokedRow = z.object({ root: z.string(), revoked: z.coerce.number() });

export function toAdmissions(roots: readonly string[], counts: readonly unknown[], revoked: readonly unknown[], budget: number): Map<string, ProvenanceAdmission> {
  const revokedBy = new Map(revoked.map((row) => revokedRow.parse(row)).map((row) => [row.root, row.revoked]));
  const countsBy = new Map(counts.map((row) => countsRow.parse(row)).map((row) => [row.root, row]));
  return new Map(roots.map((root) => {
    const row = countsBy.get(root);
    return [root, admissionFrom(row && { visited: row.visited, missing: row.missing, unpublished: row.unpublished, foreignScope: row.foreign_scope,
      audience: row.audience, revoked: revokedBy.get(root) ?? 0 }, budget)];
  }));
}

// Per root: the person's messages it reaches, with author and time, for forget and opt-out checks.
export const ancestorMessagesQuery = (guildId: string, channelId: string, roots: readonly string[]): SQL =>
  sql`${reachFrom(guildId, channelId, roots)} SELECT reach.root AS root, r.artifact_id AS message_id, r.author_id AS author_id, r.source_timestamp_ms AS timestamp_ms
    FROM reach JOIN provenance_revisions r ON r.id = reach.id WHERE r.kind = 'message'`;

const messageRow = z.object({ root: z.string(), message_id: z.string(), author_id: z.string().nullable(), timestamp_ms: z.coerce.number().nullable() });
export function toAncestorMessages(rows: readonly unknown[], into: Map<string, ProvenanceMessageSource[]>): void {
  for (const row of rows.map((value) => messageRow.parse(value))) {
    // A message revision always carries its author and time; one without them cannot be checked.
    const entry = { messageId: row.message_id, authorId: row.author_id ?? "", timestampMs: row.timestamp_ms ?? -1 };
    const list = into.get(row.root); if (list) list.push(entry); else into.set(row.root, [entry]);
  }
}
