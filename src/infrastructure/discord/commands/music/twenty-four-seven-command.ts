import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";
export class TwentyFourSevenCommand implements BotCommand {
  public readonly definition = {
    name: "247",
    description: "Toggles persistent voice-channel mode.",
  };
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck);
    const enabled = await this.playbackService.toggleTwentyFourSeven(actor);
    await context.responses.reply(`24/7 mode ${enabled ? "enabled" : "disabled"}.`);
  }
}
