import { describe, expect, it, vi } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { approveConversationRequest, repairConversationRequest } from "../../src/application/context/approved-conversation-request.js";
import { approveAttributionOperation } from "../../src/application/context/approved-model-operation.js";
import { guardModelTransport } from "../../src/application/context/guarded-model-transport.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { decisionRequest, decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import type { ChatRequest } from "../../src/application/chat/chat-provider.js";

async function fixture(): Promise<{ source: ReturnType<typeof guardedFixture>; request: ChatRequest }> {
  const source = guardedFixture();
  const contextLease = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
  const configurationContext = await configurationFixture("Persona", "persona", () => true, "guild");
  const request = approveConversationRequest(decisionRequest({ contextLease, configurationContext, personality: "Persona", channelHistory: [] }));
  return { source, request };
}
describe("mandatory reply and attribution transport", () => {
  it.each(["raw", "copy"])("rejects %s reply requests at root dispatch despite valid source handles", async (kind) => {
    const { request } = await fixture(); const reply = vi.fn((_request: ChatRequest) => Promise.resolve(decisionResponse()));
    const transport = guardModelTransport({ reply });
    await expect(transport.reply(kind === "raw" ? decisionRequest({ contextLease: request.contextLease!, configurationContext: request.configurationContext! }) : { ...request }))
      .rejects.toBeInstanceOf(SocialOutputSuppressed); expect(reply).not.toHaveBeenCalled();
  });
  it("accepts registered replies and text-only repairs", async () => {
    const { request } = await fixture(); const reply = vi.fn((_request: ChatRequest) => Promise.resolve(decisionResponse()));
    const transport = guardModelTransport({ reply });
    await transport.reply(request); await transport.reply(repairConversationRequest(request, "draft", "repair"));
    expect(reply).toHaveBeenCalledTimes(2); expect(reply.mock.calls[1]![0]).toMatchObject({ attributionRepair: { draft: "draft", notes: "repair" }, enabledTools: [], webSearchMode: "off" });
  });
  it("does not expose a reply if its source changes during generation", async () => {
    const { request, source } = await fixture();
    const transport = guardModelTransport({ reply: (_request: ChatRequest) => { source.setPolicy(false); return Promise.resolve(decisionResponse()); } });
    await expect(transport.reply(request)).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
  it.each(["callback", "payload", "replay"])("rejects %s attribution authority before dispatch", async (kind) => {
    const { request } = await fixture();
    const verifyAttribution = vi.fn((_draft: string, _context: readonly unknown[], _message: string, _check?: () => Promise<void>) => Promise.resolve({ needsCorrection: false, correctionNotes: null }));
    const transport = guardModelTransport({ verifyAttribution }); const context = [{ authorId: "alice", authorDisplayName: "Alice", content: "admitted" }];
    const check = approveAttributionOperation(request.contextLease!, ["draft", context, "current"], request.beforeModelAttempt!);
    if (kind === "replay") await transport.verifyAttribution("draft", context, "current", check); verifyAttribution.mockClear();
    await expect(transport.verifyAttribution(kind === "payload" ? "hidden append" : "draft", context, "current", kind === "callback" ? request.beforeModelAttempt : check))
      .rejects.toBeInstanceOf(SocialOutputSuppressed); expect(verifyAttribution).not.toHaveBeenCalled();
  });
});
