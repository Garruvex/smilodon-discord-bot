import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { chunked } from "../../application/chat/message-revocation-store.js";
import {
  ProvenancePublicationRefused,
  type ProvenanceGraphStore, type ProvenanceParent, type ProvenancePublication, type ProvenancePublishResult, type ProvenanceRevisionKind,
} from "../../application/provenance/provenance-graph.js";
import * as schema from "../database/schema.js";
import { ancestorCountQuery, ancestryProblemsQuery, checkAncestry, checkParents, revisionValues, uniqueParents, type ParentRow } from "./provenance-graph-shared.js";

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
