import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { DiscordChannelHistoryReader } from "../../src/infrastructure/discord/context/discord-channel-history-reader.js";
import { freshProfile } from "../helpers/settings-fixtures.js";

describe("background reading boundaries", () => {
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
