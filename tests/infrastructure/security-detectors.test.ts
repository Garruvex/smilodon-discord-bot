import { describe, expect, it, vi, type Mock } from "vitest";

import { applyGuildConfigurationUpdate, toGuildConfiguration } from "../../src/config/guild-configuration-document.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../src/config/guild-configuration-provider.js";
import { LinkGuardService } from "../../src/infrastructure/discord/security/link-guard-service.js";
import { RaidService } from "../../src/infrastructure/discord/security/raid-service.js";
import { SpamService } from "../../src/infrastructure/discord/security/spam-service.js";
import { freshDocument, guildId } from "../helpers/settings-fixtures.js";

const logChannelId = "600000000000000002";
const adminRoleId = "200000000000000001";
const logger = { warn: vi.fn(), error: vi.fn() } as never;

function profile(update: UpdateGuildConfigurationInput): GuildConfiguration {
  return toGuildConfiguration(
    applyGuildConfigurationUpdate(freshDocument(), { securityLogChannelId: logChannelId, ...update }),
    "test.yaml",
  );
}

interface FakeMember {
  id: string;
  roles: { cache: Map<string, object> };
  permissions: { any: () => boolean };
  moderatable: boolean;
  kickable: boolean;
  bannable: boolean;
  timeout: Mock;
  kick: Mock;
  user: { bot: boolean; createdTimestamp: number };
  guild: unknown;
}

interface MemberOptions {
  roles?: string[];
  staff?: boolean;
  moderatable?: boolean;
  createdTimestamp?: number;
}

function memberFor(id: string, guild: unknown, options: MemberOptions = {}): FakeMember {
  const can = options.moderatable ?? true;
  return {
    id,
    roles: { cache: new Map((options.roles ?? []).map((role) => [role, {}])) },
    permissions: { any: (): boolean => options.staff ?? false },
    moderatable: can,
    kickable: can,
    bannable: can,
    timeout: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    user: { bot: false, createdTimestamp: options.createdTimestamp ?? 0 },
    guild,
  };
}

interface FakeGuild {
  id: string;
  ownerId: string;
  members: { me: null; cache: Map<string, FakeMember>; fetch: Mock; ban: Mock };
  channels: { cache: Map<string, unknown>; fetch: Mock };
}

function guildWith(channelIds: string[] = []): { guild: FakeGuild; sent: unknown[]; deleted: Map<string, Mock> } {
  const sent: unknown[] = [];
  const deleted = new Map<string, Mock>();
  const channels = new Map<string, unknown>([[logChannelId, {
    isTextBased: (): boolean => true,
    send: vi.fn((payload: unknown) => { sent.push(payload); return Promise.resolve(); }),
  }]]);
  for (const id of channelIds) {
    const remove = vi.fn().mockResolvedValue(undefined);
    deleted.set(id, remove);
    channels.set(id, { isTextBased: (): boolean => true, messages: { delete: remove } });
  }
  const guild: FakeGuild = {
    id: guildId,
    ownerId: "999999999999999999",
    members: { me: null, cache: new Map(), fetch: vi.fn().mockResolvedValue(null), ban: vi.fn().mockResolvedValue(undefined) },
    channels: { cache: channels, fetch: vi.fn() },
  };
  return { guild, sent, deleted };
}

function messageIn(guild: FakeGuild, member: FakeMember, channelId: string, content: string, id = `m-${channelId}`): {
  message: Record<string, unknown>;
  remove: Mock;
} {
  const remove = vi.fn().mockResolvedValue(undefined);
  return {
    remove,
    message: {
      guildId,
      guild,
      channelId,
      id,
      createdTimestamp: 1_000_000,
      webhookId: null,
      content,
      attachments: new Map(),
      author: { id: member.id, bot: false },
      member,
      delete: remove,
    },
  };
}

const text = (sent: unknown[]): string => JSON.stringify(sent);

describe("SpamService", () => {
  const spamOn = profile({ spamEnabled: true, spamChannels: 3, spamAction: "timeout" });
  const scam = "free nitro https://scam.example/claim";

  function setup(config = spamOn, options: MemberOptions = {}): {
    service: SpamService;
    member: FakeMember;
    post: (channelId: string) => Promise<boolean>;
    sent: unknown[];
    deleted: Map<string, Mock>;
  } {
    const { guild, sent, deleted } = guildWith(["c1", "c2", "c3"]);
    const member = memberFor("700000000000000001", guild, options);
    const service = new SpamService({ find: () => config } as never, logger, () => 1_000_000);
    const post = (channelId: string): Promise<boolean> =>
      service.handle(messageIn(guild, member, channelId, scam).message as never);
    return { service, member, post, sent, deleted };
  }

  it("does nothing for two channels", async () => {
    const { post, member } = setup();
    expect(await post("c1")).toBe(false);
    expect(await post("c2")).toBe(false);
    expect(member.timeout).not.toHaveBeenCalled();
  });

  it("times the member out on the third channel and removes the earlier posts", async () => {
    const { post, member, deleted, sent } = setup();
    await post("c1");
    await post("c2");
    expect(await post("c3")).toBe(true);
    expect(member.timeout).toHaveBeenCalledWith(24 * 60 * 60 * 1_000, expect.anything());
    expect(deleted.get("c1")).toHaveBeenCalledWith("m-c1");
    expect(deleted.get("c2")).toHaveBeenCalledWith("m-c2");
    expect(text(sent)).toContain("3 channels");
  });

  it("does nothing while it is off", async () => {
    const { post, member } = setup(profile({ spamEnabled: false }));
    await post("c1");
    await post("c2");
    expect(await post("c3")).toBe(false);
    expect(member.timeout).not.toHaveBeenCalled();
  });

  it("leaves staff alone", async () => {
    const { post, member, deleted } = setup(spamOn, { staff: true });
    await post("c1");
    await post("c2");
    expect(await post("c3")).toBe(false);
    expect(member.timeout).not.toHaveBeenCalled();
    expect(deleted.get("c1")).not.toHaveBeenCalled();
  });

  it("leaves a bot administrator alone", async () => {
    const { post, member } = setup(spamOn, { roles: [adminRoleId] });
    await post("c1");
    await post("c2");
    expect(await post("c3")).toBe(false);
    expect(member.timeout).not.toHaveBeenCalled();
  });

  it("removes the posts but reports when it can't act on the member", async () => {
    const { post, member, deleted, sent } = setup(spamOn, { moderatable: false });
    await post("c1");
    await post("c2");
    expect(await post("c3")).toBe(true);
    expect(member.timeout).not.toHaveBeenCalled();
    expect(deleted.get("c1")).toHaveBeenCalled();
    expect(text(sent)).toContain("could not be");
  });
});

describe("LinkGuardService", () => {
  const linksOn = profile({ linksEnabled: true, linksBlockedDomains: ["evil.com"] });

  function setup(config = linksOn, options: MemberOptions = {}): {
    run: (content: string) => Promise<{ handled: boolean; remove: Mock }>;
    member: FakeMember;
    sent: unknown[];
  } {
    const { guild, sent } = guildWith();
    const member = memberFor("700000000000000001", guild, options);
    const service = new LinkGuardService({ find: () => config } as never, logger, () => 1_000_000);
    return {
      member,
      sent,
      run: async (content: string): Promise<{ handled: boolean; remove: Mock }> => {
        const { message, remove } = messageIn(guild, member, "c1", content);
        return { handled: await service.handle(message as never), remove };
      },
    };
  }

  it("leaves an ordinary link alone", async () => {
    const { run } = setup();
    const { handled, remove } = await run("https://example.com/x");
    expect(handled).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes a message with a blocked site and reports it, without touching the member", async () => {
    const { run, member, sent } = setup();
    const { handled, remove } = await run("claim here https://evil.com/x");
    expect(handled).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(member.timeout).not.toHaveBeenCalled();
    expect(text(sent)).toContain("evil.com");
  });

  it("also times the member out when asked", async () => {
    const { run, member } = setup(profile({ linksEnabled: true, linksBlockedDomains: ["evil.com"], linksAction: "timeout" }));
    await run("https://evil.com");
    expect(member.timeout).toHaveBeenCalledWith(24 * 60 * 60 * 1_000, expect.anything());
  });

  it("flags a lookalike site by default", async () => {
    const { run } = setup(profile({ linksEnabled: true }));
    expect((await run("https://discord-nitro-free.com")).handled).toBe(true);
  });

  it("leaves staff's links alone", async () => {
    const { run } = setup(linksOn, { staff: true });
    const { handled, remove } = await run("https://evil.com");
    expect(handled).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does nothing while it is off", async () => {
    const { run } = setup(profile({ linksEnabled: false, linksBlockedDomains: ["evil.com"] }));
    expect((await run("https://evil.com")).handled).toBe(false);
  });
});

describe("RaidService", () => {
  const now = 100 * 86_400_000;

  function setup(update: UpdateGuildConfigurationInput, accounts: Record<string, MemberOptions> = {}): {
    join: (userId: string) => Promise<void>;
    members: Map<string, FakeMember>;
    sent: unknown[];
  } {
    const config = profile({ raidEnabled: true, raidJoins: 3, ...update });
    const { guild, sent } = guildWith();
    const members = new Map<string, FakeMember>();
    const service = new RaidService({ find: () => config } as never, logger, () => now);
    return {
      members,
      sent,
      join: async (userId: string): Promise<void> => {
        const member = memberFor(userId, guild, accounts[userId] ?? {});
        members.set(userId, member);
        guild.members.cache.set(userId, member);
        await service.handleJoin(member as never);
      },
    };
  }

  it("stays quiet below the threshold", async () => {
    const { join, sent } = setup({ raidAction: "kick" });
    await join("1");
    await join("2");
    expect(sent).toHaveLength(0);
  });

  it("alerts once and touches no one when set to alert only", async () => {
    const { join, members, sent } = setup({});
    for (const id of ["1", "2", "3", "4"]) await join(id);
    expect(sent).toHaveLength(1);
    expect(text(sent)).toContain("3 members");
    for (const member of members.values()) expect(member.kick).not.toHaveBeenCalled();
  });

  it("kicks everyone in the burst and each later joiner", async () => {
    const { join, members, sent } = setup({ raidAction: "kick" });
    for (const id of ["1", "2", "3"]) await join(id);
    expect([...members.values()].map((member) => member.kick.mock.calls.length)).toEqual([1, 1, 1]);
    await join("4");
    expect(members.get("4")?.kick).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(text(sent)).toContain("3 of them were kicked");
  });

  it("acts only on accounts newer than the limit", async () => {
    const day = 86_400_000;
    const { join, members } = setup(
      { raidAction: "kick", raidAccountAgeDays: 7 },
      { "1": { createdTimestamp: now - 2 * day }, "2": { createdTimestamp: now - 400 * day }, "3": { createdTimestamp: now - 1 * day } },
    );
    for (const id of ["1", "2", "3"]) await join(id);
    expect(members.get("1")?.kick).toHaveBeenCalledOnce();
    expect(members.get("2")?.kick).not.toHaveBeenCalled();
    expect(members.get("3")?.kick).toHaveBeenCalledOnce();
  });

  it("never touches staff or bot administrators who happen to join", async () => {
    const { join, members } = setup({ raidAction: "kick" }, { "1": { staff: true }, "2": { roles: [adminRoleId] } });
    for (const id of ["1", "2", "3"]) await join(id);
    expect(members.get("1")?.kick).not.toHaveBeenCalled();
    expect(members.get("2")?.kick).not.toHaveBeenCalled();
    expect(members.get("3")?.kick).toHaveBeenCalledOnce();
  });

  it("counts the ones it couldn't act on", async () => {
    const { join, sent } = setup({ raidAction: "kick" }, { "2": { moderatable: false } });
    for (const id of ["1", "2", "3"]) await join(id);
    expect(text(sent)).toContain("2 of them were kicked (1 could not be)");
  });

  it("does nothing while it is off", async () => {
    const { join, members } = setup({ raidEnabled: false, raidAction: "kick" });
    for (const id of ["1", "2", "3"]) await join(id);
    for (const member of members.values()) expect(member.kick).not.toHaveBeenCalled();
  });
});
