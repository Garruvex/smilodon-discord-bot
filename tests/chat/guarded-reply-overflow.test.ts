import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { ConversationModelGateway } from "../../src/application/context/conversation-model-gateway.js";
import type { ChatProvider } from "../../src/application/chat/chat-provider.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("guarded reply overflow bounds", () => {
  it("limits deep ancestry and releases a stalled optional model without invalidating still-readable sources", async () => {
    const fixture = guardedFixture(guardedEvent("current", 4000, "follow up", "alice", { replyToMessageId: "m69" }));
    for (let index = 0; index < 70; index++) fixture.add(guardedEvent(`m${index}`, index + 100, `ancestor ${index}`, "alice", { replyToMessageId: index ? `m${index - 1}` : null }));
    const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [], collectOverflow: true });
    expect(context.replyChain).toHaveLength(20); expect(context.replyOverflow).toHaveLength(40);
    expect(context.report.replyBounded).toBe(true); expect(context.report.pages).toBe(0);
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), milliseconds); return controller.signal;
    });
    const summarizeReplyChainOverflow = vi.fn<NonNullable<ChatProvider["summarizeReplyChainOverflow"]>>((_hops, options) => {
      expect(options?.maxAttempts).toBe(1); return new Promise(() => {});
    });
    const gateway = new ConversationModelGateway({ reply: vi.fn(), summarizeReplyChainOverflow });
    const pending = gateway.compactReply(context); const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(4001); await assertion;
    expect(summarizeReplyChainOverflow).toHaveBeenCalledOnce(); expect(await context.validate()).toBe(true);
  });
});
