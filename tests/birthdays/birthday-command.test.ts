import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { BirthdayCommand } from "../../src/infrastructure/discord/commands/common/birthday-command.js";
import type { CommandContext } from "../../src/application/commands/command.js";
import type { BirthdayStore } from "../../src/application/birthdays/birthday-store.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";

function contextFor(subcommand: string, values: Record<string, unknown>, admin: boolean, reply: Mock): CommandContext {
  let deferred = false;
  return {
    responses: { reply, edit: reply },
    interaction: {
      inCachedGuild: (): boolean => true,
      get deferred(): boolean { return deferred; },
      deferReply: vi.fn((_payload: unknown): Promise<void> => { deferred = true; return Promise.resolve(); }),
      guildId: "guild",
      user: { id: "self" },
      member: { roles: { cache: { some: (predicate: (role: { id: string }) => boolean): boolean => admin && predicate({ id: "admin" }) } } },
      guild: { members: { fetch: vi.fn().mockResolvedValue({}) } },
      options: {
        getSubcommand: (): string => subcommand,
        getUser: (name: string): unknown => values[name] ?? null,
        getInteger: (name: string): unknown => values[name] ?? null,
        getString: (name: string): unknown => values[name] ?? null,
        getBoolean: (name: string): unknown => values[name] ?? null,
      },
    },
  } as unknown as CommandContext;
}

afterEach(() => vi.useRealTimers());

describe("BirthdayCommand personalization", () => {
  it.each([
    { language: "zh-TW", nextTitle: "接下來的生日", listTitle: "伺服器生日清單", birthday: "28 歲生日", set: "你的生日已設定為" },
    { language: "ja", nextTitle: "次の誕生日", listTitle: "サーバーの誕生日一覧", birthday: "28歳の誕生日", set: "あなたの誕生日を" },
  ])("uses server language across birthday displays ($language)", async ({ language, nextTitle, listTitle, birthday, set }) => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const record = { userId: "member", month: 8, day: 17, birthYear: 1999 };
    const store = { getBirthday: vi.fn().mockResolvedValue(record), listAllForGuild: vi.fn().mockResolvedValue([record]), setBirthday: vi.fn().mockResolvedValue(undefined) } as unknown as BirthdayStore;
    const profiles = { find: vi.fn().mockReturnValue({ timezone: "UTC", language }) } as unknown as GuildConfigurationProvider;
    const command = new BirthdayCommand(store, profiles);
    for (const subcommand of ["view", "next", "list", "set"]) {
      const reply = vi.fn();
      await command.execute(contextFor(subcommand, subcommand === "set" ? { month: 8, day: 17 } : {}, false, reply));
      const payload = reply.mock.calls[0]![0] as { content: string };
      if (subcommand === "view" || subcommand === "next") {
        expect(payload.content).toContain(birthday);
        expect(payload.content).toContain("2027年8月17日");
      }
      if (subcommand === "next") expect(payload.content).toContain(nextTitle);
      if (subcommand === "list") expect(payload.content).toContain(listTitle);
      if (subcommand === "set") expect(payload.content).toContain(set);
      expect(payload.content).not.toContain("August");
    }
  });
  it.each([true, false])("only administrators can set another member's details (%s)", async (admin) => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const store = { setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore;
    const profiles = { find: vi.fn().mockReturnValue({ timezone: "UTC", roles: { botAdministrator: new Set(["admin"]) } }) } as unknown as GuildConfigurationProvider;
    await new BirthdayCommand(store, profiles).execute(contextFor("set", { user: { id: "target" }, month: 8, day: 17, year: 1999 }, admin, vi.fn()));
    if (admin) expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild", "target", 8, 17, { birthYear: 1999 });
    else expect(setBirthday).not.toHaveBeenCalled();
  });
  it("stores a supplied year and personal message for the caller", async () => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const store = { setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore;
    const profiles = { find: vi.fn().mockReturnValue({ timezone: "UTC" }) } as unknown as GuildConfigurationProvider;
    const reply = vi.fn().mockResolvedValue(undefined);
    await new BirthdayCommand(store, profiles).execute(contextFor("set", { month: 8, day: 17, year: 1999, message: "Happy {birthday}!" }, false, reply));
    expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild", "self", 8, 17, { birthYear: 1999, message: "Happy {birthday}!" });
    expect(reply.mock.calls[0]![0]).toMatchObject({ content: "Your birthday is set to August 17." });
  });

  it("uses explicit clear options to remove personal details", async () => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const store = { setBirthday, getBirthday: vi.fn().mockResolvedValue({ birthYear: 1999, message: "custom" }) } as unknown as BirthdayStore;
    const profiles = { find: vi.fn().mockReturnValue({ timezone: "UTC" }) } as unknown as GuildConfigurationProvider;
    await new BirthdayCommand(store, profiles).execute(contextFor("set", { month: 8, day: 17, "clear-year": true, "clear-message": true }, false, vi.fn()));
    expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild", "self", 8, 17, { birthYear: null, message: null });
  });

  it.each([true, false])("only administrators can change the shared message (%s)", async (admin) => {
    const update = vi.fn().mockResolvedValue(undefined);
    const profiles = { find: vi.fn().mockReturnValue({ roles: { botAdministrator: new Set(["admin"]) } }), update } as unknown as GuildConfigurationProvider;
    await new BirthdayCommand({} as BirthdayStore, profiles).execute(contextFor("template", { message: "Happy {birthday}, {member}!" }, admin, vi.fn()));
    if (admin) expect(update).toHaveBeenCalledExactlyOnceWith("guild", { birthdayMessageTemplate: "Happy {birthday}, {member}!" });
    else expect(update).not.toHaveBeenCalled();
  });

  it("shows the age on the next birthday and the exact countdown", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const record = { userId: "member", month: 8, day: 17, birthYear: 1999 };
    const store = { getBirthday: vi.fn().mockResolvedValue(record) } as unknown as BirthdayStore;
    const profiles = { find: vi.fn().mockReturnValue({ timezone: "UTC" }) } as unknown as GuildConfigurationProvider;
    const reply = vi.fn();
    await new BirthdayCommand(store, profiles).execute(contextFor("view", { user: { id: "member" } }, false, reply));
    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toContain("28th birthday** is in **317** days, on **17 August 2027");
  });
});
