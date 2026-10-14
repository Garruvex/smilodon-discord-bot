import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
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
function setup(): { behavior: ProactiveChatBehavior; profiles: ReturnType<typeof memoryProvider>; opportunities: (() => void)[]; execute: ReturnType<typeof vi.fn> } {
  const document = freshDocument(); document.features.channelHistory = true; document.features.chatbot = true;
  document.chat.participation.spontaneousEnabled = true;
  document.chat.participation.spontaneousChannelIds = [channelId];
  const profiles = memoryProvider(document); const opportunities: (() => void)[] = [];
  const conversation = { hasRecentConversation: () => false, isImplicitlyAddressed: () => false,
    bufferOpportunity: (_guild: string, _channel: string, work: () => void) => { opportunities.push(work); } } as unknown as ChatConversationService;
  const execute = vi.fn(() => Promise.resolve());
  const behavior = new ProactiveChatBehavior(() => "bot", profiles, conversation,
    { check: () => Promise.resolve({ eligible: true }) } as unknown as SocialChatEligibility,
    { execute } as unknown as AmbientChatBehavior, { warn: vi.fn() } as unknown as Logger);
  return { behavior, profiles, opportunities, execute };
}
describe("optional conversation bursts", () => {
  it("passes all fragments to one opportunity while keeping the last message as trigger", async () => {
    const { behavior, opportunities, execute } = setup();
    const first = message("first", "did anyone finish the event?"); const last = message("last", "lol");
    expect(await behavior.matches(first)).toBe(true); await behavior.execute(first);
    expect(await behavior.matches(last)).toBe(true); await behavior.execute(last);
    opportunities.at(-1)!();
    expect(execute).toHaveBeenCalledExactlyOnceWith(last, "spontaneous", [first, last]);
  });
  it("stops pending opportunities and new triggers after context is disabled", async () => {
    const { behavior, profiles, opportunities, execute } = setup(); const event = message("event", "anyone finish the event?");
    await behavior.execute(event); await profiles.update(guildId, { channelHistory: false }); opportunities.at(-1)!();
    expect(execute).not.toHaveBeenCalled(); expect(await behavior.matches(event)).toBe(false);
  });
});
