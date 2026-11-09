import type { GuildMember, Message } from "discord.js";
import { GuildMemberRoleManager } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionChatAccess, memberLookupDeadlineMs } from "../../src/infrastructure/discord/behaviors/mention-chat-access.js";
import { ChatPolicy } from "../../src/application/chat/chat-policy.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import { freshDocument, memoryProvider, guildId } from "../helpers/settings-fixtures.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

afterEach(() => vi.useRealTimers());
function fixture(): { access: MentionChatAccess; message: Message; fetch: ReturnType<typeof vi.fn<(options: unknown) => Promise<GuildMember | null>>>; member: GuildMember; profiles: ReturnType<typeof memoryProvider> } {
  const document = freshDocument(); document.features.chatbot = true;
  const profiles = memoryProvider(document);
  const { logger } = captureDiagnosticLogger();
  const access = new MentionChatAccess(new ChatPolicy({ ownerUserIds: new Set() } as unknown as ApplicationConfiguration), profiles, logger);
  const fetch = vi.fn<(options: unknown) => Promise<GuildMember | null>>();
  const message = { guildId, channelId: "channel", author: { id: "human" }, member: null, guild: { members: { fetch } } } as unknown as Message;
  const member = { roles: { cache: new Map([[document.roles.botAdministrator[0]!, {}]]) } } as unknown as GuildMember;
  return { access, message, fetch, member, profiles };
}

describe("bounded mention access", () => {
  it("shares a stalled lookup, times out callers, and never treats its late result as cached authorization", async () => {
    vi.useFakeTimers(); const { access, message, fetch, member } = fixture();
    let finish!: (member: GuildMember) => void;
    fetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = access.resolve(message); const second = access.resolve(message);
    await vi.advanceTimersByTimeAsync(memberLookupDeadlineMs);
    expect((await first).reason).toBe("member_unavailable"); expect((await second).reason).toBe("member_unavailable");
    const third = access.resolve(message);
    await vi.advanceTimersByTimeAsync(memberLookupDeadlineMs);
    expect((await third).reason).toBe("member_unavailable"); expect(fetch).toHaveBeenCalledOnce();
    finish(member); await Promise.resolve(); await Promise.resolve();
    fetch.mockResolvedValue(null);
    expect((await access.resolve(message)).reason).toBe("member_unavailable"); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("evaluates configuration changes after the membership fetch", async () => {
    const { access, message, fetch, member, profiles } = fixture();
    fetch.mockImplementation(async () => { await profiles.update(guildId, { chatbotChannelIds: ["900000000000000001"] }); return member; });
    expect((await access.resolve(message)).reason).toBe("channel_denied");
  });

  it("recognizes everyone with the real Discord.js role-cache getter without fetching", async () => {
    const { access, message, profiles, fetch } = fixture();
    await profiles.update(guildId, { chatbotRoleIds: [guildId] });
    const manager = { guild: { id: guildId, roles: { everyone: undefined, cache: new Map() } }, member: { _roles: [] } };
    const cache = Reflect.get(GuildMemberRoleManager.prototype, "cache", manager);
    Object.assign(message, { member: { roles: { cache } } });
    expect((await access.resolve(message)).reason).toBe("allowed"); expect(fetch).not.toHaveBeenCalled();
  });
});
