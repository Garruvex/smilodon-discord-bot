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
function setup(recent = false, implicitlyAddressed = false, messagesPerDecision = 1): { behavior: ProactiveChatBehavior; profiles: ReturnType<typeof memoryProvider>; opportunities: (() => void)[]; execute: ReturnType<typeof vi.fn>; reset: () => void; check: ReturnType<typeof vi.fn> } {
  const document = freshDocument(); document.features.channelHistory = true; document.features.chatbot = true;
  document.chat.participation.spontaneousEnabled = true; document.chat.participation.messagesPerDecision = messagesPerDecision;
  document.chat.participation.continuationEnabled = true;
  document.chat.participation.spontaneousChannelIds = [channelId];
  const profiles = memoryProvider(document); const opportunities: (() => void)[] = [];
  let version = 1;
  const reset = (): void => { version++; };
  const conversation = { optionalDecisionAvailable: true, optionalOpportunityVersion: () => version, hasRecentConversation: () => recent, isImplicitlyAddressed: () => implicitlyAddressed,
    bufferOpportunity: (_guild: string, _channel: string, work: () => void) => { opportunities.push(work); } } as unknown as ChatConversationService;
  const execute = vi.fn(() => Promise.resolve());
  const check = vi.fn(() => Promise.resolve({ eligible: true }));
  const behavior = new ProactiveChatBehavior(() => "bot", profiles, conversation,
    { check } as unknown as SocialChatEligibility,
    { execute } as unknown as AmbientChatBehavior, { warn: vi.fn() } as unknown as Logger);
  return { behavior, profiles, opportunities, execute, reset, check };
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
  it("collects messages across the old ten-second burst window but expires stale accumulation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { behavior, opportunities } = setup(false, false, 3);
    await behavior.execute(message("one", "短句")); await vi.advanceTimersByTimeAsync(20000);
    await behavior.execute(message("two", "短句")); await vi.advanceTimersByTimeAsync(20000);
    await behavior.execute(message("three", "短句")); expect(opportunities).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120000);
    await behavior.execute(message("new", "短句")); expect(opportunities).toHaveLength(1);
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
