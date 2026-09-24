import type { ChatInputCommandInteraction, Guild } from "discord.js";

import type { GuildAssetStore } from "../../../../application/assets/guild-asset-store.js";
import type { AuditLogService } from "../../../../application/audit/audit-log-service.js";
import type { PersonaDriftStore } from "../../../../application/chat/persona-drift-store.js";
import type { ChatToolRegistry } from "../../../../application/chat/tools/chat-tool-registry.js";
import type { ChannelSummaryCheckpointStore } from "../../../../application/context/channel-summary-checkpoint-store.js";
import type { Language } from "../../../../application/i18n/language.js";
import type { ApplicationEmojiCatalog } from "../../application-emoji-catalog.js";

// The option values a setting reads, with the same getters (and required
// overloads) as a slash command's options. The slash command passes its
// interaction.options straight through; the admin panel and guided setup
// build one from a button, select or form — so a setting runs the same
// whichever surface the change came from.
export type SettingValues = Pick<
  ChatInputCommandInteraction["options"],
  "getBoolean" | "getInteger" | "getString" | "getChannel" | "getRole" | "getAttachment"
> & {
  // A whole list from the panel's multi-selects. The slash surface never has
  // one: it sends a list as add/remove options instead.
  getIdList?(name: string): readonly string[] | null;
};

export interface SettingRequest {
  guildId: string;
  // Null only when the guild isn't cached; settings that need it (custom
  // progress emojis) reject in that case.
  guild: Guild | null;
  actorUserId: string;
  // The guild's language: confirmations and errors are written in it.
  language: Language;
  values: SettingValues;
}

// Services settings reach beyond the guild config.
export interface SettingDeps {
  assets: GuildAssetStore;
  applicationEmojiCatalog: ApplicationEmojiCatalog;
  auditLogService?: AuditLogService;
  // Bound after construction (see SettingsEngine.bindChatToolRegistry): the
  // registry can't exist until every command is registered, which happens
  // after the /settings-* commands are constructed.
  chatToolRegistry?: ChatToolRegistry;
  // Absent when no chat provider is configured.
  personaDriftStore?: PersonaDriftStore;
  // Per-channel scan/daily run state for the context-status report.
  channelSummaryCheckpointStore?: ChannelSummaryCheckpointStore;
  // False when no configured chat provider can summarize channels, so
  // history scans are refused up front instead of queued forever.
  channelSummaryProviderAvailable?: boolean;
  // Bound once the admin panel exists (see SettingsEngine.bindAdminPanel),
  // which needs the engine first.
  adminPanel?: AdminPanelRepair;
}

export interface AdminPanelRepair {
  // Reposts the whole panel; false when no panel channel is set.
  repair(guildId: string): Promise<boolean>;
}
