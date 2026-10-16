import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProactiveChatBehavior } from "../../src/infrastructure/discord/behaviors/proactive-chat-behavior.js";
import type { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";
import type { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import type { AmbientChatBehavior } from "../../src/infrastructure/discord/behaviors/ambient-chat-behavior.js";
import { freshDocument, memoryProvider, guildId } from "../helpers/settings-fixtures.js";
import type { Logger } from "pino";

const channelId = "500000000000000001";
function message(id: string, content: string, authorId = "human"): Message {
  return { id, content, guildId, channelId, createdTimestamp: Date.now(), author: { id: authorId, bot: false, displayName: authorId },
    inGuild: () => true, mentions: { users: { has: () => false } } } as unknown as Message;
}
function setup(messagesPerDecision = 5): { behavior: ProactiveChatBehavior; profiles: ReturnType<typeof memoryProvider>; opportunities: (() => void)[]; execute: ReturnType<typeof vi.fn>; setContinuation: (active: boolean) => void; setEvaluationDelay: (ms: number) => void; check: ReturnType<typeof vi.fn> } {
  const document = freshDocument(); document.features.channelHistory = true; document.features.chatbot = true;
  document.chat.participation.spontaneousEnabled = true; document.chat.participation.messagesPerDecision = messagesPerDecision;
  document.chat.participation.continuationEnabled = true; document.chat.participation.spontaneousChannelIds = [channelId];
  const profiles = memoryProvider(document); const opportunities: (() => void)[] = [];
  let continuation = false; let evaluationDelay = 0;
  const conversation = { optionalDecisionAvailable: true, optionalOpportunityVersion: (): number => 1, isImplicitlyAddressed: (): boolean => continuation,
    optionalEvaluationDelayMs: (): number => evaluationDelay,
    bufferOpportunity: (_guild: string, _channel: string, work: () => void) => { opportunities.push(work); } } as unknown as ChatConversationService;
  const execute = vi.fn(() => Promise.resolve());
  const check = vi.fn(() => Promise.resolve({ eligible: true }));
  const behavior = new ProactiveChatBehavior(() => "bot", profiles, conversation,
    { check } as unknown as SocialChatEligibility,
    { execute } as unknown as AmbientChatBehavior, { warn: vi.fn() } as unknown as Logger);
  return { behavior, profiles, opportunities, execute, setContinuation: (active): void => { continuation = active; },
    setEvaluationDelay: (ms): void => { evaluationDelay = ms; }, check };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function evaluate(opportunities: (() => void)[]): Promise<void> {
  opportunities.at(-1)!(); await vi.advanceTimersByTimeAsync(0);
}

describe("spontaneous opportunities", () => {
  it("evaluates five short fragments once", async () => {
    const { behavior, opportunities, execute } = setup();
    for (let i = 1; i <= 5; i++) await behavior.execute(message(String(i), "short fragment"));
    expect(opportunities).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0); await evaluate(opportunities);
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "5" }), "spontaneous",
      Array.from({ length: 5 }, (_, i): unknown => expect.objectContaining({ id: String(i + 1) })));
  });
  it("uses a pause after three conversational turns", async () => {
    const { behavior, opportunities, execute } = setup();
    await behavior.execute(message("one", "What happened?", "alice"));
    await behavior.execute(message("two", "I don't know", "bob"));
    await behavior.execute(message("three", "Maybe tomorrow", "alice"));
    await vi.advanceTimersByTimeAsync(4_999); expect(opportunities).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); await evaluate(opportunities);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("lets one substantive post create a quiet-channel opportunity", async () => {
    const { behavior, opportunities, execute } = setup();
    await behavior.execute(message("news", "The show got cancelled today and everyone is disappointed."));
    await vi.advanceTimersByTimeAsync(11_999); expect(opportunities).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); await evaluate(opportunities);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: "news" }), "spontaneous", [expect.objectContaining({ id: "news" })]);
  });
  it("counts new messages immediately after a silent evaluation", async () => {
    const { behavior, opportunities, execute } = setup();
    for (let i = 1; i <= 5; i++) await behavior.execute(message(String(i), "first batch"));
    await vi.advanceTimersByTimeAsync(0); await evaluate(opportunities);
    for (let i = 6; i <= 10; i++) await behavior.execute(message(String(i), "next batch"));
    await vi.advanceTimersByTimeAsync(0); await evaluate(opportunities);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ id: "10" }), "spontaneous",
      Array.from({ length: 5 }, (_, i): unknown => expect.objectContaining({ id: String(i + 6) })));
  });
  it("retains messages received during the evaluation interval", async () => {
    const { behavior, opportunities, execute, setEvaluationDelay } = setup();
    for (let i = 1; i <= 5; i++) await behavior.execute(message(String(i), "first batch"));
    await vi.advanceTimersByTimeAsync(0); await evaluate(opportunities);
    setEvaluationDelay(25_000);
    for (let i = 6; i <= 10; i++) await behavior.execute(message(String(i), "second batch"));
    await vi.advanceTimersByTimeAsync(24_999); expect(opportunities).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await evaluate(opportunities);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ id: "10" }), "spontaneous",
      Array.from({ length: 5 }, (_, i): unknown => expect.objectContaining({ id: String(i + 6) })));
  });
  it("does not repeat an unchanged opportunity", async () => {
    const { behavior, opportunities, execute } = setup(1);
    await behavior.execute(message("one", "Hello")); await vi.advanceTimersByTimeAsync(0); await evaluate(opportunities);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(opportunities).toHaveLength(1); expect(execute).toHaveBeenCalledOnce();
  });
  it("keeps continuation independent of spontaneous batching", async () => {
    const { behavior, opportunities, execute, setContinuation } = setup();
    await behavior.execute(message("one", "short fragment")); setContinuation(true);
    const followup = message("followup", "why?"); await behavior.execute(followup);
    await evaluate(opportunities);
    expect(execute).toHaveBeenCalledExactlyOnceWith(followup, "continuation", [followup]);
  });
  it("invalidates a scheduled decision when settings or eligibility change", async () => {
    const { behavior, profiles, opportunities, execute, check } = setup(1);
    await behavior.execute(message("one", "hello")); await vi.advanceTimersByTimeAsync(0);
    await profiles.update(guildId, { channelHistory: false }); await evaluate(opportunities);
    expect(execute).not.toHaveBeenCalled();
    await profiles.update(guildId, { channelHistory: true });
    await behavior.execute(message("two", "hello")); await vi.advanceTimersByTimeAsync(0);
    check.mockResolvedValue({ eligible: false }); await evaluate(opportunities);
    expect(execute).not.toHaveBeenCalled();
  });
  it("excludes mentions and replies to the bot", async () => {
    const { behavior } = setup();
    const mention = message("mention", "hello"); Object.assign(mention.mentions.users, { has: () => true });
    expect(await behavior.matches(mention)).toBe(false);
    const reply = message("reply", "answer this"); Object.assign(reply.mentions, { repliedUser: { id: "bot" } });
    expect(await behavior.matches(reply)).toBe(false);
  });
});
