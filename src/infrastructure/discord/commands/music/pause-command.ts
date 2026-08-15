import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import {
  createPlaybackActor,
  musicPlaybackAccessPolicy,
} from "./music-command-support.js";

export class PauseCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pauses the current track.");

  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("Music commands are only available in a server.");
      return;
    }

    await this.playbackService.pause(createPlaybackActor(context.interaction));
    await context.responses.reply("Playback paused.");
  }
}
