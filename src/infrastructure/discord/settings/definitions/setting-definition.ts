import type { ChatInputCommandInteraction, Guild, InteractionEditReplyOptions } from "discord.js";

import type { CommandOptionMetadata } from "../../../../application/commands/command-metadata.js";
import type { GuildAssetStore } from "../../../../application/assets/guild-asset-store.js";
import type { AuditLogService } from "../../../../application/audit/audit-log-service.js";
import type { ChatToolRegistry } from "../../../../application/chat/tools/chat-tool-registry.js";
import type { PersonaDriftStore } from "../../../../application/chat/persona-drift-store.js";
import type { ChannelSummaryCheckpointStore } from "../../../../application/context/channel-summary-checkpoint-store.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../../../config/guild-configuration-provider.js";
import type { ApplicationEmojiCatalog } from "../../application-emoji-catalog.js";

// The option values a setting reads, with the same getters (and required
// overloads) as a slash command's options. The slash command passes its
// interaction.options straight through; the admin panel builds one from a
// button, select or modal submit — so every setting's handle() runs
// unchanged whichever surface the change came from.
export type SettingValues = Pick<
  ChatInputCommandInteraction["options"],
  "getBoolean" | "getInteger" | "getString" | "getChannel" | "getRole" | "getAttachment"
> & {
  // Whole-list values from the panel's multi-selects (see
  // PanelListOptionMetadata). Absent on the slash surface, which never has
  // list options — handlers read it as `values.getIdList?.(name) ?? null`.
  getIdList?(name: string): readonly string[] | null;
};

export interface SettingRequest {
  guildId: string;
  // Null only when the guild isn't cached; settings that need it (custom
  // progress emojis) reject in that case.
  guild: Guild | null;
  actorUserId: string;
  values: SettingValues;
}

// extraLines here is for confirmation content only `handle` can know (e.g.
// GuildAssetStore.savePersonality's lore-classification summary) — distinct
// from MutationSettingDefinition.extraLines, which is a pure function of
// previous/updated config and can't see handle-time results like this.
export type SettingHandlerResult = { ok: true; extraLines?: readonly string[] } | { ok: false; message: string };

export interface SettingDeps {
  assets: GuildAssetStore;
  applicationEmojiCatalog: ApplicationEmojiCatalog;
  auditLogService?: AuditLogService;
  // Bound after construction (see SettingsEngine.bindChatToolRegistry) —
  // the registry can't exist until every command (including music's
  // toolBinding-carrying ones) is registered, which happens after
  // the /settings-* commands themselves are constructed. Used by tools-setting.ts to
  // validate/list tool names against the live registry.
  chatToolRegistry?: ChatToolRegistry;
  // Absent when no chat provider is configured at all — see
  // bootstrap/dependencies.ts. chatbot-setting.ts's reset-persona-drift
  // option no-ops in that case, same as any other chat feature would.
  personaDriftStore?: PersonaDriftStore;
  // Used by channel-context-setting.ts's context-status to show per-channel
  // scan/daily run state (last run time, cursor, lastError) alongside the
  // config lists — checkpoints live outside GuildConfiguration.
  channelSummaryCheckpointStore?: ChannelSummaryCheckpointStore;
  // False (or absent) when no chat provider is configured, or the
  // configured one doesn't implement summarizeChannelMessages — see
  // bootstrap/dependencies.ts's channelSummaryScheduler wiring. context-scan-add
  // and context-daily-add reject up front in that case instead of claiming a
  // channel is queued when nothing will ever process it.
  channelSummaryProviderAvailable?: boolean;
}

export interface FieldChange {
  label: string;
  read(profile: GuildConfiguration): unknown;
}

// How an option appears on the admin panel. `read` returns the current value
// in the option's own terms — what you'd pass to the slash option to leave
// things as they are (seconds rather than stored ms, a choice's value, a
// channel id) — so the panel can show it and pre-fill edits from it. Options
// without `panel` stay slash-only (attachments, one-shot flags such as
// use-default-image or reset-persona-drift).
export interface OptionPanelMetadata {
  // Short row label, e.g. "DJ mode". The option's description is the
  // row's explanation.
  label: string;
  read(profile: GuildConfiguration): string | number | boolean | null;
}

export type SlashSettingOptionMetadata = CommandOptionMetadata & { panel?: OptionPanelMetadata };

// A list the slash side edits one item at a time (add/remove options) but
// the panel shows whole, as a multi-select. Never registered as a slash
// option; the handler reads it with values.getIdList, next to its
// add/remove logic and through the same validation.
export interface PanelListOptionMetadata {
  type: "channelList" | "roleList";
  name: string;
  description: string;
  guildTextOnly?: boolean;
  panel: {
    label: string;
    read(profile: GuildConfiguration): readonly string[];
  };
}

export type SettingOptionMetadata = SlashSettingOptionMetadata | PanelListOptionMetadata;

export function isPanelListOption(option: SettingOptionMetadata): option is PanelListOptionMetadata {
  return option.type === "channelList" || option.type === "roleList";
}

// The options the /settings-* command registers: panel-only list options
// dropped, panel metadata stripped.
export function slashOptionsOf(setting: SettingDefinition): readonly CommandOptionMetadata[] {
  return (setting.configureOptions?.() ?? [])
    .filter((option): option is SlashSettingOptionMetadata => !isPanelListOption(option))
    .map(({ panel: _panel, ...option }) => option);
}

interface BaseSettingDefinition {
  name: string;
  description: string;
  configureOptions?(): readonly SettingOptionMetadata[];
}

// A setting that patches the guild config. `handle` mutates `input` in place
// and returns an error to abort before any write, or ok to proceed — see
// SettingsEngine.run, which does the write.
export interface MutationSettingDefinition extends BaseSettingDefinition {
  kind: "mutation";
  handle(
    request: SettingRequest,
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
  // A plain string covers the common case (access/audit summaries); a full
  // InteractionEditReplyOptions lets a setting attach a file (e.g. sending a
  // starter personality.md/examples.md — see template-setting.ts) without
  // every other readOnly setting needing to know about that shape.
  run(request: SettingRequest, deps: SettingDeps, profile: GuildConfiguration): Promise<string | InteractionEditReplyOptions>;
  // Show run()'s output (with no option values) as a text block on the
  // admin panel. Only for settings whose output is a plain string.
  panelReport?: boolean;
}

export type SettingDefinition = MutationSettingDefinition | ReadOnlySettingDefinition;
