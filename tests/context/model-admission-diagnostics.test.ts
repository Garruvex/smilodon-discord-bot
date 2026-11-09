import { describe, expect, it, vi } from "vitest";
import { guardModelTransport } from "../../src/application/context/guarded-model-transport.js";
import { guardEmbeddingTransport } from "../../src/application/context/guarded-embedding-transport.js";
import { approveModelOperation } from "../../src/application/context/approved-model-operation.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { instrumentModel, modelGenerationHealth } from "../../src/application/diagnostics/model-diagnostics.js";
import { withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";
import { decisionRequest, decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import type { ChatRequest, StructuredCallOptions } from "../../src/application/chat/chat-provider.js";

describe("content-free model admission diagnostics", () => {
  it("records blocked approval without a provider attempt or generation-health failure", async () => {
    const { logger, records } = captureDiagnosticLogger(); const reply = vi.fn((_request: ChatRequest) => Promise.resolve(decisionResponse()));
    const provider = guardModelTransport(instrumentModel({ reply }, logger), logger);
    await withDiagnosticScope({ operation: "chat_turn", guildId: "guild", channelId: "channel", sourceMessageId: "current" }, async () => {
      await expect(provider.reply(decisionRequest({ message: "PRIVATE_PROMPT_SENTINEL" }))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    });
    expect(reply).not.toHaveBeenCalled(); expect(modelGenerationHealth(logger)).toMatchObject({ completed: 0, failed: 0 });
    const event = records.find((record) => record.event === "model.gateway.rejected");
    expect(event).toMatchObject({ purpose: "reply", phase: "approval", guildId: "guild", channelId: "channel", sourceMessageId: "current" });
    expect(event?.traceId).toEqual(expect.any(String)); expect(records.some((record) => record.event === "model.operation.completed")).toBe(false);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_PROMPT_SENTINEL");
  });
  it("records source failure on an actual utility retry without logging arguments or errors", async () => {
    const { logger, records } = captureDiagnosticLogger(); const source = guardedFixture();
    const context = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
    const network = vi.fn(); const provider = guardModelTransport(instrumentModel({ generateCharacterData: async (_prompt: string, _schema: Record<string, unknown>, options?: StructuredCallOptions): Promise<unknown> => {
      source.setPolicy(false); await options?.beforeAttempt?.(); network(); return {};
    } }, logger), logger);
    await expect(provider.generateCharacterData("PRIVATE_PROMPT_SENTINEL", {}, approveModelOperation(context, "generateCharacterData", ["PRIVATE_PROMPT_SENTINEL", {}])))
      .rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(network).not.toHaveBeenCalled(); expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: "model.gateway.rejected", purpose: "generateCharacterData", phase: "source" })]));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_PROMPT_SENTINEL");
  });
  it("labels an unapproved embedding separately from model/network completion", async () => {
    const { logger, records } = captureDiagnosticLogger(); const embed = vi.fn((_text: string) => Promise.resolve([1]));
    const provider = guardEmbeddingTransport(instrumentModel({ modelId: "fixture", embed }, logger), logger);
    await expect(provider.embed("PRIVATE_EMBEDDING_SENTINEL")).rejects.toBeInstanceOf(SocialOutputSuppressed); expect(embed).not.toHaveBeenCalled();
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: "model.gateway.rejected", purpose: "embed", phase: "approval" })]));
    expect(records.some((record) => record.event === "model.operation.completed")).toBe(false); expect(JSON.stringify(records)).not.toContain("PRIVATE_EMBEDDING_SENTINEL");
  });
});
