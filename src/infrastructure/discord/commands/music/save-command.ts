import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { musicPlaybackAccessPolicy } from "./music-command-support.js";

export class SaveCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("save")
    .setDescription("DMs you a link to the currently playing track.");

  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const snapshot = this.playbackService.getSnapshot(context.interaction.guildId);
    const track = snapshot?.currentTrack;
    if (!track) {
      await context.responses.reply("Nothing is playing right now.");
      return;
    }

    try {
      await context.interaction.user.send(
        `🎵 **${track.title}** — ${track.author}\n${track.uri}`,
      );
      await context.responses.reply("Sent you a DM with the current track.");
    } catch {
      await context.responses.reply("Couldn't DM you — check that your DMs are open for this server.");
    }
  }
}
