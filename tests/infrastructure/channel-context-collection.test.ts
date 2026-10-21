import { Collection, type Client, type GuildMember, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { DiscordChannelHistoryReader } from "../../src/infrastructure/discord/context/discord-channel-history-reader.js";
import { freshProfile } from "../helpers/settings-fixtures.js";

function fixture(): {
  reader: DiscordChannelHistoryReader; profile: ReturnType<typeof freshProfile>; members: Map<string, GuildMember>;
  forgotten: Set<string>; read: () => ReturnType<DiscordChannelHistoryReader["readBatch"]>; revoke: () => void;
} {
  const profile = freshProfile(); const channelId = "500000000000000001";
  profile.features.chatbot = true; profile.features.channelHistory = true;
  profile.roles.chatbot = new Set(["interaction-role"]);
  profile.chat.contextDailyChannelIds = [channelId];
  profile.chat.contextOptOutUserIds = ["excluded-user"]; profile.chat.contextOptOutRoleIds = ["excluded-role"];
  const members = new Map<string, GuildMember>(); const messages = new Collection<string, Message>(); const forgotten = new Set<string>();
  let readable = true;
  const guild = { id: profile.guildId, members: { me: {}, fetchMe: (): Promise<object> => Promise.resolve({}),
    fetch: (input: string | { user: string }): Promise<GuildMember | null> => Promise.resolve(members.get(typeof input === "string" ? input : input.user) ?? null) } };
  const channel = { id: channelId, guildId: profile.guildId, guild, isTextBased: (): boolean => true, isDMBased: (): boolean => false,
    permissionsFor: (): { has: () => boolean } => ({ has: (): boolean => readable }),
    messages: { fetch: (input: string | { message?: string }): Promise<Message | Collection<string, Message> | null> =>
      Promise.resolve(typeof input === "string" || input.message ? messages.get(typeof input === "string" ? input : input.message!) ?? null : messages) } };
  for (const [index, userId] of ["allowed", "excluded-user", "excluded-role-user"].entries()) {
    members.set(userId, { id: userId, displayName: userId, roles: { cache: new Map(userId === "excluded-role-user" ? [["excluded-role", {}]] : []) } } as unknown as GuildMember);
    const id = `60000000000000000${index}`;
    messages.set(id, { id, guildId: profile.guildId, channelId, guild, channel, member: null,
      author: { id: userId, bot: false, username: userId }, createdTimestamp: 1000 + index, content: `text from ${userId}`,
      inGuild: (): boolean => true, system: false } as unknown as Message);
  }
  const eligibility = new SocialChatEligibility({ ownerUserIds: new Set() } as unknown as ApplicationConfiguration,
    { find: () => profile } as unknown as GuildConfigurationProvider, { record: vi.fn(), find: vi.fn().mockResolvedValue(null) }, null);
  eligibility.bindGuardedForgetPolicy((message) => Promise.resolve(forgotten.has(message.id)));
  const reader = new DiscordChannelHistoryReader({ channels: { fetch: (): Promise<object> => Promise.resolve(channel) } } as unknown as Client, eligibility);
  return { reader, profile, members, forgotten, revoke: (): void => { readable = false; },
    read: () => reader.readBatch({ guildId: profile.guildId, channelId, boundaryMs: 0, beforeMessageId: null, maxMessages: 40, maxCharacters: 12000, maxCharactersPerMessage: 4000 }) };
}

describe("channel-context collection for daily summaries and scans", () => {
  it("includes people without interaction roles and filters user and uncached role opt-outs", async () => {
    const f = fixture(); const result = await f.read();
    expect(result.ok).toBe(true); if (!result.ok) throw new Error("Expected admitted batch");
    expect(result.messages.map((message) => message.authorId)).toEqual(["allowed"]);
    expect(await f.reader.validateBatch(result.messages)).toBe(true);
  });
  it.each(["user_opt_out", "role_opt_out", "forget", "channel_permission"] as const)("invalidates a collected summary batch after %s", async (change) => {
    const f = fixture(); const result = await f.read(); if (!result.ok) throw new Error("Expected admitted batch");
    if (change === "user_opt_out") f.profile.chat.contextOptOutUserIds = ["allowed"];
    if (change === "role_opt_out") f.members.get("allowed")!.roles.cache.set("excluded-role", {} as never);
    if (change === "forget") f.forgotten.add(result.messages[0]!.id);
    if (change === "channel_permission") f.revoke();
    expect(await f.reader.validateBatch(result.messages)).toBe(false);
  });
});
