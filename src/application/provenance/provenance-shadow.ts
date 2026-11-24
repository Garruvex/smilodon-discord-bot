import type { ContextProvenance } from "../chat/context-provenance.js";
import type { MessageOriginRecord, MessageOriginStore } from "../chat/message-origin-store.js";
import { projectionKey, type ProvenanceCompleteness, type ProvenanceGraphStore, type ProvenanceInput, type ProvenanceParent } from "./provenance-graph.js";

export type ProvenanceShadowOutcome = "published" | "refused" | "skipped";

// Dual-writes the graph beside v1 proofs. v1 stays authoritative: nothing reads the graph for admission
// yet, and a graph failure never fails or repeats the v1 write it shadows.
export class ProvenanceShadowWriter {
  public constructor(private readonly graph: ProvenanceGraphStore) {}

  // One delivered reply part with a complete, durable v1 proof. Its parents are the inputs supplied this
  // turn: a person's message as a message revision, an earlier bot reply as that reply's own revision.
  // A message the proof lists only because an earlier artifact carried it needs no edge when that
  // artifact is itself a parent here. Anything else becomes a direct edge and the revision is marked
  // flattened, since its immediate parent is not known.
  public async recordReplyPart(record: MessageOriginRecord, inputs: readonly ProvenanceInput[]): Promise<ProvenanceShadowOutcome> {
    const proof = record.contextProvenance;
    if (record.origin !== "chat" || !proof || proof.coverage !== "complete" || proof.purpose && proof.purpose !== "reply" ||
        proof.audience.guildId !== record.guildId || proof.audience.channelId !== record.channelId) return "skipped";
    const byId = new Map(inputs.map((input) => [input.messageId, input]));
    const dependencies = proof.dependencies;
    const replies = await this.graph.currentMany(record.guildId, record.channelId, "reply_part",
      dependencies.filter((dependency) => byId.get(dependency.messageId)?.direct && byId.get(dependency.messageId)?.origin === "chat").map((dependency) => dependency.messageId));
    const parentReplies = new Set(replies.keys());
    let completeness: ProvenanceCompleteness = "complete";
    const viaReply: ContextProvenance["dependencies"][number][] = []; const asMessages: ContextProvenance["dependencies"][number][] = [];
    for (const dependency of dependencies) {
      const input = byId.get(dependency.messageId);
      if (input?.direct) {
        if (parentReplies.has(dependency.messageId)) viaReply.push(dependency);
        else { asMessages.push(dependency); if (input.origin === "chat") completeness = "flattened"; }
        continue;
      }
      if (input?.carriers.some((carrier) => carrier.startsWith("reply:") && parentReplies.has(carrier.slice("reply:".length)))) continue;
      asMessages.push(dependency); completeness = "flattened";
    }
    const messages = await this.graph.ensureMessages(record.guildId, record.channelId,
      asMessages.map(({ messageId, authorId, timestampMs }) => ({ messageId, authorId, timestampMs })), record.createdAt);
    // A revoked input means this reply is not reusable; v1 admission refuses it for the same reason.
    if (asMessages.some((dependency) => !messages.has(dependency.messageId))) return "refused";
    const edge = (revisionId: string, dependency: ContextProvenance["dependencies"][number]): ProvenanceParent => ({ revisionId,
      projection: projectionKey(dependency.projection), representationHash: dependency.representationHash, assetsHash: dependency.assetsHash ?? null });
    const result = await this.graph.publish({
      guildId: record.guildId, channelId: record.channelId, kind: "reply_part", artifactId: record.messageId, version: 1, completeness,
      purpose: "reply", audienceUserId: proof.audience.userId, outputHash: proof.outputHash, attachmentHash: proof.outputAssetsHash ?? null,
      lineage: { ...(proof.actors ? { actors: proof.actors } : {}), ...(proof.resources ? { resources: proof.resources } : {}),
        ...(proof.publicWeb ? { publicWeb: proof.publicWeb } : {}), ...(proof.publicTools ? { publicTools: proof.publicTools } : {}) },
      parents: [...viaReply.map((dependency) => edge(replies.get(dependency.messageId)!, dependency)),
        ...asMessages.map((dependency) => edge(messages.get(dependency.messageId)!, dependency))],
      publishedAt: record.createdAt,
    });
    return result.status;
  }
}

// An origin store that also writes the graph for durable reply records it is given inputs for. Session
// records never reach it: they go to the expiring in-memory store, so no durable edge outlives them.
export function withProvenanceShadow(store: MessageOriginStore, writer: ProvenanceShadowWriter,
  onFailure: (error: unknown) => void): MessageOriginStore {
  return {
    ...(store.invalidateContextSubject ? { invalidateContextSubject: (guildId: string, userId: string) => store.invalidateContextSubject!(guildId, userId) } : {}),
    ...(store.forgetCitingMessages ? { forgetCitingMessages: (input: { guildId: string; channelId: string; messageIds: readonly string[] }) => store.forgetCitingMessages!(input) } : {}),
    find: (guildId, channelId, messageId) => store.find(guildId, channelId, messageId),
    record: async (input, inputs): Promise<void> => {
      await store.record(input);
      if (!inputs) return;
      try { await writer.recordReplyPart(input, inputs); } catch (error) { onFailure(error); }
    },
  };
}
