import { PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { CommandContext } from "../../src/application/commands/command.js";
import type { PlaybackService } from "../../src/application/music/playback-service.js";
import { RoleMatchMode } from "../../src/domain/access/access-policy.js";
import { PlayCommand } from "../../src/infrastructure/discord/commands/music/play-command.js";

const targetChannelId = "999999999999999999";

function buildContext(memberPermissionBits: bigint): {
  context: CommandContext;
  reply: ReturnType<typeof vi.fn>;
  defer: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn().mockResolvedValue(undefined);
  const defer = vi.fn().mockResolvedValue(undefined);
  const context = {
    interaction: {
      inCachedGuild: () => true,
      guildId: "guild-id",
      channelId: "text-channel-id",
      user: { id: "user-id" },
      member: {
        permissionsIn: () => new PermissionsBitField(memberPermissionBits),
        voice: { channelId: null },
      },
      options: {
        getString: () => "some song",
        getChannel: () => ({ id: targetChannelId }),
      },
    },
    responses: { reply, defer, edit: vi.fn(), deleteAfter: vi.fn() },
    access: { bypassVoiceChannelCheck: false },
  } as unknown as CommandContext;
  return { context, reply, defer };
}

describe("PlayCommand", () => {
  it("requires the music-controller role group", () => {
    const command = new PlayCommand({} as never, {} as never);

    expect(command.access.roles).toEqual({
      match: RoleMatchMode.Any,
      requiredGroups: ["musicController"],
    });
  });

  it("refuses to target a voice channel the invoking member can't access", async () => {
    const enqueue = vi.fn();
    const command = new PlayCommand({ enqueue } as unknown as PlaybackService, {} as never);
    const { context, reply, defer } = buildContext(
      new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]).bitfield,
    );

    await command.execute(context);

    expect(reply).toHaveBeenCalledWith("You don't have access to that voice channel.");
    expect(defer).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("proceeds when the invoking member can view and connect to the target channel", async () => {
    const enqueue = vi.fn(() => Promise.resolve({
      firstTrack: { title: "Affection", author: "Jinsang" },
      addedTrackCount: 1,
      startedPlayback: true,
      queuePosition: null,
    }));
    const profiles = { require: (): { embedColor: string } => ({ embedColor: "#3B82F6" }) };
    const command = new PlayCommand({ enqueue } as unknown as PlaybackService, profiles as never);
    const { context, reply, defer } = buildContext(
      new PermissionsBitField([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
      ]).bitfield,
    );

    await command.execute(context);

    expect(reply).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
