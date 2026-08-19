import type { SlashCommandSubcommandBuilder } from "discord.js";

import type { CommandContext } from "../../../../../application/commands/command.js";
import type { GuildAssetStore } from "../../../../../application/assets/guild-asset-store.js";
import type { AuditLogService } from "../../../../../application/audit/audit-log-service.js";
import type { GuildConfiguration } from "../../../../../config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../../../../config/guild-configuration-provider.js";
import type { ApplicationEmojiCatalog } from "../../../application-emoji-catalog.js";

export type SettingHandlerResult = { ok: true } | { ok: false; message: string };

export interface SettingDeps {
  assets: GuildAssetStore;
  applicationEmojiCatalog: ApplicationEmojiCatalog;
  auditLogService?: AuditLogService;
}

export interface FieldChange {
  label: string;
  read(profile: GuildConfiguration): unknown;
}

interface BaseSettingDefinition {
  name: string;
  description: string;
  configureOptions?(builder: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder;
}

// A setting that patches the guild config. `handle` mutates `input` in place
// (the same accumulation pattern SettingsCommand.execute() already used) and
// returns an error to abort before any write, or ok to proceed.
export interface MutationSettingDefinition extends BaseSettingDefinition {
  kind: "mutation";
  handle(
    context: CommandContext,
    deps: SettingDeps,
    previousProfile: GuildConfiguration,
    input: UpdateGuildConfigurationInput,
  ): Promise<SettingHandlerResult>;
  // Default confirmation text: whichever of these fields actually changed.
  fieldChanges?: readonly FieldChange[];
  // Full override for settings whose confirmation isn't a plain field diff
  // (roles, panel, chatbot's role-change branch). Returning null falls back
  // to the fieldChanges diff (if any).
  describe?(previous: GuildConfiguration, updated: GuildConfiguration, input: UpdateGuildConfigurationInput): string | null;
  // Extra lines appended after the fieldChanges diff (not a full replacement
  // like describe()) — for changes that aren't a simple scalar diff, e.g.
  // link-fix's watched-channel set.
  extraLines?(previous: GuildConfiguration, updated: GuildConfiguration): readonly string[];
}

// A setting that only reads and replies — never touches config (access, audit).
export interface ReadOnlySettingDefinition extends BaseSettingDefinition {
  kind: "readOnly";
  run(context: CommandContext, deps: SettingDeps, profile: GuildConfiguration): Promise<string>;
}

export type SettingDefinition = MutationSettingDefinition | ReadOnlySettingDefinition;
