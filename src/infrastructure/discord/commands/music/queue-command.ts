import { EmbedBuilder } from "discord.js";

import { CommandModule, type BotCommand, type ChatToolBinding, type CommandContext } from "../../../../application/commands/command.js";
import type { ChatToolContext, ChatToolResult } from "../../../../application/chat/tools/chat-tool.js";
import { evaluateMusicToolAccess, musicPermissionDeniedMessage } from "../../../../application/chat/tools/music-tool-support.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { buildQueuePageView } from "../../music/queue-page-view.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";
import { isGuardedContext } from "../../../../application/chat/guarded-conversation-context.js";

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
      await context.responses.reply(context.text.music.reply.removed({ title: track.title }));
      return;
    }
    if (action === "clear") {
      const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck, context.access.allowQueueWithoutVoiceChannel);
      const count = await this.playbackService.clearQueue(actor);
      await context.responses.reply(
        count === 1 ? context.text.music.reply.clearedOne({ count }) : context.text.music.reply.clearedMany({ count }),
      );
      return;
    }
    if (action === "history") {
      const history = this.playbackService.getPlayHistory(context.interaction.guildId);
      const description = history.length === 0
        ? context.text.music.history.empty
        : history.map((track, index) => `${index + 1}. **${track.title}** — ${track.author}`).join("\n");
      const embed = new EmbedBuilder().setTitle(context.text.music.history.title).setDescription(description);
      await context.responses.reply({ embeds: [embed] });
      return;
    }

    const tracks = this.playbackService.getQueue(context.interaction.guildId);
    const profile = this.profiles.find(context.interaction.guildId);
    const view = buildQueuePageView(tracks, 0, (profile?.embedColor ?? "#3B82F6") as `#${string}`, context.text);
    await context.responses.reply({ embeds: [view.embed], components: view.components });
  }

  private async executeAsTool(ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music) return Promise.resolve({ content: musicPermissionDeniedMessage });
    const decision = evaluateMusicToolAccess(ctx, ctx.music, this.profiles);
    if (!decision.allowed) return Promise.resolve({ content: musicPermissionDeniedMessage });
    if (ctx.contextLease) {
      if (!isGuardedContext(ctx.contextLease)) return { content: "Music queue context is unavailable." };
      await ctx.beforeModelAttempt?.(); ctx.signal?.throwIfAborted();
      const content = await ctx.contextLease.resource({ kind: "music_queue", id: "current" });
      return { content: content ?? "The music queue is unavailable in this conversation's audience." };
    }
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

  public async readGuardedResource(ctx: ChatToolContext, eligible: (userId: string) => Promise<boolean>): Promise<string | null> {
    const profile = this.profiles.find(ctx.guildId);
    if (!profile?.features.music || ctx.signal?.aborted) return null;
    const snapshot = this.playbackService.getSnapshot(ctx.guildId);
    if (!snapshot) return JSON.stringify({ available: false });
    if (snapshot.guildId !== ctx.guildId || snapshot.textChannelId !== ctx.channelId) return null;
    const queue = this.playbackService.getQueue(ctx.guildId).slice(0, maxQueueTracksReturnedToTool);
    const current = snapshot.currentTrack;
    const actors = [...new Set([...queue, ...(current ? [current] : [])].map((track) => track.requestedByUserId).filter((id): id is string => !!id))];
    const admitted = new Set<string>();
    for (const id of actors) { ctx.signal?.throwIfAborted(); if (await eligible(id)) admitted.add(id); }
    const project = (track: { title: string; author: string }): { title: string; author: string } => ({ title: track.title.slice(0, 500), author: track.author.slice(0, 200) });
    const upNext = queue.filter((track) => admitted.has(track.requestedByUserId)).map(project);
    return JSON.stringify({ playing: snapshot.playing, paused: snapshot.paused, volume: snapshot.volume,
      currentTrack: current?.requestedByUserId && admitted.has(current.requestedByUserId) ? project(current) : null, upNext, visibleQueuedCount: upNext.length, complete: false });
  }
}
