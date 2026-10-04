import { describe, expect, it, vi, type Mock } from "vitest";

import { BirthdaySetTool } from "../../src/application/chat/tools/birthday-set-tool.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";
import type { BirthdayStore } from "../../src/application/birthdays/birthday-store.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";

function profiles(enabled: boolean | null = true): { find: Mock<GuildConfigurationProvider["find"]> } {
  return {
    find: vi.fn<GuildConfigurationProvider["find"]>().mockReturnValue(enabled === null ? null : { features: { birthdays: enabled } } as GuildConfiguration),
  };
}

function context(signal?: AbortSignal): ChatToolContext {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    currentUser: { id: "speaker-1", displayName: "Speaker", roleNames: [] },
    channelIsNsfw: false,
    channelMode: "shared",
    isOwner: false,
    music: null,
    pendingGeneratedImages: [],
    ...(signal ? { signal } : {}),
  };
}

describe("BirthdaySetTool", () => {
  it("saves explicitly supplied personal details", async () => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const store = { setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore;
    const tool = new BirthdaySetTool(store, profiles());
    await tool.execute({ month: 8, day: 17, birthYear: 1999, message: "Happy {birthday}, {member}!" }, context());
    expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild-1", "speaker-1", 8, 17, { birthYear: 1999, message: "Happy {birthday}, {member}!" });
  });
  it("saves a valid date only for the current user in the current guild", async () => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const tool = new BirthdaySetTool({ setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore, profiles());

    const result = await tool.execute({ month: 2, day: 29 }, context());

    expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild-1", "speaker-1", 2, 29, {});
    expect(result.content).toContain("February 29");
  });

  it.each([
    { month: 0, day: 1 },
    { month: 13, day: 1 },
    { month: 4, day: 31 },
    { month: 2, day: 30 },
    { month: 1, day: 0 },
    { month: 1.5, day: 1 },
  ])("rejects invalid calendar date $month/$day", async (date) => {
    const setBirthday = vi.fn();
    const tool = new BirthdaySetTool({ setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore, profiles());

    const result = await tool.execute(date, context());

    expect(setBirthday).not.toHaveBeenCalled();
    expect(result.content).toContain("nothing was saved");
  });

  it("does not write after the tool call times out", async () => {
    const setBirthday = vi.fn();
    const tool = new BirthdaySetTool({ setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore, profiles());
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ month: 5, day: 4 }, context(controller.signal));

    expect(setBirthday).not.toHaveBeenCalled();
    expect(result.content).toContain("nothing was saved");
  });

  it("does not claim success when storage fails", async () => {
    const setBirthday = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const tool = new BirthdaySetTool({ setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore, profiles());

    const result = await tool.execute({ month: 5, day: 4 }, context());

    expect(result.content).toContain("Could not save");
  });

  it.each([false, null])("does not write when birthdays are disabled or the guild is unconfigured (%s)", async (enabled) => {
    const setBirthday = vi.fn();
    const configuration = profiles(enabled);
    const tool = new BirthdaySetTool({ setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore, configuration);

    const result = await tool.execute({ month: 5, day: 4 }, context());

    expect(configuration.find).toHaveBeenCalledWith("guild-1");
    expect(setBirthday).not.toHaveBeenCalled();
    expect(result.content).toContain("nothing was saved");
  });

  it("checks the current feature setting on every call", async () => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const configuration = profiles();
    const tool = new BirthdaySetTool({ setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore, configuration);

    await tool.execute({ month: 5, day: 4 }, context());
    configuration.find.mockReturnValue({ features: { birthdays: false } } as GuildConfiguration);
    const result = await tool.execute({ month: 6, day: 4 }, context());

    expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild-1", "speaker-1", 5, 4, {});
    expect(result.content).toContain("nothing was saved");
  });
});
