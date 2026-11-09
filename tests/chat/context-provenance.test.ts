import { describe, expect, it } from "vitest";
import { hashContent } from "../../src/application/assets/content-hash.js";
import { bindProvenanceOutput, captureIncompleteTurnProvenance, parseContextProvenance, parseScopedContextProvenance } from "../../src/application/chat/context-provenance.js";
import { chatSessionExchangesSchema } from "../../src/application/chat/chat-session-schema.js";
import { boundSessionExchanges } from "../../src/application/chat/chat-state-store.js";
import { RecentPromptHistorySelector } from "../../src/application/chat/prompt-history-selector.js";
import { decisionRequest } from "../helpers/conversation-decision-fixtures.js";

function request(): ReturnType<typeof decisionRequest> {
  return decisionRequest({ interaction: "direct_mention", message: "SECRET_CURRENT_TEXT", currentBurst: [],
    currentEvent: { type: "message", messageId: "current", channelId: "channel", timestampMs: 3000, authorId: "alice", replyToMessageId: null, mentionedUserIds: [] },
    channelHistory: [{ messageId: "prior", channelId: "channel", authorId: "bob", authorDisplayName: "SECRET_NAME", content: "SECRET_HISTORY_TEXT", timestampMs: 1000, imageCount: 0 }] });
}

describe("context dependency provenance", () => {
  it("records content-free scoped dependencies without certifying unguarded inputs", () => {
    const provenance = captureIncompleteTurnProvenance(request(), "SECRET_ANSWER")!;
    expect(provenance.coverage).toBe("partial"); expect(provenance.unresolved).toContain("unguarded_prompt_sources");
    expect(provenance.audience).toEqual({ guildId: "guild", channelId: "channel", userId: "alice" });
    expect(provenance.dependencies.map((source) => source.messageId)).toEqual(["prior", "current"]);
    expect(provenance.outputHash).toBe(hashContent("SECRET_ANSWER"));
    expect(JSON.stringify(provenance)).not.toContain("SECRET");
    expect(parseContextProvenance({ ...provenance, coverage: "complete" })).toBeNull();
  });

  it("deduplicates identical references but records conflicting observations and missing source scope", () => {
    const turn = request(); const prior = turn.channelHistory[0]!;
    const same = captureIncompleteTurnProvenance({ ...turn, replyChain: [prior] }, "answer")!;
    expect(same.dependencies).toHaveLength(2); expect(same.unresolved).not.toContain("conflicting_source");
    const conflict = captureIncompleteTurnProvenance({ ...turn, replyChain: [{ ...prior, content: "changed" }] }, "answer")!;
    expect(conflict.unresolved).toContain("conflicting_source");
    const unscoped = { ...prior }; delete unscoped.channelId;
    const missing = captureIncompleteTurnProvenance({ ...turn, channelHistory: [unscoped] }, "answer")!;
    expect(missing.unresolved).toContain("missing_source_scope");
  });

  it("reports a dependency cap instead of silently claiming complete capture", () => {
    const turn = request(); const prior = turn.channelHistory[0]!;
    const result = captureIncompleteTurnProvenance({ ...turn, channelHistory: Array.from({ length: 200 }, (_, index) => ({ ...prior, messageId: `m${index}` })) }, "answer")!;
    expect(result.dependencies).toHaveLength(128); expect(result.unresolved).toContain("dependency_cap");
    expect(result.coverage).toBe("partial");
  });

  it("rejects malformed, oversized, duplicate, and prompt-bearing metadata", () => {
    const proof = captureIncompleteTurnProvenance(request(), "answer")!;
    expect(parseContextProvenance({ ...proof, version: 2 })).toBeNull();
    expect(parseContextProvenance({ ...proof, rawPrompt: "SECRET" })).toBeNull();
    expect(parseContextProvenance({ ...proof, dependencies: [...proof.dependencies, proof.dependencies[0]] })).toBeNull();
    expect(parseContextProvenance({ ...proof, extra: "x".repeat(50_000) })).toBeNull();
    expect(parseContextProvenance({ ...proof, outputHash: "not-a-hash" })).toBeNull();
    expect(parseContextProvenance(null)).toBeNull();
  });

  it("binds actual output without widening audience or rewriting a complete proof", () => {
    const proof = captureIncompleteTurnProvenance(request(), "answer")!;
    expect(bindProvenanceOutput(proof, "part one", { guildId: "guild", channelId: "channel", userId: "alice" })?.outputHash).toBe(hashContent("part one"));
    expect(bindProvenanceOutput(proof, "part", { guildId: "guild", channelId: "other" })).toBeNull();
    expect(parseScopedContextProvenance(proof, { guildId: "guild", channelId: "channel", userId: "bob" })).toBeNull();
    const futureProof = { ...proof, coverage: "complete", unresolved: [] };
    expect(bindProvenanceOutput(futureProof, "changed", { guildId: "guild", channelId: "channel", userId: "alice" })).toBeNull();
    expect(bindProvenanceOutput(futureProof, "answer", { guildId: "guild", channelId: "channel", userId: "alice" })?.coverage).toBe("complete");
  });

  it("loads legacy sessions, normalizes invalid proofs, and preserves valid dependency metadata", () => {
    const legacy = { user: { content: "hi", createdAt: 1 }, assistant: { content: "hello", createdAt: 2 } };
    const proof = captureIncompleteTurnProvenance(request(), "hello")!;
    expect(chatSessionExchangesSchema.parse([legacy])).toEqual([legacy]);
    expect(chatSessionExchangesSchema.parse([{ ...legacy, contextProvenance: { filtered: true } }])[0]?.contextProvenance).toBeNull();
    expect(chatSessionExchangesSchema.parse([{ ...legacy, contextProvenance: proof }])[0]?.contextProvenance).toEqual(proof);
  });

  it("keeps dependency metadata out of transcript budgets and model-visible history", () => {
    const proof = captureIncompleteTurnProvenance(request(), "hello")!;
    const big = { ...proof, dependencies: Array.from({ length: 100 }, (_, index) => ({ ...proof.dependencies[0]!, messageId: `m${index}` })) };
    const exchanges = Array.from({ length: 8 }, (_, index) => ({ user: { content: "hi", createdAt: index },
      assistant: { content: "hello", createdAt: index, messageIds: ["delivered"] }, contextProvenance: big }));
    expect(boundSessionExchanges(exchanges).kept).toHaveLength(8);
    const history = new RecentPromptHistorySelector().select(exchanges);
    expect(history).toHaveLength(8);
    expect(JSON.stringify(history)).not.toContain("dependencies"); expect(JSON.stringify(history)).not.toContain("representationHash");
  });
});
