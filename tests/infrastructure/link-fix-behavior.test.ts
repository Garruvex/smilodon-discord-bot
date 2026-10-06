import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { BehaviorResult } from "../../src/application/behaviors/behavior.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { LinkFixBehavior } from "../../src/infrastructure/discord/behaviors/link-fix-behavior.js";

function fixture(content = "https://b23.tv/AbCd12", bilibili = true): {
  behavior: LinkFixBehavior;
  message: Message;
  reply: ReturnType<typeof vi.fn>;
  suppressEmbeds: ReturnType<typeof vi.fn>;
} {
  const profile = {
    features: { linkFix: true }, channels: { linkFix: new Set(["channel"]) },
    linkFixPlatforms: { twitter: true, threads: true, tiktok: true, instagram: true, reddit: true, bilibili },
  } as unknown as GuildConfiguration;
  const profiles = { find: () => profile } as unknown as GuildConfigurationProvider;
  const logger = { warn: vi.fn() } as unknown as Logger;
  const reply = vi.fn().mockResolvedValue({});
  const suppressEmbeds = vi.fn().mockResolvedValue({});
  const message = {
    inGuild: () => true, author: { bot: false }, guildId: "guild", channelId: "channel", id: "message",
    content, reply, suppressEmbeds,
  } as unknown as Message;
  return { behavior: new LinkFixBehavior(profiles, logger), message, reply, suppressEmbeds };
}

describe("LinkFixBehavior", () => {
  it("replies to Bilibili short links without needing an API preview", async () => {
    const f = fixture();
    expect(await f.behavior.matches(f.message)).toBe(true);
    expect(await f.behavior.execute(f.message)).toBe(BehaviorResult.Continue);
    expect(f.reply).toHaveBeenCalledWith({ content: "https://vxb23.tv/AbCd12", allowedMentions: { repliedUser: false } });
    expect(f.suppressEmbeds).toHaveBeenCalledWith(true);
    expect(f.reply.mock.invocationCallOrder[0]).toBeLessThan(f.suppressEmbeds.mock.invocationCallOrder[0]!);
  });

  it("leaves original previews intact when sending fails", async () => {
    const f = fixture();
    f.reply.mockRejectedValue(new Error("Missing permissions"));
    expect(await f.behavior.execute(f.message)).toBe(BehaviorResult.Continue);
    expect(f.suppressEmbeds).not.toHaveBeenCalled();
  });

  it("does not hide previews when the rewritten URL exceeds the message limit", async () => {
    const f = fixture(`https://bilibili.com/video/av2?value=${"x".repeat(2_000)}`);
    await f.behavior.execute(f.message);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.suppressEmbeds).not.toHaveBeenCalled();
  });

  it("honors the Bilibili toggle", async () => {
    const f = fixture("https://b23.tv/AbCd12", false);
    expect(await f.behavior.matches(f.message)).toBe(false);
    await f.behavior.execute(f.message);
    expect(f.reply).not.toHaveBeenCalled();
  });
});
