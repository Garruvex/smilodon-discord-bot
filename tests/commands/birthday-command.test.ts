import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { BirthdayCommand } from "../../src/infrastructure/discord/commands/common/birthday-command.js";
import type { BirthdayRecord, BirthdayStore } from "../../src/application/birthdays/birthday-store.js";
import type { CommandContext } from "../../src/application/commands/command.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";

function baseStore(overrides: Partial<BirthdayStore> = {}): BirthdayStore {
  return {
    initialize: () => Promise.resolve(),
    setBirthday: () => Promise.resolve(),
    removeBirthday: () => Promise.resolve(false),
    getBirthday: () => Promise.resolve(null),
    listForGuildOnDate: () => Promise.resolve([]),
    listAllForGuild: () => Promise.resolve([]),
    hasAnnounced: () => Promise.resolve(false),
    markAnnounced: () => Promise.resolve(),
    ...overrides,
  };
}

function configurationProvider(timezone = "UTC"): GuildConfigurationProvider {
  return {
    initialize: () => Promise.resolve(),
    find: () => ({ timezone } as GuildConfiguration),
    require: () => ({ timezone } as GuildConfiguration),
    getAll: () => [],
    create: () => Promise.reject(new Error("not implemented")),
    update: () => Promise.reject(new Error("not implemented")),
    reload: () => Promise.resolve(),
  };
}

function makeContext(
  subcommand: string,
  options: { isPublic?: boolean | null } = {},
): { context: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(undefined);
  const context = {
    interaction: {
      inCachedGuild: () => true,
      guildId: "guild",
      user: { id: "user" },
      options: {
        getSubcommand: () => subcommand,
        getUser: () => null,
        getBoolean: () => options.isPublic ?? null,
      },
    },
    logger: {} as never,
    responses: { reply } as never,
  } as unknown as CommandContext;
  return { context, reply };
}

describe("BirthdayCommand next", () => {
  it("reports when no one has a birthday set", async () => {
    const command = new BirthdayCommand(baseStore(), configurationProvider());
    const { context, reply } = makeContext("next");

    await command.execute(context);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("No one has set a birthday"),
    }));
  });

  it("picks the closest upcoming birthday, wrapping around the year", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-30T00:00:00Z"));

    const records: BirthdayRecord[] = [
      { userId: "far", month: 6, day: 1 },
      { userId: "soonest", month: 1, day: 2 },
    ];
    const store = baseStore({ listAllForGuild: () => Promise.resolve(records) });
    const command = new BirthdayCommand(store, configurationProvider());
    const { context, reply } = makeContext("next");

    await command.execute(context);
    const [payload] = reply.mock.calls[0] as [{ content: string }];
    expect(payload.content).toContain("<@soonest>");
    expect(payload.content).toContain("January 2");

    vi.useRealTimers();
  });

  it("lists everyone tied for the next birthday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));

    const records: BirthdayRecord[] = [
      { userId: "userA", month: 3, day: 14 },
      { userId: "userB", month: 3, day: 14 },
    ];
    const store = baseStore({ listAllForGuild: () => Promise.resolve(records) });
    const command = new BirthdayCommand(store, configurationProvider());
    const { context, reply } = makeContext("next");

    await command.execute(context);
    const [payload] = reply.mock.calls[0] as [{ content: string }];
    expect(payload.content).toContain("<@userA>");
    expect(payload.content).toContain("<@userB>");

    vi.useRealTimers();
  });

  it("defaults to an ephemeral reply when public is not requested", async () => {
    const store = baseStore({ listAllForGuild: () => Promise.resolve([{ userId: "user", month: 1, day: 1 }]) });
    const command = new BirthdayCommand(store, configurationProvider());
    const { context, reply } = makeContext("next");

    await command.execute(context);
    const [payload] = reply.mock.calls[0] as [{ flags?: number }];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it("replies publicly when public:true is passed", async () => {
    const store = baseStore({ listAllForGuild: () => Promise.resolve([{ userId: "user", month: 1, day: 1 }]) });
    const command = new BirthdayCommand(store, configurationProvider());
    const { context, reply } = makeContext("next", { isPublic: true });

    await command.execute(context);
    const [payload] = reply.mock.calls[0] as [{ flags?: number }];
    expect(payload.flags).toBeUndefined();
  });
});
