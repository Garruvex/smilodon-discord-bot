import type { Message } from "discord.js";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import { freshProfile } from "../helpers/settings-fixtures.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { MessageOriginRecord, MessageOriginStore } from "../../src/application/chat/message-origin-store.js";
import { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";

function fixture(): { profile: GuildConfiguration; records: Map<string, MessageOriginRecord>; policy: SocialChatEligibility;
  message: (id: string, bot?: boolean, target?: string) => Message; guard: Mock<() => Promise<boolean>> } {
  const profile = freshProfile();
  profile.features.chatbot = true;
  profile.features.reactionReplies = true;
  const records = new Map<string, MessageOriginRecord>();
  const messages = new Map<string, Message>();
  const origins: MessageOriginStore = {
    record: (input) => { records.set(input.messageId, input); return Promise.resolve(); },
    find: (guild, channel, id) => Promise.resolve(records.get(id)?.guildId === guild && records.get(id)?.channelId === channel ? records.get(id)! : null),
  };
  const guard = vi.fn(() => Promise.resolve(false));
  const policy = new SocialChatEligibility(
    { ownerUserIds: new Set(["human"]) } as unknown as ApplicationConfiguration,
    { find: () => profile } as unknown as GuildConfigurationProvider, origins, guard,
  );
  const message = (id: string, bot = false, target?: string): Message => {
    const result = {
      id, guildId: profile.guildId, channelId: "channel", inGuild: () => true,
      author: { id: bot ? "bot" : "human", bot }, member: { roles: { cache: new Map() } },
      reference: target ? { messageId: target } : null,
      channel: { isThread: () => false, messages: { fetch: (id: string) => Promise.resolve(messages.get(id) ?? null) } },
    } as unknown as Message;
    messages.set(id, result); return result;
  };
  return { profile, records, policy, message, guard };
}

describe("social eligibility boundary", () => {
  it("excludes direct mentions and multi-hop replies to utility output while allowing standalone conversation", async () => {
    const { profile, records, policy, message } = fixture();
    message("utility", true);
    records.set("utility", { messageId: "utility", guildId: profile.guildId, channelId: "channel", origin: "link_fix", sourceMessageId: null, createdAt: 1 });
    const first = message("first", false, "utility");
    const second = message("second", false, "first");
    expect((await policy.check(first)).eligible).toBe(false);
    expect((await policy.check(second)).eligible).toBe(false);
    expect((await policy.check(message("new"))).eligible).toBe(true);
  });
  it("allows direct pings on legacy or missing targets while optional turns fail closed", async () => {
    const { policy, message } = fixture();
    message("legacy", true);
    expect((await policy.check(message("reply", false, "legacy"))).eligible).toBe(true);
    expect((await policy.check(message("missing", false, "deleted"))).eligible).toBe(true);
    expect((await policy.check(message("optional", false, "legacy"), "reaction")).eligible).toBe(false);
  });
  it("does not fetch Discord reply history during passive observation", async () => {
    const { policy, message } = fixture();
    const event = message("observer", false, "uncached-target");
    const fetch = vi.spyOn(event.channel.messages, "fetch");
    expect((await policy.check(event, "observation")).eligible).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("permits recorded chat output but rechecks master enable and authoritative ownership", async () => {
    const { profile, records, policy, message, guard } = fixture();
    const bot = message("chat", true);
    records.set("chat", { messageId: "chat", guildId: profile.guildId, channelId: "channel", origin: "chat", sourceMessageId: null, createdAt: 1 });
    expect((await policy.check(bot, "reaction")).eligible).toBe(true);
    profile.features.chatbot = false;
    expect((await policy.check(bot, "reaction")).eligible).toBe(false);
    profile.features.chatbot = true;
    guard.mockRejectedValueOnce(new Error("ownership unavailable"));
    expect((await policy.check(bot, "reaction")).eligible).toBe(false);
  });
});
