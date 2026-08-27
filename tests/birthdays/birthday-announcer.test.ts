import type { Client } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { BirthdayAnnouncer } from "../../src/application/birthdays/birthday-announcer.js";
import type { BirthdayStore } from "../../src/application/birthdays/birthday-store.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

function profile(overrides: Partial<GuildConfiguration> = {}): GuildConfiguration {
  return {
    guildId: "guild",
    embedColor: "#3B82F6",
    timezone: "UTC",
    features: { birthdays: true },
    channels: { birthdayAnnouncements: "channel" },
    ...overrides,
  } as unknown as GuildConfiguration;
}

function stubProvider(profiles: readonly GuildConfiguration[]): GuildConfigurationProvider {
  return {
    initialize: () => Promise.resolve(),
    find: () => profiles[0] ?? null,
    require: () => profiles[0] as GuildConfiguration,
    getAll: () => profiles,
    create: () => Promise.reject(new Error("not used")),
    update: () => Promise.reject(new Error("not used")),
    reload: () => Promise.resolve(),
  };
}

function stubStore(): { store: BirthdayStore; hasAnnounced: ReturnType<typeof vi.fn>; listForGuildOnDate: ReturnType<typeof vi.fn> } {
  const hasAnnounced = vi.fn().mockResolvedValue(false);
  const listForGuildOnDate = vi.fn().mockResolvedValue([]);
  const store: BirthdayStore = {
    initialize: vi.fn().mockResolvedValue(undefined),
    setBirthday: vi.fn().mockResolvedValue(undefined),
    removeBirthday: vi.fn().mockResolvedValue(true),
    getBirthday: vi.fn().mockResolvedValue(null),
    listForGuildOnDate,
    hasAnnounced,
    markAnnounced: vi.fn().mockResolvedValue(undefined),
  };
  return { store, hasAnnounced, listForGuildOnDate };
}

function stubLogger(): Logger {
  return { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("BirthdayAnnouncer", () => {
  it("resolves 'today' using the guild's configured time zone, not UTC", async () => {
    // 2024-01-01T05:00:00Z is still 2023-12-31 evening in Pacific/Honolulu
    // (UTC-10) — a guild there should be checked against Dec 31, not Jan 1.
    const now = new Date("2024-01-01T05:00:00Z");
    const { store, hasAnnounced, listForGuildOnDate } = stubStore();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
    const announcer = new BirthdayAnnouncer(
      client,
      stubProvider([profile({ timezone: "Pacific/Honolulu" })]),
      store,
      stubLogger(),
    );

    await announcer.checkNow(now);

    expect(hasAnnounced).toHaveBeenCalledWith("guild", "2023-12-31");
    expect(listForGuildOnDate).toHaveBeenCalledWith("guild", 12, 31);
  });

  it("uses UTC directly for a guild with the default UTC time zone", async () => {
    const now = new Date("2024-01-01T05:00:00Z");
    const { store, hasAnnounced, listForGuildOnDate } = stubStore();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
    const announcer = new BirthdayAnnouncer(
      client,
      stubProvider([profile({ timezone: "UTC" })]),
      store,
      stubLogger(),
    );

    await announcer.checkNow(now);

    expect(hasAnnounced).toHaveBeenCalledWith("guild", "2024-01-01");
    expect(listForGuildOnDate).toHaveBeenCalledWith("guild", 1, 1);
  });
});
