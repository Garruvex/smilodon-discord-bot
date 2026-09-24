import type { CommandOptionChoice } from "../../../../application/commands/command-metadata.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";

// Shared helpers used by more than one setting definition. Plain exported
// functions rather than a class — none of them need anything beyond what's
// already passed as arguments.

export function formatChannelList(channelIds: ReadonlySet<string>): string {
  return channelIds.size === 0 ? "none" : [...channelIds].map((id) => `<#${id}>`).join(", ");
}

// SettingsEngine's field-diff confirmation renders a FieldChange's `read()`
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
