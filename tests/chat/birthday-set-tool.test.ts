import { describe, expect, it, vi } from "vitest";

import { BirthdaySetTool } from "../../src/application/chat/tools/birthday-set-tool.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";
import type { BirthdayStore } from "../../src/application/birthdays/birthday-store.js";

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
  it("saves a valid date only for the current user in the current guild", async () => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const tool = new BirthdaySetTool({ setBirthday } as unknown as BirthdayStore);

    const result = await tool.execute({ month: 2, day: 29 }, context());

    expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild-1", "speaker-1", 2, 29);
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
    const tool = new BirthdaySetTool({ setBirthday } as unknown as BirthdayStore);

    const result = await tool.execute(date, context());

    expect(setBirthday).not.toHaveBeenCalled();
    expect(result.content).toContain("nothing was saved");
  });

  it("does not write after the tool call times out", async () => {
    const setBirthday = vi.fn();
    const tool = new BirthdaySetTool({ setBirthday } as unknown as BirthdayStore);
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ month: 5, day: 4 }, context(controller.signal));

    expect(setBirthday).not.toHaveBeenCalled();
    expect(result.content).toContain("nothing was saved");
  });

  it("does not claim success when storage fails", async () => {
    const setBirthday = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const tool = new BirthdaySetTool({ setBirthday } as unknown as BirthdayStore);

    const result = await tool.execute({ month: 5, day: 4 }, context());

    expect(result.content).toContain("Could not save");
  });
});
