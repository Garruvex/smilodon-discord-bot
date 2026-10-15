import type { Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProactiveChatBehavior } from "../../src/infrastructure/discord/behaviors/proactive-chat-behavior.js";
import type { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";
import type { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import type { AmbientChatBehavior } from "../../src/infrastructure/discord/behaviors/ambient-chat-behavior.js";
import { freshDocument, memoryProvider, guildId } from "../helpers/settings-fixtures.js";
import type { Logger } from "pino";

const channelId = "500000000000000001";
function message(id: string, content: string): Message {
  return { id, content, guildId, channelId, createdTimestamp: Date.now(), author: { id: "human", bot: false, displayName: "Human" },
    inGuild: () => true, mentions: { users: { has: () => false } } } as unknown as Message;
}
function setup(recent = false, implicitlyAddressed = false, messagesPerDecision = 1): { behavior: ProactiveChatBehavior; profiles: ReturnType<typeof memoryProvider>; opportunities: (() => void)[]; execute: ReturnType<typeof vi.fn>; reset: () => void; setContinuation: (active: boolean) => void; check: ReturnType<typeof vi.fn> } {
  const document = freshDocument(); document.features.channelHistory = true; document.features.chatbot = true;
  document.chat.participation.spontaneousEnabled = true; document.chat.participation.messagesPerDecision = messagesPerDecision;
  document.chat.participation.continuationEnabled = true;
  document.chat.participation.spontaneousChannelIds = [channelId];
  const profiles = memoryProvider(document); const opportunities: (() => void)[] = [];
  let version = 1; let continuation = implicitlyAddressed;
  const setContinuation = (active: boolean): void => { continuation = active; };
  const reset = (): void => { version++; };
  const conversation = { optionalDecisionAvailable: true, optionalOpportunityVersion: () => version, hasRecentConversation: () => recent, isImplicitlyAddressed: () => continuation,
    bufferOpportunity: (_guild: string, _channel: string, work: () => void) => { opportunities.push(work); } } as unknown as ChatConversationService;
  const execute = vi.fn(() => Promise.resolve());
  const check = vi.fn(() => Promise.resolve({ eligible: true }));
  const behavior = new ProactiveChatBehavior(() => "bot", profiles, conversation,
    { check } as unknown as SocialChatEligibility,
    { execute } as unknown as AmbientChatBehavior, { warn: vi.fn() } as unknown as Logger);
  return { behavior, profiles, opportunities, execute, reset, setContinuation, check };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("optional conversation bursts", () => {
  it("does not admit every phrase just because the bot recently replied to its author", async () => {
    expect(await setup(true, false).behavior.matches(message("unrelated", "嗯"))).toBe(false);
    expect(await setup(true, true).behavior.matches(message("followup", "嗯"))).toBe(true);
  });
  it("passes all fragments to one opportunity while keeping the last message as trigger", async () => {
    const { behavior, opportunities, execute } = setup();
    const first = message("first", "did anyone finish the event?"); const last = message("last", "lol");
    expect(await behavior.matches(first)).toBe(true); await behavior.execute(first);
    expect(await behavior.matches(last)).toBe(true); await behavior.execute(last);
    opportunities.at(-1)!();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledExactlyOnceWith(last, "spontaneous", [first, last]));
  });
  it("does not request a decision below the configured minimum, then starts a fresh batch", async () => {
    const { behavior, opportunities, execute } = setup(false, false, 3);
    for (const id of ["one", "two"]) { const event = message(id, "短句"); expect(await behavior.matches(event)).toBe(true); await behavior.execute(event); }
    expect(opportunities).toHaveLength(0); expect(execute).not.toHaveBeenCalled();
    const third = message("three", "另一句"); await behavior.execute(third); expect(opportunities).toHaveLength(1);
    opportunities.at(-1)!(); await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(third, "spontaneous", [expect.objectContaining({ id: "one" }), expect.objectContaining({ id: "two" }), third]);
    await behavior.execute(message("four", "短句")); await behavior.execute(message("five", "短句"));
    expect(opportunities).toHaveLength(1); expect(execute).toHaveBeenCalledOnce();
  });
  it("counts unique human messages separately for each channel", async () => {
    const { behavior, opportunities, execute } = setup(false, false, 2);
    const first = message("one", "短句"); await behavior.execute(first); await behavior.execute(first);
    const other = message("other", "短句"); Object.assign(other, { channelId: "other-channel" }); await behavior.execute(other);
    const bot = message("bot", "bots must not contribute to the count"); Object.assign(bot.author, { bot: true }); expect(await behavior.matches(bot)).toBe(false);
    expect(opportunities).toHaveLength(0);
    await behavior.execute(message("two", "短句")); opportunities.at(-1)!();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: "two" }), "spontaneous", [first, expect.objectContaining({ id: "two" })]);
  });
  it("retains a quiet conversation's count across gaps longer than two minutes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { behavior, opportunities, execute } = setup(false, false, 5);
    for (let i = 1; i <= 5; i++) {
      await behavior.execute(message(String(i), "short fragment"));
      expect(opportunities).toHaveLength(i === 5 ? 1 : 0);
      if (i < 5) await vi.advanceTimersByTimeAsync(180000);
    }
    opportunities.at(-1)!(); await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "5" }), "spontaneous",
      Array.from({ length: 5 }, (_, i): unknown => expect.objectContaining({ id: String(i + 1) })));
  });
  it("waits two minutes after spontaneous evaluation before counting a new batch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { behavior, opportunities, execute } = setup(false, false, 5);
    for (let i = 1; i <= 5; i++) await behavior.execute(message(String(i), "short fragment"));
    opportunities.at(-1)!(); await vi.advanceTimersByTimeAsync(0); expect(execute).toHaveBeenCalledOnce();
    for (let i = 6; i <= 15; i++) {
      const incoming = message(String(i), "cooldown chatter");
      expect(await behavior.matches(incoming)).toBe(false); await behavior.execute(incoming);
    }
    await vi.advanceTimersByTimeAsync(119999);
    expect(await behavior.matches(message("too-soon", "still cooling down"))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 1; i <= 4; i++) await behavior.execute(message(`fresh-${i}`, "new fragment"));
    expect(opportunities).toHaveLength(1);
    const fifth = message("fresh-5", "new fragment"); await behavior.execute(fifth);
    opportunities.at(-1)!(); await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(fifth, "spontaneous",
      Array.from({ length: 5 }, (_, i): unknown => expect.objectContaining({ id: `fresh-${i + 1}` })));
  });
  it("lets continuation bypass both the count and spontaneous cooldown without extending it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { behavior, opportunities, execute, setContinuation } = setup(false, false, 5);
    for (let i = 1; i <= 5; i++) await behavior.execute(message(String(i), "short fragment"));
    opportunities.at(-1)!(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60000); setContinuation(true);
    const followup = message("followup", "why?"); expect(await behavior.matches(followup)).toBe(true);
    await behavior.execute(followup); opportunities.at(-1)!(); await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenLastCalledWith(followup, "continuation", [followup]);
    setContinuation(false);
    expect(await behavior.matches(message("unrelated", "new conversation"))).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    for (let i = 1; i <= 5; i++) await behavior.execute(message(`new-${i}`, "new fragment"));
    expect(opportunities).toHaveLength(3);
  });
  it("keeps continuation separate from an incomplete spontaneous batch", async () => {
    const { behavior, opportunities, execute, setContinuation } = setup(false, false, 5);
    await behavior.execute(message("one", "short fragment")); await behavior.execute(message("two", "short fragment"));
    setContinuation(true); const followup = message("followup", "why?"); await behavior.execute(followup);
    opportunities.at(-1)!(); await vi.waitFor(() => expect(execute).toHaveBeenCalledExactlyOnceWith(followup, "continuation", [followup]));
    setContinuation(false);
    for (let i = 1; i <= 4; i++) await behavior.execute(message(`new-${i}`, "short fragment"));
    expect(opportunities).toHaveLength(1);
    await behavior.execute(message("new-5", "short fragment")); expect(opportunities).toHaveLength(2);
  });
  it("does not merge continuation batches from different human accounts", async () => {
    const { behavior, opportunities, execute } = setup(false, true, 5);
    const alice = message("alice-followup", "one followup"); await behavior.execute(alice);
    const bob = message("bob-followup", "another followup"); Object.assign(bob.author, { id: "bob" });
    await behavior.execute(bob);
    opportunities[0]!(); await Promise.resolve(); expect(execute).not.toHaveBeenCalled();
    opportunities[1]!(); await vi.waitFor(() => expect(execute).toHaveBeenCalledExactlyOnceWith(bob, "continuation", [bob]));
  });
  it("does not let a new speaker take over a buffered continuation", async () => {
    const { behavior, opportunities, execute, setContinuation } = setup(false, true, 5);
    await behavior.execute(message("alice-followup", "what about the engine?"));
    setContinuation(false);
    const bob = message("bob-comment", "are you joining too?"); Object.assign(bob.author, { id: "bob" });
    await behavior.execute(bob); opportunities[0]!(); await Promise.resolve();
    expect(execute).not.toHaveBeenCalled(); expect(opportunities).toHaveLength(1);
  });
  it("invalidates accumulated and scheduled work after a direct request or a settings change", async () => {
    const { behavior, profiles, opportunities, execute, reset } = setup(false, false, 2);
    await behavior.execute(message("one", "短句")); await behavior.execute(message("two", "短句"));
    reset(); opportunities.at(-1)!(); await Promise.resolve(); expect(execute).not.toHaveBeenCalled();
    await behavior.execute(message("new", "短句")); expect(opportunities).toHaveLength(1);
    await profiles.update(guildId, { chatParticipation: { messagesPerDecision: 3 } });
    await behavior.execute(message("after-settings", "短句")); expect(opportunities).toHaveLength(1);
  });
  it("rechecks eligibility before submitting a full batch for evaluation", async () => {
    const { behavior, opportunities, execute, check } = setup(false, false, 2);
    await behavior.execute(message("one", "短句")); await behavior.execute(message("two", "短句"));
    check.mockResolvedValue({ eligible: false }); opportunities.at(-1)!();
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(4)); expect(execute).not.toHaveBeenCalled();
  });
  it("does not accumulate direct mentions, name-addressed requests or replies to the bot", async () => {
    const { behavior, opportunities } = setup(false, false, 20);
    const mention = message("mention", "hello"); Object.assign(mention.mentions.users, { has: () => true });
    expect(await behavior.matches(mention)).toBe(false);
    expect(await behavior.matches(message("named", "Test Bot, can you answer?"))).toBe(false);
    const reply = message("reply", "answer this"); Object.assign(reply.mentions, { repliedUser: { id: "bot" } });
    expect(await behavior.matches(reply)).toBe(false); expect(opportunities).toHaveLength(0);
  });
  it("stops pending opportunities and new triggers after context is disabled", async () => {
    const { behavior, profiles, opportunities, execute } = setup(); const event = message("event", "anyone finish the event?");
    await behavior.execute(event); await profiles.update(guildId, { channelHistory: false }); opportunities.at(-1)!();
    expect(execute).not.toHaveBeenCalled(); expect(await behavior.matches(event)).toBe(false);
  });
});
