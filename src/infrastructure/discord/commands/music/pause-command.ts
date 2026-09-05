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
import {
  createPlaybackActor,
  musicPlaybackAccessPolicy,
  withDjBypass,
} from "./music-command-support.js";

export class PauseCommand implements BotCommand {
  public readonly definition = {
    name: "pause",
    description: "Pauses the current track.",
  };

  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public readonly toolBinding: ChatToolBinding = {
    name: "pause_music",
    description: "Pauses the currently playing track.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
    execute: (_args, ctx) => this.executeAsTool(ctx),
  };

  public constructor(
    private readonly playbackService: PlaybackService,
    private readonly profiles: GuildConfigurationProvider,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("Music commands are only available in a server.");
      return;
    }

    await this.playbackService.pause(createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck));
    await context.responses.reply("Playback paused.");
  }

  private async executeAsTool(ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music) return { content: musicPermissionDeniedMessage };
    const decision = evaluateMusicToolAccess(ctx, ctx.music, this.profiles);
    if (!decision.allowed) return { content: musicPermissionDeniedMessage };
    if (musicToolWasCancelled(ctx)) return { content: musicToolTimedOutMessage };
    try {
      await this.playbackService.pause(withDjBypass(ctx.music.actor, decision.bypassVoiceChannelCheck));
      return { content: "Playback paused." };
    } catch (error) {
      return { content: formatMusicError(error, "Couldn't pause playback right now.") };
    }
  }
}
