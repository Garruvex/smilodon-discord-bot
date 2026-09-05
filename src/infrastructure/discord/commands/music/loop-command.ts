import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { MusicRepeatMode } from "../../../../application/music/music-player-gateway.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class LoopCommand implements BotCommand {
  public readonly definition = {
    name: "loop",
    description: "Sets the playback repeat mode.",
    options: [
      {
        type: "string",
        name: "mode",
        description: "Repeat mode.",
        required: true,
        choices: [
          { name: "Off", value: "off" },
          { name: "Current track", value: "track" },
          { name: "Queue", value: "queue" },
        ],
      },
    ],
  } satisfies BotCommand["definition"];
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const mode = context.interaction.options.getString("mode", true) as MusicRepeatMode;
    const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck);
    await this.playbackService.setRepeatMode(actor, mode);
    await context.responses.reply(`Repeat mode set to **${mode}**.`);
  }
}
