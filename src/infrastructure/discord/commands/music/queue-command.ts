import { EmbedBuilder } from "discord.js";

import { CommandModule, type BotCommand, type ChatToolBinding, type CommandContext } from "../../../../application/commands/command.js";
import type { ChatToolContext, ChatToolResult } from "../../../../application/chat/tools/chat-tool.js";
import { evaluateMusicToolAccess, musicPermissionDeniedMessage } from "../../../../application/chat/tools/music-tool-support.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

const maxQueueTracksReturnedToTool = 10;

export class QueueCommand implements BotCommand {
  public readonly definition = {
    name: "queue",
    description: "Views or manages the music queue.",
    subcommands: [
      { name: "show", description: "Shows queued tracks." },
      {
        name: "remove",
        description: "Removes a queued track by position.",
        options: [
          { type: "integer", name: "position", description: "Queue position, starting at 1.", minValue: 1, required: true },
        ],
      },
      { name: "clear", description: "Clears every upcoming track." },
      { name: "history", description: "Shows recently played tracks." },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public readonly toolBinding: ChatToolBinding<Record<string, never>> = {
    name: "view_music_queue",
    description: "Shows what's currently playing and what's queued up next.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
    execute: (_args, ctx) => this.executeAsTool(ctx),
  };

  public constructor(
    private readonly playbackService: PlaybackService,
    private readonly profiles: GuildConfigurationProvider,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const action = context.interaction.options.getSubcommand(true);
    if (action === "remove") {
      const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck, context.access.allowQueueWithoutVoiceChannel);
      const track = await this.playbackService.removeQueueTrack(
        actor,
        context.interaction.options.getInteger("position", true),
      );
      await context.responses.reply(`Removed **${track.title}** from the queue.`);
      return;
    }
    if (action === "clear") {
      const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck, context.access.allowQueueWithoutVoiceChannel);
      const count = await this.playbackService.clearQueue(actor);
      await context.responses.reply(`Cleared ${count} queued track${count === 1 ? "" : "s"}.`);
      return;
    }
    if (action === "history") {
      const history = this.playbackService.getPlayHistory(context.interaction.guildId);
      const description = history.length === 0
        ? "Nothing has played in this server yet."
        : history.map((track, index) => `${index + 1}. **${track.title}** — ${track.author}`).join("\n");
      const embed = new EmbedBuilder().setTitle("Recently played").setDescription(description);
      await context.responses.reply({ embeds: [embed] });
      return;
    }

    const tracks = this.playbackService.getQueue(context.interaction.guildId);
    const description = tracks.length === 0
      ? "There are no upcoming tracks."
      : tracks.slice(0, 20).map((track, index) => `${index + 1}. **${track.title}** — ${track.author}`).join("\n");
    const embed = new EmbedBuilder().setTitle("Music queue").setDescription(description);
    if (tracks.length > 20) embed.setFooter({ text: `Showing 20 of ${tracks.length} tracks` });
    await context.responses.reply({ embeds: [embed] });
  }

  private executeAsTool(ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music) return Promise.resolve({ content: musicPermissionDeniedMessage });
    const decision = evaluateMusicToolAccess(ctx, ctx.music, this.profiles);
    if (!decision.allowed) return Promise.resolve({ content: musicPermissionDeniedMessage });
    const snapshot = this.playbackService.getSnapshot(ctx.music.actor.guildId);
    if (!snapshot) return Promise.resolve({ content: "Nothing is playing right now." });
    const queue = this.playbackService.getQueue(ctx.music.actor.guildId).slice(0, maxQueueTracksReturnedToTool);
    return Promise.resolve({
      content: JSON.stringify({
        playing: snapshot.playing,
        paused: snapshot.paused,
        volume: snapshot.volume,
        currentTrack: snapshot.currentTrack
          ? { title: snapshot.currentTrack.title, author: snapshot.currentTrack.author }
          : null,
        queueLength: snapshot.queueLength,
        upNext: queue.map((track) => ({ title: track.title, author: track.author })),
      }),
    });
  }
}
