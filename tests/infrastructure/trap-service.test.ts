import { describe, expect, it, vi, type Mock } from "vitest";

import { TrapService } from "../../src/infrastructure/discord/security/trap-service.js";
import { applyGuildConfigurationUpdate, toGuildConfiguration } from "../../src/config/guild-configuration-document.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../src/config/guild-configuration-provider.js";
import { freshDocument, guildId } from "../helpers/settings-fixtures.js";

const trapChannelId = "600000000000000001";
const logChannelId = "600000000000000002";
const userId = "700000000000000001";

function profile(update: UpdateGuildConfigurationInput = {}): GuildConfiguration {
  const document = applyGuildConfigurationUpdate(freshDocument(), {
    trapEnabled: true,
    trapChannelId,
    securityLogChannelId: logChannelId,
    ...update,
  });
  return toGuildConfiguration(document, "test.yaml");
}

interface Fixture {
  handle: () => Promise<boolean>;
  member: { timeout: Mock; kick: Mock };
  guild: { members: { ban: Mock } };
  message: { delete: Mock };
  sent: unknown[];
}

interface Options {
  roles?: string[];
  staff?: boolean;
  moderatable?: boolean;
  bot?: boolean;
  channelId?: string;
}

function fixture(config = profile(), options: Options = {}): Fixture {
  const sent: unknown[] = [];
  const member = {
    id: userId,
    roles: { cache: new Map((options.roles ?? []).map((id) => [id, {}])) },
    permissions: { any: (): boolean => options.staff ?? false },
    moderatable: options.moderatable ?? true,
    kickable: options.moderatable ?? true,
    bannable: options.moderatable ?? true,
    timeout: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    guild: undefined as unknown,
  };
  const log = { isTextBased: (): boolean => true, send: vi.fn((payload: unknown) => { sent.push(payload); return Promise.resolve(); }) };
  const guild = {
    id: guildId,
    ownerId: "999999999999999999",
    members: { me: null, fetch: vi.fn(), ban: vi.fn().mockResolvedValue(undefined) },
    channels: { cache: new Map([[logChannelId, log]]), fetch: vi.fn() },
  };
  member.guild = guild;
  const message = {
    guildId,
    guild,
    channelId: options.channelId ?? trapChannelId,
    id: "800000000000000001",
    createdTimestamp: 1_000_000,
    webhookId: null,
    author: { id: userId, bot: options.bot ?? false },
    member,
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const service = new TrapService(
    { find: () => config } as never,
    { warn: vi.fn(), error: vi.fn() } as never,
    () => 1_000_000,
  );
  const handle = (): Promise<boolean> => service.handle(message as never);
  return { handle, member, guild, message, sent };
}

const description = (sent: unknown[]): string =>
  JSON.stringify(sent[0]);

describe("TrapService", () => {
  it("ignores messages outside the trap channel", async () => {
    const { handle, message, member } = fixture(undefined, { channelId: "600000000000000099" });
    expect(await handle()).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
    expect(member.timeout).not.toHaveBeenCalled();
  });

  it("does nothing while the trap is off", async () => {
    const { handle, message } = fixture(profile({ trapEnabled: false }));
    expect(await handle()).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it("deletes the message, times the member out and reports it", async () => {
    const { handle, message, member, sent } = fixture();
    expect(await handle()).toBe(true);
    expect(message.delete).toHaveBeenCalledOnce();
    expect(member.timeout).toHaveBeenCalledWith(28 * 24 * 60 * 60 * 1_000, expect.any(String));
    expect(description(sent)).toContain(`<@${userId}>`);
    expect(description(sent)).toContain("timed out");
  });

  it("bans with Discord's own deletion window", async () => {
    const { handle, guild } = fixture(profile({ trapAction: "ban", trapDeleteWindow: "30m" }));
    await handle();
    expect(guild.members.ban).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deleteMessageSeconds: 1_800 }));
  });

  it.each([
    ["staff", { staff: true }],
    ["a bot", { bot: true }],
    ["a bot administrator", { roles: ["200000000000000001"] }],
  ])("leaves %s alone and keeps their message", async (_name, options) => {
    const { handle, message, member } = fixture(profile({ trapAction: "ban" }), options);
    expect(await handle()).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
    expect(member.timeout).not.toHaveBeenCalled();
  });

  it("leaves an exempt role alone", async () => {
    const exempt = "300000000000000009";
    const { handle, message } = fixture(profile({ securityExemptRoleIds: [exempt] }), { roles: [exempt] });
    expect(await handle()).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it("removes the message but reports it when the bot can't act on the member", async () => {
    const { handle, message, member, sent } = fixture(undefined, { moderatable: false });
    expect(await handle()).toBe(true);
    expect(message.delete).toHaveBeenCalledOnce();
    expect(member.timeout).not.toHaveBeenCalled();
    expect(description(sent)).toContain("could not be");
  });

  it("reports nowhere when neither a security log nor an audit log is set", async () => {
    const { handle, sent } = fixture(profile({ securityLogChannelId: null }));
    await handle();
    expect(sent).toHaveLength(0);
  });

  it("falls back to the audit-log channel when no security log is set", async () => {
    const { handle, sent } = fixture(profile({ securityLogChannelId: null, auditLogChannelId: logChannelId }));
    await handle();
    expect(sent).toHaveLength(1);
  });

  it("reports in the guild's own language", async () => {
    const config = { ...profile(), language: "ja" as const };
    const { handle, sent } = fixture(config);
    await handle();
    expect(description(sent)).toContain("タイムアウト");
  });
});

