import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { isInGameChannel } from "../../src/infrastructure/discord/behaviors/game-channel-guard.js";

const message = (parentId: string | null = null): Message => ({
  inGuild: () => true,
  guildId: "g1",
  channelId: "c1",
  channel: { isThread: () => parentId !== null, parentId },
}) as unknown as Message;

describe("the D&D channel guard", () => {
  it("asks about the message's channel, and a thread's parent too", async () => {
    const lookup = vi.fn().mockResolvedValue(true);
    await expect(isInGameChannel(message(), lookup)).resolves.toBe(true);
    expect(lookup).toHaveBeenLastCalledWith("g1", ["c1"]);
    await isInGameChannel(message("forum1"), lookup);
    expect(lookup).toHaveBeenLastCalledWith("g1", ["c1", "forum1"]);
  });

  it("lets other channels through, and everything through when no lookup is wired", async () => {
    await expect(isInGameChannel(message(), () => Promise.resolve(false))).resolves.toBe(false);
    await expect(isInGameChannel(message(), null)).resolves.toBe(false);
  });

  it("fails closed: a failed lookup counts as a game channel", async () => {
    await expect(isInGameChannel(message(), () => Promise.reject(new Error("db down")))).resolves.toBe(true);
  });
});
