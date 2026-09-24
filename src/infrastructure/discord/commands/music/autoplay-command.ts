import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";
export class AutoplayCommand implements BotCommand {
  public readonly definition = {
    name: "autoplay",
    description: "Toggles automatic related-track queueing.",
  };
  public readonly helpDetails = [
    "When the queue runs out, a similar track is added (same as the panel's ♾️ Autoqueue button).",
    "**Vote:** while a song plays with nothing queued after it, an 🗳️ Up next message lets listeners in the voice channel pick the next track.",
    "• Most votes wins. With no votes (or a tie), the ▶ option plays.",
    "• Click your pick again to take your vote back.",
    "• 🎲 Similar and 🎙️ *Artist* swap in new options (3 per song; votes reset).",
    "• 🎤 means synced lyrics were found ahead of time.",
    "• Voting 🔒 locks 10s before the song ends. No vote if under 30s are left.",
    "Admins: `/settings-music autoqueue-vote` turns the vote off, or sets the option count (2–6) and bar style.",
  ];
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck, context.access.allowQueueWithoutVoiceChannel);
    const enabled = await this.playbackService.toggleAutoQueue(actor);
    await context.responses.reply(enabled ? context.text.music.reply.autoqueueEnabled : context.text.music.reply.autoqueueDisabled);
  }
}
