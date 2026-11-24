import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { chunked } from "../../application/chat/message-revocation-store.js";
import {
  ProvenancePublicationRefused,
  type ProvenanceAdmission, type ProvenanceAncestryCheck, type ProvenanceDescendant, type ProvenanceGraphStore, type ProvenanceMessageSource, type ProvenanceParent, type ProvenancePublication, type ProvenancePublishResult, type ProvenanceRevisionKind,
} from "../../application/provenance/provenance-graph.js";
import * as schema from "../database/schema.js";
import { ancestorCountQuery, ancestorMessagesQuery, currentDescendantsQuery, toAncestorMessages, toDescendants, ancestryCountsQuery, ancestryProblemsQuery, ancestryRevokedQuery, toAdmissions, checkAncestry, checkParents, newMessageRevisions, revisionValues, uniqueParents, type ParentRow } from "./provenance-graph-shared.js";

const countRow = z.object({ visited: z.coerce.number() });
const problemsRow = z.object({ unpublished: z.coerce.number(), revoked: z.coerce.number() });

export class PostgresProvenanceGraphStore implements ProvenanceGraphStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async publish(input: ProvenancePublication): Promise<ProvenancePublishResult> {
    const parents = uniqueParents(input.parents);
    const scopes = schema.messageRevocationScopes;
    try {
      return await this.database.transaction(async (transaction) => {
        // Takes the scope row revocation takes. Everything after it sees every revocation committed
        // before this point, and a revocation waiting on the row commits after this publication.
        const [scope] = await transaction.insert(scopes).values({ guildId: input.guildId, channelId: input.channelId, revision: 0, ordinal: 1 })
          .onConflictDoUpdate({ target: [scopes.guildId, scopes.channelId], set: { ordinal: sql`${scopes.ordinal} + 1` } })
          .returning({ ordinal: scopes.ordinal });
        const ordinal = scope!.ordinal;
        const rows: ParentRow[] = [];
        for (const chunk of chunked([...new Set(parents.map((parent) => parent.revisionId))])) {
          rows.push(...await transaction.select({ id: schema.provenanceRevisions.id, guildId: schema.provenanceRevisions.guildId, channelId: schema.provenanceRevisions.channelId,
            state: schema.provenanceRevisions.state, ordinal: schema.provenanceRevisions.ordinal }).from(schema.provenanceRevisions)
            .where(inArray(schema.provenanceRevisions.id, chunk)));
        }
        checkParents({ ...input, parents }, rows, ordinal);
        const current = await this.currentRow(transaction, input.guildId, input.channelId, input.kind, input.artifactId);
        if (current && current.version >= input.version) throw new ProvenancePublicationRefused("stale_version");
        const [existing] = await transaction.select({ id: schema.provenanceRevisions.id }).from(schema.provenanceRevisions)
          .where(and(eq(schema.provenanceRevisions.guildId, input.guildId), eq(schema.provenanceRevisions.channelId, input.channelId),
            eq(schema.provenanceRevisions.kind, input.kind), eq(schema.provenanceRevisions.artifactId, input.artifactId), eq(schema.provenanceRevisions.version, input.version))).limit(1);
        if (existing) throw new ProvenancePublicationRefused("duplicate_version");
        const id = randomUUID();
        await transaction.insert(schema.provenanceRevisions).values(revisionValues(input, id, ordinal));
        for (const chunk of chunked(parents)) {
          await transaction.insert(schema.provenanceEdges).values(chunk.map((parent) => ({ childId: id, parentId: parent.revisionId, projection: parent.projection,
            representationHash: parent.representationHash, assetsHash: parent.assetsHash ?? null })));
        }
        const visited = countRow.parse((await transaction.execute(ancestorCountQuery(id)))[0]).visited;
        checkAncestry(visited, problemsRow.parse((await transaction.execute(ancestryProblemsQuery(id)))[0]));
        await transaction.insert(schema.provenanceCurrent).values({ guildId: input.guildId, channelId: input.channelId, kind: input.kind, artifactId: input.artifactId, revisionId: id, version: input.version })
          .onConflictDoUpdate({ target: [schema.provenanceCurrent.guildId, schema.provenanceCurrent.channelId, schema.provenanceCurrent.kind, schema.provenanceCurrent.artifactId],
            set: { revisionId: id, version: input.version } });
        return { status: "published" as const, revisionId: id, ordinal };
      });
    } catch (error) {
      if (error instanceof ProvenancePublicationRefused) return { status: "refused", reason: error.reason };
      throw error;
    }
  }

  public async ensureMessages(guildId: string, channelId: string, messages: readonly ProvenanceMessageSource[], at: number): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Map(messages.map((message) => [message.messageId, message])).values()];
    const scopes = schema.messageRevocationScopes; const current = schema.provenanceCurrent;
    return this.database.transaction(async (transaction) => {
      // Locks the scope row first, as publish and revoke do.
      const [scope] = await transaction.insert(scopes).values({ guildId, channelId, revision: 0, ordinal: 0 })
        .onConflictDoUpdate({ target: [scopes.guildId, scopes.channelId], set: { ordinal: sql`${scopes.ordinal}` } }).returning({ ordinal: scopes.ordinal });
      const base = scope!.ordinal;
      const found = new Map<string, string>(); const revoked = new Set<string>();
      for (const chunk of chunked(unique.map((message) => message.messageId))) {
        for (const row of await transaction.select({ artifactId: current.artifactId, revisionId: current.revisionId }).from(current).where(and(eq(current.guildId, guildId),
          eq(current.channelId, channelId), eq(current.kind, "message"), inArray(current.artifactId, chunk)))) found.set(row.artifactId, row.revisionId);
        for (const row of await transaction.select({ messageId: schema.messageRevocations.messageId }).from(schema.messageRevocations).where(and(eq(schema.messageRevocations.guildId, guildId),
          eq(schema.messageRevocations.channelId, channelId), inArray(schema.messageRevocations.messageId, chunk)))) revoked.add(row.messageId);
      }
      const created = newMessageRevisions(guildId, channelId, unique.filter((message) => !found.has(message.messageId) && !revoked.has(message.messageId)), base, at);
      for (const chunk of chunked(created)) {
        await transaction.insert(schema.provenanceRevisions).values(chunk.map((entry) => entry.revision));
        await transaction.insert(current).values(chunk.map((entry) => entry.pointer));
      }
      if (created.length) await transaction.update(scopes).set({ ordinal: base + created.length }).where(and(eq(scopes.guildId, guildId), eq(scopes.channelId, channelId)));
      for (const entry of created) found.set(entry.pointer.artifactId, entry.revision.id);
      for (const id of revoked) found.delete(id);
      return found;
    });
  }

  public async currentOutputs(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactIds: readonly string[]): Promise<ReadonlyMap<string, { revisionId: string; outputHash: string | null }>> {
    const current = schema.provenanceCurrent; const revision = schema.provenanceRevisions; const found = new Map<string, { revisionId: string; outputHash: string | null }>();
    for (const chunk of chunked([...new Set(artifactIds)])) {
      for (const row of await this.database.select({ artifactId: current.artifactId, revisionId: current.revisionId, outputHash: revision.outputHash }).from(current)
        .innerJoin(revision, eq(revision.id, current.revisionId)).where(and(eq(current.guildId, guildId), eq(current.channelId, channelId), eq(current.kind, kind),
          inArray(current.artifactId, chunk)))) found.set(row.artifactId, { revisionId: row.revisionId, outputHash: row.outputHash });
    }
    return found;
  }

  public async currentDescendants(guildId: string, channelId: string, messageIds: readonly string[]): Promise<readonly ProvenanceDescendant[]> {
    const found = new Map<string, ProvenanceDescendant>();
    for (const chunk of chunked([...new Set(messageIds)])) toDescendants(await this.database.execute(currentDescendantsQuery(guildId, channelId, chunk)), found);
    return [...found.values()];
  }

  public async currentMany(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const current = schema.provenanceCurrent; const found = new Map<string, string>();
    for (const chunk of chunked([...new Set(artifactIds)])) {
      for (const row of await this.database.select({ artifactId: current.artifactId, revisionId: current.revisionId }).from(current).where(and(eq(current.guildId, guildId),
        eq(current.channelId, channelId), eq(current.kind, kind), inArray(current.artifactId, chunk)))) found.set(row.artifactId, row.revisionId);
    }
    return found;
  }

  public async retract(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string, revisionId: string): Promise<boolean> {
    const current = schema.provenanceCurrent;
    return (await this.database.delete(current).where(and(eq(current.guildId, guildId), eq(current.channelId, channelId), eq(current.kind, kind),
      eq(current.artifactId, artifactId), eq(current.revisionId, revisionId))).returning({ revisionId: current.revisionId })).length > 0;
  }

  public async checkAncestry(input: ProvenanceAncestryCheck): Promise<ReadonlyMap<string, ProvenanceAdmission>> {
    const roots = [...new Set(input.revisionIds)];
    const result = new Map<string, ProvenanceAdmission>();
    for (const chunk of chunked(roots)) {
      const counts = await this.database.execute(ancestryCountsQuery(input.guildId, input.channelId, chunk, input.audienceUserId));
      const revoked = await this.database.execute(ancestryRevokedQuery(input.guildId, input.channelId, chunk));
      for (const [root, admission] of toAdmissions(chunk, counts, revoked, input.budget)) result.set(root, admission);
    }
    return result;
  }

  public async ancestorMessages(guildId: string, channelId: string, revisionIds: readonly string[]): Promise<ReadonlyMap<string, readonly ProvenanceMessageSource[]>> {
    const result = new Map<string, ProvenanceMessageSource[]>();
    for (const chunk of chunked([...new Set(revisionIds)])) toAncestorMessages(await this.database.execute(ancestorMessagesQuery(guildId, channelId, chunk)), result);
    return result;
  }

  public async current(guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string): Promise<{ revisionId: string; version: number } | null> {
    return await this.currentRow(this.database, guildId, channelId, kind, artifactId) ?? null;
  }

  public async parents(revisionId: string): Promise<ProvenanceParent[]> {
    return this.database.select({ revisionId: schema.provenanceEdges.parentId, projection: schema.provenanceEdges.projection,
      representationHash: schema.provenanceEdges.representationHash, assetsHash: schema.provenanceEdges.assetsHash })
      .from(schema.provenanceEdges).where(eq(schema.provenanceEdges.childId, revisionId));
  }

  private async currentRow(database: Pick<PostgresJsDatabase<typeof schema>, "select">, guildId: string, channelId: string, kind: ProvenanceRevisionKind, artifactId: string):
    Promise<{ revisionId: string; version: number } | undefined> {
    const [row] = await database.select({ revisionId: schema.provenanceCurrent.revisionId, version: schema.provenanceCurrent.version }).from(schema.provenanceCurrent)
      .where(and(eq(schema.provenanceCurrent.guildId, guildId), eq(schema.provenanceCurrent.channelId, channelId),
        eq(schema.provenanceCurrent.kind, kind), eq(schema.provenanceCurrent.artifactId, artifactId))).limit(1);
    return row;
  }
}
