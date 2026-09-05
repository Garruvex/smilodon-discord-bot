import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class ReplayCommand implements BotCommand {
  public readonly definition = {
    name: "replay",
    description: "Restarts the current track from the beginning.",
  };
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck);
    const track = await this.playbackService.replay(actor);
    await context.responses.reply(`Replaying **${track.title}** — ${track.author}.`);
  }
}
