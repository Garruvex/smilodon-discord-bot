import { describe, expect, it, vi } from "vitest";

import { QueueCommand } from "../../src/infrastructure/discord/commands/music/queue-command.js";
import type { PlaybackService } from "../../src/application/music/playback-service.js";
import type { CommandContext } from "../../src/application/commands/command.js";

function makeContext(subcommand: string): { context: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(undefined);
  const context = {
    interaction: {
      inCachedGuild: () => true,
      guildId: "guild-id",
      options: { getSubcommand: () => subcommand, getInteger: () => 1 },
    },
    logger: {} as never,
    responses: { reply } as never,
  } as unknown as CommandContext;
  return { context, reply };
}

describe("QueueCommand", () => {
  it("shows recently played tracks for the history subcommand", async () => {
    const getPlayHistory = vi.fn().mockReturnValue([
      { identifier: "a", title: "Track A", author: "Artist A", uri: "https://example.com/a", artworkUrl: null, durationMs: 1000, isStream: false, requestedByUserId: "user", playedAt: 100 },
      { identifier: "b", title: "Track B", author: "Artist B", uri: "https://example.com/b", artworkUrl: null, durationMs: 1000, isStream: false, requestedByUserId: "user", playedAt: 50 },
    ]);
    const playbackService = { getPlayHistory } as unknown as PlaybackService;
    const command = new QueueCommand(playbackService);
    const { context, reply } = makeContext("history");

    await command.execute(context);

    expect(getPlayHistory).toHaveBeenCalledWith("guild-id");
    expect(reply).toHaveBeenCalledOnce();
    const [payload] = reply.mock.calls[0] as [{ embeds: Array<{ data: { description?: string } }> }];
    expect(payload.embeds[0]?.data.description).toContain("Track A");
    expect(payload.embeds[0]?.data.description).toContain("Track B");
  });

  it("reports when nothing has played yet", async () => {
    const playbackService = { getPlayHistory: vi.fn().mockReturnValue([]) } as unknown as PlaybackService;
    const command = new QueueCommand(playbackService);
    const { context, reply } = makeContext("history");

    await command.execute(context);

    const [payload] = reply.mock.calls[0] as [{ embeds: Array<{ data: { description?: string } }> }];
    expect(payload.embeds[0]?.data.description).toContain("Nothing has played");
  });
});
