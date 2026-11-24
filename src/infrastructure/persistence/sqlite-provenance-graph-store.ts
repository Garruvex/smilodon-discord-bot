import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { chunked } from "../../application/chat/message-revocation-store.js";
import {
  ProvenancePublicationRefused,
  type ProvenanceAdmission, type ProvenanceAncestryCheck, type ProvenanceDescendant, type ProvenanceGraphStore, type ProvenanceMessageSource, type ProvenanceParent, type ProvenancePublication, type ProvenancePublishResult, type ProvenanceRevisionKind,
} from "../../application/provenance/provenance-graph.js";
import * as schema from "../database/sqlite-schema.js";
import { ancestorCountQuery, ancestorMessagesQuery, currentDescendantsQuery, toAncestorMessages, toDescendants, ancestryCountsQuery, ancestryProblemsQuery, ancestryRevokedQuery, toAdmissions, checkAncestry, checkParents, newMessageRevisions, revisionValues, uniqueParents, type ParentRow } from "./provenance-graph-shared.js";

export class SqliteProvenanceGraphStore implements ProvenanceGraphStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}

  public publish(input: ProvenancePublication): Promise<ProvenancePublishResult> {
    const parents = uniqueParents(input.parents);
    const scopes = schema.messageRevocationScopes;
    try {
      // SQLite runs one write transaction at a time, so this is serialized with revocation already.
      return Promise.resolve(this.database.transaction((transaction) => {
        const ordinal = transaction.insert(scopes).values({ guildId: input.guildId, channelId: input.channelId, revision: 0, ordinal: 1 })
          .onConflictDoUpdate({ target: [scopes.guildId, scopes.channelId], set: { ordinal: sql`${scopes.ordinal} + 1` } })
          .returning({ ordinal: scopes.ordinal }).get().ordinal;
        const rows: ParentRow[] = [];
        for (const chunk of chunked([...new Set(parents.map((parent) => parent.revisionId))])) {
          rows.push(...transaction.select({ id: schema.provenanceRevisions.id, guildId: schema.provenanceRevisions.guildId, channelId: schema.provenanceRevisions.channelId,
            state: schema.provenanceRevisions.state, ordinal: schema.provenanceRevisions.ordinal }).from(schema.provenanceRevisions)
            .where(inArray(schema.provenanceRevisions.id, chunk)).all());
        }
        checkParents({ ...input, parents }, rows, ordinal);
        const artifact = and(eq(schema.provenanceRevisions.guildId, input.guildId), eq(schema.provenanceRevisions.channelId, input.channelId),
          eq(schema.provenanceRevisions.kind, input.kind), eq(schema.provenanceRevisions.artifactId, input.artifactId));
        const current = this.currentRow(transaction, input.guildId, input.channelId, input.kind, input.artifactId);
        if (current && current.version >= input.version) throw new ProvenancePublicationRefused("stale_version");
        if (transaction.select({ id: schema.provenanceRevisions.id }).from(schema.provenanceRevisions)
          .where(and(artifact, eq(schema.provenanceRevisions.version, input.version))).get()) throw new ProvenancePublicationRefused("duplicate_version");
        const id = randomUUID();
        transaction.insert(schema.provenanceRevisions).values(revisionValues(input, id, ordinal)).run();
        for (const chunk of chunked(parents)) {
          transaction.insert(schema.provenanceEdges).values(chunk.map((parent) => ({ childId: id, parentId: parent.revisionId, projection: parent.projection,
            representationHash: parent.representationHash, assetsHash: parent.assetsHash ?? null }))).run();
        }
        const visited = Number(transaction.get<{ visited: number }>(ancestorCountQuery(id)).visited);
        const problems = transaction.get<{ unpublished: number; revoked: number }>(ancestryProblemsQuery(id));
        checkAncestry(visited, { unpublished: Number(problems.unpublished), revoked: Number(problems.revoked) });
        transaction.insert(schema.provenanceCurrent).values({ guildId: input.guildId, channelId: input.channelId, kind: input.kind, artifactId: input.artifactId, revisionId: id, version: input.version })
          .onConflictDoUpdate({ target: [schema.provenanceCurrent.guildId, schema.provenanceCurrent.channelId, schema.provenanceCurrent.kind, schema.provenanceCurrent.artifactId],
            set: { revisionId: id, version: input.version } }).run();
        return { status: "published" as const, revisionId: id, ordinal };
      }));
    } catch (error) {
      if (error instanceof ProvenancePublicationRefused) return Promise.resolve({ status: "refused", reason: error.reason });
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public ensureMessages(guildId: string, channelId: string, messages: readonly ProvenanceMessageSource[], at: number): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Map(messages.map((message) => [message.messageId, message])).values()];
    const scopes = schema.messageRevocationScopes; const current = schema.provenanceCurrent;
    return Promise.resolve(this.database.transaction((transaction) => {
      const base = transaction.insert(scopes).values({ guildId, channelId, revision: 0, ordinal: 0 })
        .onConflictDoUpdate({ target: [scopes.guildId, scopes.channelId], set: { ordinal: sql`${scopes.ordinal}` } }).returning({ ordinal: scopes.ordinal }).get().ordinal;
      const found = new Map<string, string>(); const revoked = new Set<string>();
      for (const chunk of chunked(unique.map((message) => message.messageId))) {
        for (const row of transaction.select({ artifactId: current.artifactId, revisionId: current.revisionId }).from(current).where(and(eq(current.guildId, guildId),
          eq(current.channelId, channelId), eq(current.kind, "message"), inArray(current.artifactId, chunk))).all()) found.set(row.artifactId, row.revisionId);
        for (const row of transaction.select({ messageId: schema.messageRevocations.messageId }).from(schema.messageRevocations).where(and(eq(schema.messageRevocations.guildId, guildId),
          eq(schema.messageRevocations.channelId, channelId), inArray(schema.messageRevocations.messageId, chunk))).all()) revoked.add(row.messageId);
      }
      const created = newMessageRevisions(guildId, channelId, unique.filter((message) => !found.has(message.messageId) && !revoked.has(message.messageId)), base, at);
      for (const chunk of chunked(created)) {
        transaction.insert(schema.provenanceRevisions).values(chunk.map((entry) => entry.revision)).run();
        transaction.insert(current).values(chunk.map((entry) => entry.pointer)).run();
      }
      if (created.length) transaction.update(scopes).set({ ordinal: base + created.length }).where(and(eq(scopes.guildId, guildId), eq(scopes.channelId, channelId))).run();
      for (const entry of created) found.set(entry.pointer.artifactId, entry.revision.id);
      for (const id of revoked) found.delete(id);
      return found;
    }));
  }

  public currentOutputs(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactIds: readonly string[]): Promise<ReadonlyMap<string, { revisionId: string; outputHash: string | null }>> {
    const current = schema.provenanceCurrent; const revision = schema.provenanceRevisions; const found = new Map<string, { revisionId: string; outputHash: string | null }>();
    for (const chunk of chunked([...new Set(artifactIds)])) {
      for (const row of this.database.select({ artifactId: current.artifactId, revisionId: current.revisionId, outputHash: revision.outputHash }).from(current)
        .innerJoin(revision, eq(revision.id, current.revisionId)).where(and(eq(current.guildId, guildId), eq(current.channelId, channelId), eq(current.kind, kind),
          inArray(current.artifactId, chunk))).all()) found.set(row.artifactId, { revisionId: row.revisionId, outputHash: row.outputHash });
    }
    return Promise.resolve(found);
  }

  public currentDescendants(guildId: string, channelId: string, messageIds: readonly string[]): Promise<readonly ProvenanceDescendant[]> {
    const found = new Map<string, ProvenanceDescendant>();
    for (const chunk of chunked([...new Set(messageIds)])) toDescendants(this.database.all(currentDescendantsQuery(guildId, channelId, chunk)), found);
    return Promise.resolve([...found.values()]);
  }

  public currentMany(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const current = schema.provenanceCurrent; const found = new Map<string, string>();
    for (const chunk of chunked([...new Set(artifactIds)])) {
      for (const row of this.database.select({ artifactId: current.artifactId, revisionId: current.revisionId }).from(current).where(and(eq(current.guildId, guildId),
        eq(current.channelId, channelId), eq(current.kind, kind), inArray(current.artifactId, chunk))).all()) found.set(row.artifactId, row.revisionId);
    }
    return Promise.resolve(found);
  }

  public retract(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string, revisionId: string): Promise<boolean> {
    const current = schema.provenanceCurrent;
    return Promise.resolve(this.database.delete(current).where(and(eq(current.guildId, guildId), eq(current.channelId, channelId), eq(current.kind, kind),
      eq(current.artifactId, artifactId), eq(current.revisionId, revisionId))).run().changes > 0);
  }

  public checkAncestry(input: ProvenanceAncestryCheck): Promise<ReadonlyMap<string, ProvenanceAdmission>> {
    const roots = [...new Set(input.revisionIds)];
    const result = new Map<string, ProvenanceAdmission>();
    for (const chunk of chunked(roots)) {
      const counts = this.database.all(ancestryCountsQuery(input.guildId, input.channelId, chunk, input.audienceUserId));
      const revoked = this.database.all(ancestryRevokedQuery(input.guildId, input.channelId, chunk));
      for (const [root, admission] of toAdmissions(chunk, counts, revoked, input.budget)) result.set(root, admission);
    }
    return Promise.resolve(result);
  }

  public ancestorMessages(guildId: string, channelId: string, revisionIds: readonly string[]): Promise<ReadonlyMap<string, readonly ProvenanceMessageSource[]>> {
    const result = new Map<string, ProvenanceMessageSource[]>();
    for (const chunk of chunked([...new Set(revisionIds)])) toAncestorMessages(this.database.all(ancestorMessagesQuery(guildId, channelId, chunk)), result);
    return Promise.resolve(result);
  }

  public current(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string): Promise<{ revisionId: string; version: number } | null> {
    return Promise.resolve(this.currentRow(this.database, guildId, channelId, kind, artifactId) ?? null);
  }

  public parents(revisionId: string): Promise<ProvenanceParent[]> {
    return Promise.resolve(this.database.select({ revisionId: schema.provenanceEdges.parentId, projection: schema.provenanceEdges.projection,
      representationHash: schema.provenanceEdges.representationHash, assetsHash: schema.provenanceEdges.assetsHash })
      .from(schema.provenanceEdges).where(eq(schema.provenanceEdges.childId, revisionId)).all());
  }

  private currentRow(database: Pick<BetterSQLite3Database<typeof schema>, "select">, guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string):
    { revisionId: string; version: number } | undefined {
    return database.select({ revisionId: schema.provenanceCurrent.revisionId, version: schema.provenanceCurrent.version }).from(schema.provenanceCurrent)
      .where(and(eq(schema.provenanceCurrent.guildId, guildId), eq(schema.provenanceCurrent.channelId, channelId),
        eq(schema.provenanceCurrent.kind, kind), eq(schema.provenanceCurrent.artifactId, artifactId))).get();
  }
}
