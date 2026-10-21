import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuardedPostTurn } from "../../src/application/chat/guarded-post-turn.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import type { GuardedChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatProvider } from "../../src/application/chat/chat-provider.js";
import type { ChatSessionExchange } from "../../src/application/chat/chat-state-store.js";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";
import { personaDriftPayload } from "../../src/application/chat/persona-drift-provenance.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { decisionRequest } from "../helpers/conversation-decision-fixtures.js";
import { conversationConfiguration } from "../../src/application/context/conversation-configuration.js";
import { guardedToolResourcePort } from "../../src/application/chat/guarded-tool-gateway.js";
import { ConversationModelGateway } from "../../src/application/context/conversation-model-gateway.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function sources(): Promise<{ fixture: ReturnType<typeof guardedFixture>; exchange: ChatSessionExchange; input: GuardedChatConversationInput }> {
  const fixture = guardedFixture(guardedEvent("original", 1000, "I like green apples"));
  fixture.port.shareMemory = true;
  const original = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [] });
  const proof = original.provenance("Understood")!;
  fixture.sources.set("delivered", { event: guardedEvent("delivered", 2000, "Understood", "bot"), origin: "chat", provenance: proof });
  const exchange: ChatSessionExchange = { user: { content: "I like green apples", createdAt: 1000, sourceMessageId: "original", channelMemoryMode: "shared" },
    assistant: { content: "Understood", createdAt: 2000, messageIds: ["delivered"] }, contextProvenance: proof };
  fixture.add(guardedEvent("current", 3000, "I like pears")); fixture.port.sourceMessageId = "current";
  const input: GuardedChatConversationInput = { ...decisionRequest({ triggerMode: "direct", message: "UNTRUSTED_INPUT" }),
    sourceMessageId: "current", guardedContextPort: fixture.port, examplePool: [], loreChunks: [], personaDriftEnabled: true,
    turnPlan: { state: "ready", flow: "legacy", context: "guarded_text", decision: "legacy", deadlineMs: 30000, contextPolicy: { count: 0, budget: 0 } } };
  return { fixture, exchange, input };
}

describe("guarded post-delivery processing", () => {
  it.each(["verified", "legacy_session", "revoked_session", "changed_during_drift", "sharing_disabled", "persistence_disabled"] as const)("authorizes sessions, extraction and scoped drift before external processing: %s", async (scenario) => {
    const { fixture, exchange, input } = await sources();
    if (scenario === "legacy_session") exchange.contextProvenance = null;
    if (scenario === "revoked_session") fixture.denied.add("original");
    if (scenario === "sharing_disabled") fixture.port.shareMemory = false;
    if (scenario === "persistence_disabled") fixture.port.persist = false;
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-post-"))); cleanup.push(() => connection.close());
    const repository = new SqliteMemoryRepository(connection.database);
    const memory = new DefaultMemoryEngine(repository, null, null, undefined, null, null, null, () => scenario !== "sharing_disabled");
    const drift = new PersonaDriftStore(mkdtempSync(join(tmpdir(), "guarded-drift-")));
    const extractPersonalMemories = vi.fn<NonNullable<ChatProvider["extractPersonalMemories"]>>((human, assistant) => {
      expect(human).toBe("I like pears"); expect(assistant).toBe("");
      return Promise.resolve([
        { action: "upsert", aboutSpeaker: true, topic: "preference", slot: "food.pear", statement: "likes pears", sourceQuote: "I like pears", importance: "low" },
        { action: "upsert", aboutSpeaker: false, topic: "preference", slot: "food.other", statement: "HIDDEN_THIRD_PARTY", sourceQuote: "I like pears", importance: "low" },
      ]);
    });
    const summarizeDroppedExchanges = vi.fn<NonNullable<ChatProvider["summarizeDroppedExchanges"]>>((pairs) => {
      expect(pairs).toEqual([{ user: "I like green apples", assistant: "Understood" }]);
      return Promise.resolve([{ subjectType: "member", slot: "food.fruit", statement: "likes green apples", sourceQuote: "I like green apples" }]);
    });
    const evolvePersonaDrift = vi.fn<NonNullable<ChatProvider["evolvePersonaDrift"]>>((current) => {
      expect(current).toBe("");
      if (scenario === "changed_during_drift") fixture.denied.add("original");
      return Promise.resolve("SOURCE_BACKED_DRIFT");
    });
    await runGuardedPostTurn(input, [exchange], { provider: { reply: vi.fn(), extractPersonalMemories, summarizeDroppedExchanges, evolvePersonaDrift }, utility: null,
      memory, customization: null, tools: null, drift, logger: null, now: () => 4000, mutate: (operation) => operation() });
    expect(extractPersonalMemories).toHaveBeenCalledTimes(scenario === "persistence_disabled" ? 0 : 1);
    const eligible = scenario === "verified" || scenario === "changed_during_drift";
    expect(summarizeDroppedExchanges).toHaveBeenCalledTimes(eligible || scenario === "sharing_disabled" ? 1 : 0);
    expect(evolvePersonaDrift).toHaveBeenCalledTimes(eligible ? 1 : 0);
    const stored = await drift.getScoped("guild", "channel");
    expect(stored?.text ?? null).toBe(scenario === "verified" ? "SOURCE_BACKED_DRIFT" : null);
    expect(await drift.getScoped("guild", "other")).toBeNull();
    const configuration = await conversationConfiguration("guild", "alice", undefined, null);
    const resourcePort = guardedToolResourcePort(fixture.port, null, { currentUser: input.currentUser, channelMode: "shared", channelIsNsfw: false, isOwner: false }, undefined, configuration, drift);
    const context = await GuardedConversationContext.open(resourcePort, { count: 0, budget: 0, burstIds: [] });
    const recalled = await memory.recall({ guildId: "guild", channelId: "channel", userId: "alice", message: "fruit pears apples", recentHistory: [], subjectIds: ["alice"], now: 4000, context });
    expect(JSON.stringify(recalled)).not.toContain("HIDDEN_THIRD_PARTY");
    expect(recalled.memories.some((row) => row.statement === "likes pears")).toBe(scenario !== "sharing_disabled" && scenario !== "persistence_disabled");
    if (stored) {
      expect(await context.derived(stored.contextProvenance, personaDriftPayload(stored), "character_state")).toBe(true);
      const next = await GuardedConversationContext.open(resourcePort, { count: 0, budget: 0, burstIds: [] });
      await drift.evolveScoped(next, new ConversationModelGateway({ reply: vi.fn(), evolvePersonaDrift: (current): Promise<string> => {
        expect(current).toBe("SOURCE_BACKED_DRIFT"); return Promise.resolve("UPDATED_DRIFT");
      } }), [exchange], stored.personalitySourceHash, 5000);
      const updated = await drift.getScoped("guild", "channel"); expect(updated?.text).toBe("UPDATED_DRIFT");
      expect(await context.validate()).toBe(true);
      await drift.reset("guild"); expect(await drift.getScoped("guild", "channel")).toBeNull();
      expect(await context.validate()).toBe(false);
    }
  });
});
