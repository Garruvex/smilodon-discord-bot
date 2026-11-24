import type { ContextProvenance } from "../chat/context-provenance.js";
import type { MessageOriginRecord, MessageOriginStore } from "../chat/message-origin-store.js";
import { projectionKey, type ProvenanceCompleteness, type ProvenanceGraphStore, type ProvenanceInput, type ProvenanceParent, type ProvenanceRevisionKind } from "./provenance-graph.js";

export type ProvenanceShadowOutcome = "published" | "refused" | "skipped";

// Records one artifact in the graph; character state uses it with its own kind and artifact ID.
export type ProvenanceArtifactShadow = (artifact: Parameters<ProvenanceShadowWriter["recordArtifact"]>[0]) => Promise<ProvenanceShadowOutcome>;

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
    // A part is delivered once; a second record of it changes nothing.
    const result = await this.publish({ kind: "reply_part", artifactId: record.messageId, proof, inputs, at: record.createdAt, version: () => Promise.resolve(1) });
    return result === "stale" ? "skipped" : result;
  }

  // Any other artifact built from a complete v1 proof: a claim, an alias nested in a claim, a relation,
  // character state. Each output gets the next version of its artifact, bound to the proof's output hash.
  // inputs "background": a summary or extraction job read every listed message itself.
  public async recordArtifact(artifact: { kind: Exclude<ProvenanceRevisionKind, "message" | "reply_part">; artifactId: string; proof: ContextProvenance;
    inputs: readonly ProvenanceInput[] | "background"; at: number }): Promise<ProvenanceShadowOutcome> {
    const { proof } = artifact;
    if (proof.coverage !== "complete") return "skipped";
    const inputs = artifact.inputs === "background"
      ? proof.dependencies.map((dependency) => ({ messageId: dependency.messageId, origin: "human" as const, direct: true, carriers: [] }))
      : artifact.inputs;
    const next = async (): Promise<number> => ((await this.graph.current(proof.audience.guildId, proof.audience.channelId, artifact.kind, artifact.artifactId))?.version ?? 0) + 1;
    const first = await this.publish({ ...artifact, inputs, version: next });
    // Two writers of one artifact can pick the same next version; the later one asks again once.
    return first === "stale" ? await this.publish({ ...artifact, inputs, version: next }).then((outcome) => outcome === "stale" ? "refused" : outcome) : first;
  }

  private async publish(artifact: { kind: ProvenanceRevisionKind; artifactId: string; proof: ContextProvenance; inputs: readonly ProvenanceInput[]; at: number;
    version: () => Promise<number> }): Promise<ProvenanceShadowOutcome | "stale"> {
    const { proof } = artifact; const guildId = proof.audience.guildId; const channelId = proof.audience.channelId;
    const byId = new Map(artifact.inputs.map((input) => [input.messageId, input]));
    const dependencies = proof.dependencies;
    if (dependencies.some((dependency) => dependency.guildId !== guildId || dependency.channelId !== channelId)) return "skipped";
    const replies = await this.graph.currentMany(guildId, channelId, "reply_part",
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
    const messages = await this.graph.ensureMessages(guildId, channelId,
      asMessages.map(({ messageId, authorId, timestampMs }) => ({ messageId, authorId, timestampMs })), artifact.at);
    // A revoked input means this artifact is not reusable; v1 admission refuses it for the same reason.
    if (asMessages.some((dependency) => !messages.has(dependency.messageId))) return "refused";
    const edge = (revisionId: string, dependency: ContextProvenance["dependencies"][number]): ProvenanceParent => ({ revisionId,
      projection: projectionKey(dependency.projection), representationHash: dependency.representationHash, assetsHash: dependency.assetsHash ?? null });
    const result = await this.graph.publish({
      guildId, channelId, kind: artifact.kind, artifactId: artifact.artifactId, version: await artifact.version(), completeness,
      purpose: proof.purpose ?? "reply", audienceUserId: proof.audience.userId, outputHash: proof.outputHash, attachmentHash: proof.outputAssetsHash ?? null,
      lineage: { ...(proof.actors ? { actors: proof.actors } : {}), ...(proof.resources ? { resources: proof.resources } : {}),
        ...(proof.publicWeb ? { publicWeb: proof.publicWeb } : {}), ...(proof.publicTools ? { publicTools: proof.publicTools } : {}) },
      parents: [...viaReply.map((dependency) => edge(replies.get(dependency.messageId)!, dependency)),
        ...asMessages.map((dependency) => edge(messages.get(dependency.messageId)!, dependency))],
      publishedAt: artifact.at,
    });
    if (result.status === "published") return "published";
    return result.reason === "stale_version" || result.reason === "duplicate_version" ? "stale" : "refused";
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
