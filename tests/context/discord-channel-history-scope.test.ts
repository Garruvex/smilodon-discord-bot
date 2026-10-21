import { describe, expect, it, vi } from "vitest";
import { Collection, type Client } from "discord.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { DiscordChannelHistoryReader } from "../../src/infrastructure/discord/context/discord-channel-history-reader.js";
import { freshProfile } from "../helpers/settings-fixtures.js";

describe("background reading boundaries", () => {
  it.each(["current", "edited", "deleted", "actor_denied", "member_unavailable", "scope_revoked", "missing_permission"] as const)("freshly revalidates source content, actors and channel scope: %s", async (scenario) => {
    const member = { id: "alice", displayName: "Alice" };
    const message = { id: "100", author: { id: "alice", bot: false }, system: false, createdTimestamp: 1, content: scenario === "edited" ? "CHANGED_TEXT" : "original" };
    const eligibility = { canReadBackground: vi.fn(() => scenario !== "scope_revoked"),
      checkBackgroundSource: vi.fn((_message: unknown, freshMember: unknown) => {
        expect(freshMember).toBe(member); return Promise.resolve({ eligible: scenario !== "actor_denied", reason: "test" });
      }) };
    const fetchMessages = vi.fn((input: { message?: string }) => Promise.resolve(input.message ? null : new Collection(scenario === "deleted" ? [] : [["100", message]])));
    const channel = { isTextBased: (): boolean => true, isDMBased: (): boolean => false, guildId: "guild", messages: { fetch: fetchMessages },
      guild: { members: { fetchMe: vi.fn(() => Promise.resolve({ id: "bot" })), fetch: vi.fn(() => Promise.resolve(scenario === "member_unavailable" ? null : member)) } },
      permissionsFor: (): { has: () => boolean } => ({ has: (): boolean => scenario !== "missing_permission" }) };
    const client = { channels: { fetch: vi.fn(() => Promise.resolve(channel)) } };
    const reader = new DiscordChannelHistoryReader(client as unknown as Client, eligibility as unknown as SocialChatEligibility);
    const source = { id: "100", guildId: "guild", channelId: "channel", authorId: "alice", authorDisplayName: "Alice", content: "original", createdAt: 1 };
    expect(await reader.validateBatch([source])).toBe(scenario === "current");
    if (scenario === "current") {
      expect(channel.guild.members.fetch).toHaveBeenCalledWith({ user: "alice", force: true, cache: false });
      expect(client.channels.fetch).toHaveBeenCalledWith("channel", { force: true });
    }
  });

  it("checks the scan/daily scope before fetching and keeps it independent of passive reply scope", async () => {
    const profile = freshProfile(); profile.features.chatbot = true;
    profile.channels.chatbot = new Set(["passive"]);
    profile.chat.contextDailyChannelIds = ["daily"]; profile.chat.contextScanChannelIds = ["scan"];
    const eligibility = new SocialChatEligibility({ ownerUserIds: new Set() } as unknown as ApplicationConfiguration,
      { find: () => profile } as unknown as GuildConfigurationProvider, { record: (): Promise<void> => Promise.resolve(), find: (): Promise<null> => Promise.resolve(null) }, null);
    const fetch = vi.fn(() => Promise.resolve(null));
    const reader = new DiscordChannelHistoryReader({ channels: { fetch } } as unknown as Client, eligibility);
    const input = { guildId: profile.guildId, channelId: "passive", boundaryMs: 0, beforeMessageId: null, maxMessages: 10, maxCharacters: 2000, maxCharactersPerMessage: 500 };
    expect(await reader.readBatch(input)).toMatchObject({ ok: false, code: "scope_denied" }); expect(fetch).not.toHaveBeenCalled();
    expect(eligibility.canReadBackground(profile.guildId, "daily")).toBe(true);
    expect(eligibility.canReadBackground(profile.guildId, "scan")).toBe(true);
    expect(await reader.readBatch({ ...input, channelId: "daily" })).toMatchObject({ ok: false, code: "channel_not_found" }); expect(fetch).toHaveBeenCalledOnce();
    profile.chat.contextDailyChannelIds = []; expect(await reader.canLearn(profile.guildId, "daily", "source")).toBe(false);
    profile.chat.channelMemoryModes = { scan: "disabled" }; expect(eligibility.canReadBackground(profile.guildId, "scan")).toBe(false);
    expect(eligibility.canReadBackground(profile.guildId, "thread-of-scan")).toBe(false);
  });
});
