import type { Guild, GuildEmoji } from "discord.js";

import type { CommandContext } from "../../../../../application/commands/command.js";
import type { CommandOptionChoice } from "../../../../../application/commands/command-metadata.js";
import { renderProgressBar } from "../../../../../application/control-panel/progress-bar-renderer.js";
import type {
  CustomProgressBarTheme,
  GuildConfiguration,
  ProgressBarEmojiReference,
  ProgressBarSettings,
  ProgressBarStyle,
} from "../../../../../config/guild-configuration.js";
import type { ApplicationEmojiCatalog } from "../../../application-emoji-catalog.js";

// Shared helpers used by more than one setting definition. Plain exported
// functions rather than a class — none of them need anything beyond what's
// already passed as arguments.

export function formatChannelList(channelIds: ReadonlySet<string>): string {
  return channelIds.size === 0 ? "none" : [...channelIds].map((id) => `<#${id}>`).join(", ");
}

// SettingsCommand.describeFieldChanges renders a FieldChange's `read()`
// result with a plain String(...) — a raw channel id would show as an
// unlinked number instead of a clickable channel mention, so a single
// optional-channel FieldChange should format through this rather than
// returning the raw id/null directly.
export function formatChannelMention(channelId: string | null): string {
  return channelId ? `<#${channelId}>` : "none";
}

export function setsDiffer(previous: ReadonlySet<string>, updated: ReadonlySet<string>): boolean {
  return previous.size !== updated.size || [...previous].some((id) => !updated.has(id));
}

// Shared choice set for the "which role group" string option — reused by
// role-membership-setting.ts's role-add/role-remove.
export const roleGroupChoices: readonly CommandOptionChoice[] = [
  { name: "Bot administrator (/settings)", value: "botAdministrator" },
  { name: "Music controller (/play, panel, control channel)", value: "musicController" },
  { name: "Restricted (deny music and chatbot)", value: "restricted" },
  { name: "Chatbot (mention replies)", value: "chatbot" },
];

export function validateRoleGroupUpdate(
  profile: GuildConfiguration,
  group: "botAdministrator" | "musicController" | "restricted" | "chatbot",
  nextRoleIds: ReadonlySet<string>,
): string | null {
  if (group === "botAdministrator" && nextRoleIds.size === 0) {
    return "At least one bot-administrator role must remain configured.";
  }
  if (group === "musicController" && profile.features.music && nextRoleIds.size === 0) {
    return "Music is enabled, so at least one music-controller role must remain configured.";
  }
  if (group === "chatbot" && profile.features.chatbot && nextRoleIds.size === 0) {
    return "Chatbot is enabled, so at least one chatbot role must remain configured (or disable the chatbot feature first).";
  }
  return null;
}

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

export async function buildProgressBarSettings(
  guild: Guild | null,
  context: CommandContext,
  current: ProgressBarSettings,
  applicationEmojiCatalog: ApplicationEmojiCatalog,
): Promise<ProgressBarSettings | null> {
  const style = context.interaction.options.getString("progress-style") as ProgressBarStyle | null;
  const length = context.interaction.options.getInteger("progress-length");
  const values = {
    completed: context.interaction.options.getString("progress-completed"),
    remaining: context.interaction.options.getString("progress-remaining"),
    playing: context.interaction.options.getString("progress-playing"),
    paused: context.interaction.options.getString("progress-paused"),
    ending: context.interaction.options.getString("progress-ending"),
  };
  const hasCustomInput = Object.values(values).some((value) => value !== null);
  if (!style && length === null && !hasCustomInput) return null;

  let customTheme = current.customTheme;
  if (hasCustomInput) {
    if (!guild) throw new Error("Custom progress emojis can only be configured in a server.");
    const emojis = await guild.emojis.fetch();
    const requiredKeys = ["completed", "remaining", "playing", "paused"] as const;
    const resolved = { ...customTheme } as Partial<CustomProgressBarTheme>;
    for (const key of requiredKeys) {
      const value = values[key];
      if (value) resolved[key] = resolveGuildEmoji(guild.id, emojis.values(), value);
    }
    if (values.ending) {
      resolved.ending = values.ending.toLowerCase() === "none"
        ? null
        : resolveGuildEmoji(guild.id, emojis.values(), values.ending);
    }
    const missing = requiredKeys.filter((key) => !resolved[key]);
    if (missing.length > 0) {
      throw new Error(`A custom theme still needs: ${missing.join(", ")}.`);
    }
    customTheme = {
      completed: resolved.completed!,
      remaining: resolved.remaining!,
      playing: resolved.playing!,
      paused: resolved.paused!,
      ending: resolved.ending ?? null,
    };
  }

  const nextStyle = style ?? (hasCustomInput ? "custom" : current.style);
  if (nextStyle === "yohta" && !applicationEmojiCatalog.getYohtaTheme()) {
    throw new Error(
      `The Yohta preset is not provisioned for this bot application. Missing: ${applicationEmojiCatalog.getMissingYohtaEmojiNames().join(", ")}.`,
    );
  }
  if (nextStyle === "custom" && !customTheme) {
    throw new Error("Configure completed, remaining, playing, and paused emojis before selecting custom.");
  }
  return {
    style: nextStyle,
    length: length ?? current.length,
    customTheme,
  };
}
