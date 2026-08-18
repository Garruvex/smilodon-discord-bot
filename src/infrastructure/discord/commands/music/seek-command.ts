import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

const timestampPattern = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/;
const shorthandPattern = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i;

function parseTimeToMs(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  const timestampMatch = timestampPattern.exec(trimmed);
  if (timestampMatch) {
    const hours = Number(timestampMatch[1] ?? 0);
    const minutes = Number(timestampMatch[2]);
    const seconds = Number(timestampMatch[3]);
    return ((hours * 60 + minutes) * 60 + seconds) * 1_000;
  }

  const shorthandMatch = shorthandPattern.exec(trimmed);
  if (shorthandMatch && (shorthandMatch[1] ?? shorthandMatch[2] ?? shorthandMatch[3])) {
    const hours = Number(shorthandMatch[1] ?? 0);
    const minutes = Number(shorthandMatch[2] ?? 0);
    const seconds = Number(shorthandMatch[3] ?? 0);
    return ((hours * 60 + minutes) * 60 + seconds) * 1_000;
  }

  return null;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export class SeekCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Seeks to a specific time in the current track.")
    .addStringOption((option) => option
      .setName("time")
      .setDescription("Time to seek to, e.g. 90, 1:30, or 1h2m3s.")
      .setRequired(true));
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const rawTime = context.interaction.options.getString("time", true);
    const positionMs = parseTimeToMs(rawTime);
    if (positionMs === null) {
      await context.responses.reply("Couldn't parse that time. Try `90`, `1:30`, or `1h2m3s`.");
      return;
    }

    const track = await this.playbackService.seek(createPlaybackActor(context.interaction), positionMs);
    await context.responses.reply(`Seeked to **${formatDuration(positionMs)}** in **${track.title}**.`);
  }
}
