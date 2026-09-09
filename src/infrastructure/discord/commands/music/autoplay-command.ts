import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";
export class AutoplayCommand implements BotCommand {
  public readonly definition = {
    name: "autoplay",
    description: "Toggles automatic related-track queueing.",
  };
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck, context.access.allowQueueWithoutVoiceChannel);
    const enabled = await this.playbackService.toggleAutoQueue(actor);
    await context.responses.reply(`Autoqueue ${enabled ? "enabled" : "disabled"}.`);
  }
}
