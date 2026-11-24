import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { chunked } from "../../application/chat/message-revocation-store.js";
import {
  ProvenancePublicationRefused,
  type ProvenanceGraphStore, type ProvenanceParent, type ProvenancePublication, type ProvenancePublishResult, type ProvenanceRevisionKind,
} from "../../application/provenance/provenance-graph.js";
import * as schema from "../database/sqlite-schema.js";
import { ancestorCountQuery, ancestryProblemsQuery, checkAncestry, checkParents, revisionValues, uniqueParents, type ParentRow } from "./provenance-graph-shared.js";

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
