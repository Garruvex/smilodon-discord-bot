import type { Guild, GuildEmoji } from "discord.js";

import { renderProgressBar } from "../../../../application/control-panel/progress-bar-renderer.js";
import type {
  CustomProgressBarTheme,
  ProgressBarEmojiReference,
  ProgressBarSettings,
} from "../../../../config/guild-configuration.js";
import type { ApplicationEmojiCatalog } from "../../application-emoji-catalog.js";

// A sample bar, shown after a progress-bar change so the admin sees it.
export function renderProgressPreview(
  settings: ProgressBarSettings,
  applicationEmojiCatalog: ApplicationEmojiCatalog,
): string {
  return renderProgressBar({
    positionMs: 158_000,
    durationMs: 224_000,
    paused: false,
    isStream: false,
    settings,
    presetTheme: applicationEmojiCatalog.getYohtaTheme(),
  });
}

// A pasted emoji (<:name:id>) or a bare server emoji name, resolved against
// the guild's own emojis.
export function resolveGuildEmoji(
  guildId: string,
  emojis: IterableIterator<GuildEmoji>,
  input: string,
): ProgressBarEmojiReference {
  const all = [...emojis];
  const mention = input.trim().match(/^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/);
  const normalizedName = input.trim().replace(/^:|:$/g, "");
  const emoji = mention
    ? all.find((candidate) => candidate.id === mention[3])
    : all.find((candidate) => candidate.name === normalizedName);
  if (!emoji || emoji.guild.id !== guildId) {
    throw new Error(`Emoji "${input}" was not found in this server.`);
  }
  if (!emoji.available) throw new Error(`Emoji "${emoji.name}" is currently unavailable.`);
  return {
    id: emoji.id,
    name: emoji.name ?? normalizedName,
    animated: emoji.animated ?? false,
    scope: "guild",
    guildId,
  };
}

export interface CustomEmojiInput {
  completed: string | null;
  remaining: string | null;
  playing: string | null;
  paused: string | null;
  // "none" removes the ending emoji.
  ending: string | null;
}

// The custom progress theme after applying the given emojis over the
// current one. Throws a readable error for an unknown emoji or a theme that
// still lacks a required part.
export async function customProgressTheme(
  guild: Guild,
  current: CustomProgressBarTheme | null,
  input: CustomEmojiInput,
): Promise<CustomProgressBarTheme> {
  const emojis = await guild.emojis.fetch();
  const requiredKeys = ["completed", "remaining", "playing", "paused"] as const;
  const resolved: Partial<CustomProgressBarTheme> = { ...current };
  for (const key of requiredKeys) {
    const value = input[key];
    if (value) resolved[key] = resolveGuildEmoji(guild.id, emojis.values(), value);
  }
  if (input.ending) {
    resolved.ending = input.ending.toLowerCase() === "none"
      ? null
      : resolveGuildEmoji(guild.id, emojis.values(), input.ending);
  }
  const missing = requiredKeys.filter((key) => !resolved[key]);
  if (missing.length > 0) throw new Error(`A custom theme still needs: ${missing.join(", ")}.`);
  return {
    completed: resolved.completed!,
    remaining: resolved.remaining!,
    playing: resolved.playing!,
    paused: resolved.paused!,
    ending: resolved.ending ?? null,
  };
}
