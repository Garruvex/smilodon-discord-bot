import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterRuntime, type CharacterCallbackDelivery } from "../../src/application/chat/character-runtime.js";
import { CharacterCallbacks, callbackState } from "../../src/application/chat/character-callbacks.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { memoryClaimPayload } from "../../src/application/memory/memory-claim-provenance.js";
import type { RepositoryIngestInput } from "../../src/application/memory/memory.js";
import type { ChatProvider, ChatResponse } from "../../src/application/chat/chat-provider.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";
import { decisionRequest, decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import { conversationConfiguration } from "../../src/application/context/conversation-configuration.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { guardedToolResourcePort } from "../../src/application/chat/guarded-tool-gateway.js";

const cleanups: (() => Promise<void>)[] = [];
const channelId = "500000000000000001";
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("scheduled callback source authorization", () => {
  it.each(["verified", "legacy", "revoked", "tampered", "changed_during_model", "configuration_changed"] as const)("checks persisted evidence before model attempts and sending: %s", async (scenario) => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-callback-")));
    let runtime: CharacterRuntime | null = null;
    cleanups.push(async () => { runtime?.stop(); await runtime?.drain(); connection.close(); });
    const repository = new SqliteMemoryRepository(connection.database);
    const document = freshDocument(); document.features.chatbot = true; document.features.channelHistory = true; document.channels.chatbot = [channelId];
    const profiles = memoryProvider(document);
    await profiles.update(guildId, { chatbotSharedMemoryEnabled: true, chatParticipation: { continuationEnabled: true },
      character: { enabled: true, modules: { callbacks: { enabled: true } } } });
    const fixture = guardedFixture(guardedEvent("current", 4000, "hello"), { guildId, channelId: channelId });
    fixture.add(guardedEvent("event", 1000, "my exam is on 2026-10-20"));
    let configurationCurrent = true;
    const configuration = await conversationConfiguration(guildId, "alice", await configurationFixture("Authored persona", "persona", () => configurationCurrent, guildId), null);
    const port = guardedToolResourcePort(fixture.port, null, { currentUser: fixture.actors.get("alice")!, channelMode: "shared", channelIsNsfw: false, isOwner: false }, undefined, configuration);
    const lease = await GuardedConversationContext.open(port, { count: 10, budget: 4000, burstIds: [] });
    expect(await lease.resource({ kind: "persona_configuration", id: "current" })).not.toBeNull();
    const input: RepositoryIngestInput = { guildId, kind: "fact", audience: "channel", ownerUserId: null, channelId, isolationChannelId: null,
      subjectType: "member", subjectId: "alice", topic: "schedule", slot: "exam", statement: "exam on 2026-10-20", status: "active", source: "live",
      importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 1000, sourceMessageId: "event", sourceChannelId: channelId,
      assertedByUserId: "alice", sourceQuote: "my exam is on 2026-10-20", sourceTimestampMs: 1000 };
    const memory = await repository.ingest({ ...input, contextProvenance: lease.provenance(memoryClaimPayload(input), "memory_claim") });
    const callbacks = new CharacterCallbacks(repository);
    const planned = await callbacks.plan(memory, 2000, channelId, scenario === "legacy" ? undefined : lease);
    expect(planned).not.toBeNull();
    if (scenario === "configuration_changed") configurationCurrent = false;
    if (scenario === "revoked") fixture.denied.add("event");
    if (scenario === "tampered") await repository.compareAndSetStructuredValue({ guildId, memoryId: planned!.id, updatedAt: planned!.updatedAt,
      expected: planned!.structuredValue, value: { callback: { ...callbackState(planned!)!, dueAt: 2500 } } });
    const generateCharacterData = vi.fn<NonNullable<ChatProvider["generateCharacterData"]>>().mockImplementation(async (_prompt, _schema, options) => {
      await options?.beforeAttempt?.();
      if (scenario === "changed_during_model") fixture.denied.add("event");
      return { text: "How did the exam go?" };
    });
    runtime = new CharacterRuntime(profiles, repository, { generateCharacterData }, { reply: (): Promise<ChatResponse> => Promise.resolve(decisionResponse()) }, undefined, null, () => 5000);
    runtime.bindProbeSchedule(() => Promise.resolve(decisionRequest({ guildId, channelId: channelId, channelHistory: [], currentBurst: [] })));
    const send = vi.fn<CharacterCallbackDelivery["send"]>(() => Promise.resolve("sent"));
    runtime.bindCallbackDelivery({ context: () => Promise.resolve(port), check: () => Promise.resolve(true),
      run: (_guild, _channel, operation) => operation(), send });
    runtime.observe(guildId, channelId, fixture.sources.get("current")!.event);
    await runtime.tickCallbacks(5000);
    expect(generateCharacterData).toHaveBeenCalledTimes(scenario === "verified" || scenario === "changed_during_model" ? 1 : 0);
    expect(send).toHaveBeenCalledTimes(scenario === "verified" ? 1 : 0);
    if (scenario === "verified") expect(send.mock.calls[0]?.[5]).toBeInstanceOf(GuardedConversationContext);
  });
});
