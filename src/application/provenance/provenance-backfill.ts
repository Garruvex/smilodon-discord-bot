import { parseScopedContextProvenance } from "../chat/context-provenance.js";
import type { MessageOriginRecord } from "../chat/message-origin-store.js";
import { projectionKey, type ProvenanceGraphStore } from "./provenance-graph.js";

export interface BackfillCursor { createdAt: number; messageId: string }

// Durable reply origins written before the graph existed.
export interface LegacyReplyProofSource {
  pageReplyProofs(after: BackfillCursor | null, limit: number): Promise<MessageOriginRecord[]>;
  find(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null>;
}

export interface BackfillBatch { imported: number; skipped: number; next: BackfillCursor | null }

const sameProof = (a: MessageOriginRecord | null, b: MessageOriginRecord): boolean =>
  JSON.stringify(a?.contextProvenance ?? null) === JSON.stringify(b.contextProvenance ?? null);

// Imports complete, valid legacy reply proofs into the graph. Each import is conservative: the v1 list
// cannot say which parent was immediate, so every dependency becomes a direct edge to its message and
// the revision is marked flattened. No chain is inferred, not even from an earlier reply that is in
// the graph now, and never from timestamps. Items that are not imported keep their v1 read path.
//
// Batches are restartable: every item is idempotent, so a rerun skips what is already imported. Each
// item is checked against its current v1 state, and a concurrent forget or newer revision wins:
// - an artifact the graph already has (from a dual-write or an earlier run) is left alone;
// - a dependency revoked before publication refuses it, under the scope lock;
// - a v1 proof that changed or was cleared before publication is skipped, and one that changed
//   right after publication has the new pointer retracted, so a forgotten artifact never reappears.
export class ProvenanceBackfill {
  public constructor(private readonly graph: ProvenanceGraphStore, private readonly source: LegacyReplyProofSource) {}

  public async runBatch(after: BackfillCursor | null, limit = 200): Promise<BackfillBatch> {
    const records = await this.source.pageReplyProofs(after, limit);
    let imported = 0; let skipped = 0;
    for (const record of records) if (await this.importOne(record)) imported++; else skipped++;
    const last = records.at(-1);
    return { imported, skipped, next: records.length === limit && last ? { createdAt: last.createdAt, messageId: last.messageId } : null };
  }

  private async importOne(record: MessageOriginRecord): Promise<boolean> {
    const proof = parseScopedContextProvenance(record.contextProvenance, record);
    if (record.origin !== "chat" || !proof || proof.coverage !== "complete" || proof.purpose && proof.purpose !== "reply" ||
        proof.dependencies.some((dependency) => dependency.guildId !== record.guildId || dependency.channelId !== record.channelId)) return false;
    if (await this.graph.current(record.guildId, record.channelId, "reply_part", record.messageId)) return false;
    const messages = await this.graph.ensureMessages(record.guildId, record.channelId,
      proof.dependencies.map(({ messageId, authorId, timestampMs }) => ({ messageId, authorId, timestampMs })), record.createdAt);
    if (proof.dependencies.some((dependency) => !messages.has(dependency.messageId))) return false;
    if (!sameProof(await this.source.find(record.guildId, record.channelId, record.messageId), record)) return false;
    const result = await this.graph.publish({
      guildId: record.guildId, channelId: record.channelId, kind: "reply_part", artifactId: record.messageId, version: 1, completeness: "flattened",
      purpose: "reply", audienceUserId: proof.audience.userId, outputHash: proof.outputHash, attachmentHash: proof.outputAssetsHash ?? null,
      lineage: { ...(proof.actors ? { actors: proof.actors } : {}), ...(proof.resources ? { resources: proof.resources } : {}),
        ...(proof.publicWeb ? { publicWeb: proof.publicWeb } : {}), ...(proof.publicTools ? { publicTools: proof.publicTools } : {}) },
      parents: proof.dependencies.map((dependency) => ({ revisionId: messages.get(dependency.messageId)!, projection: projectionKey(dependency.projection),
        representationHash: dependency.representationHash, assetsHash: dependency.assetsHash ?? null })),
      publishedAt: record.createdAt,
    });
    if (result.status !== "published") return false;
    if (!sameProof(await this.source.find(record.guildId, record.channelId, record.messageId), record)) {
      await this.graph.retract(record.guildId, record.channelId, "reply_part", record.messageId, result.revisionId);
      return false;
    }
    return true;
  }
}
