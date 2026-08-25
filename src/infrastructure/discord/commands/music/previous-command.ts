import { CommandModule, type BotCommand, type ChatToolBinding, type CommandContext } from "../../../../application/commands/command.js";
import type { ChatToolContext, ChatToolResult } from "../../../../application/chat/tools/chat-tool.js";
import {
  evaluateMusicToolAccess,
  formatMusicError,
  musicPermissionDeniedMessage,
  musicToolTimedOutMessage,
  musicToolWasCancelled,
} from "../../../../application/chat/tools/music-tool-support.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class PreviousCommand implements BotCommand {
  public readonly definition = {
    name: "previous",
    description: "Plays the previous track.",
  };
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public readonly toolBinding: ChatToolBinding = {
    name: "previous_music",
    description: "Goes back and plays the previous track.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
    execute: (_args, ctx) => this.executeAsTool(ctx),
  };

  public constructor(
    private readonly playbackService: PlaybackService,
    private readonly profiles: GuildConfigurationProvider,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    await this.playbackService.previous(createPlaybackActor(context.interaction));
    await context.responses.reply("Playing the previous track.");
  }

  private async executeAsTool(ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music) return { content: musicPermissionDeniedMessage };
    const decision = evaluateMusicToolAccess(ctx, ctx.music, this.profiles);
    if (!decision.allowed) return { content: musicPermissionDeniedMessage };
    if (musicToolWasCancelled(ctx)) return { content: musicToolTimedOutMessage };
    try {
      await this.playbackService.previous(ctx.music.actor);
      return { content: "Playing the previous track." };
    } catch (error) {
      return { content: formatMusicError(error, "Couldn't go back a track right now.") };
    }
  }
}
