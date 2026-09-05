import type { GuildConfiguration, LinkFixPlatform, ProgressBarSettings } from "./guild-configuration.js";
import {
  guildConfigurationFileSchema,
  type ParsedGuildConfigurationFile,
} from "./guild-configuration-schema.js";

export interface UpdateGuildConfigurationInput {
  idleImageUrl?: string | null;
  idleImageAsset?: string | null;
  controlPanelChannelId?: string;
  auditLogChannelId?: string | null;
  progressBar?: ProgressBarSettings;
  botAdministratorRoleIds?: readonly string[];
  musicControllerRoleIds?: readonly string[];
  restrictedRoleIds?: readonly string[];
  chatbotRoleIds?: readonly string[];
  chatbotChannelIds?: readonly string[];
  chatbotEnabled?: boolean;
  chatbotPersonalityFile?: string | null;
  chatbotPersonalityAsset?: string | null;
  chatbotExamplesFile?: string | null;
  chatbotExamplesAsset?: string | null;
  chatbotCooldownSeconds?: number;
  chatbotDeniedMessage?: string;
  chatbotDeniedLinkUrl?: string | null;
  chatbotDeniedLinkLabel?: string | null;
  chatbotWebSearchMode?: "off" | "auto";
  chatbotToolCallingEnabled?: boolean;
  chatbotDisabledToolNames?: readonly string[];
  chatbotImageInputEnabled?: boolean;
  chatbotImageGenerationEnabled?: boolean;
  chatbotSelfReferenceImageAsset?: string | null;
  chatbotIncludeSources?: boolean;
  chatbotMaxImagesPerRequest?: number;
  ambientReplies?: boolean;
  ambientCooldownSeconds?: number;
  channelHistory?: boolean;
  channelHistoryLimit?: number;
  // Merged into the existing map (per-channel entries added/overwritten,
  // never wholesale-replaced) — same "add" semantics as chatbotChannelIds.
  chatbotChannelMemoryModes?: Readonly<Record<string, "shared" | "isolated" | "session_only" | "disabled">>;
  chatbotPersonaDriftEnabled?: boolean;
  // Explicit single-channel operations (not a list to merge/replace) — each
  // is applied centrally in applyGuildConfigurationUpdate, idempotently:
  // adding an already-present id or removing an absent one is a no-op.
  contextScanAddChannelId?: string;
  contextScanRemoveChannelId?: string;
  contextDailyAddChannelId?: string;
  contextDailyRemoveChannelId?: string;
  // Removed from both lists — used by context-remove.
  contextRemoveChannelId?: string;
  contextSeedDays?: number;
  birthdaysEnabled?: boolean;
  birthdayAnnouncementsChannelId?: string | null;
  remindersEnabled?: boolean;
  joinAnnouncementsChannelId?: string | null;
  leaveAnnouncementsChannelId?: string | null;
  nsfwEnabled?: boolean;
  retainMemberDataOnLeave?: boolean;
  timezone?: string;
  linkFixEnabled?: boolean;
  linkFixChannelIds?: readonly string[];
  // Per-service toggle underneath features.linkFix — a platform false here
  // stops matching/rewriting even while the master feature is on.
  linkFixPlatformOverrides?: Readonly<Partial<Record<LinkFixPlatform, boolean>>>;
  defaultVolume?: number;
  maximumVolume?: number;
  volumeButtonStep?: number;
  emptyQueueAction?: "disconnect" | "stay_connected";
  emptyQueueDelayMs?: number;
  emptyChannelAction?: "continue" | "pause" | "disconnect";
  emptyChannelGracePeriodMs?: number;
  resumeWhenOccupied?: boolean;
  djModeEnabled?: boolean;
}

export interface CreateGuildConfigurationInput {
  guildId: string;
  guildName: string;
  displayName: string;
  embedColor: string;
  idleImageUrl: string | null;
  botAdministratorRoleIds: readonly string[];
  musicControllerRoleIds: readonly string[];
  restrictedRoleIds: readonly string[];
  controlPanelChannelId: string;
}

export function createGuildConfigurationDocument(input: CreateGuildConfigurationInput): ParsedGuildConfigurationFile {
  return guildConfigurationFileSchema.parse({
    schemaVersion: 1,
    guild: { id: input.guildId, name: input.guildName },
    branding: {
      displayName: input.displayName,
      embedColor: input.embedColor,
      idleImageUrl: input.idleImageUrl,
      idleImageAsset: null,
    },
    panel: {},
    features: {
      common: true, diagnostics: true, music: true, chatbot: false, birthdays: false,
      reminders: false, nsfw: false, linkFix: false, retainMemberDataOnLeave: true, ambientReplies: false,
      channelHistory: false,
    },
    roles: {
      botAdministrator: [...input.botAdministratorRoleIds],
      musicController: [...input.musicControllerRoleIds],
      restricted: [...input.restrictedRoleIds],
      chatbot: [],
    },
    channels: {
      musicCommands: [],
      controlPanel: input.controlPanelChannelId,
      auditLog: null,
      chatbot: [],
      birthdayAnnouncements: null,
      linkFix: [],
      joinAnnouncements: null,
      leaveAnnouncements: null,
    },
    linkFixPlatforms: {},
    music: {},
    chat: {},
  });
}

export function toGuildConfiguration(parsed: ParsedGuildConfigurationFile, sourceFile: string): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId: parsed.guild.id,
    guildName: parsed.guild.name,
    displayName: parsed.branding.displayName,
    embedColor: parsed.branding.embedColor,
    idleImageUrl: parsed.branding.idleImageUrl,
    idleImageAsset: parsed.branding.idleImageAsset,
    panel: parsed.panel,
    features: parsed.features,
    roles: {
      botAdministrator: new Set(parsed.roles.botAdministrator),
      musicController: new Set(parsed.roles.musicController),
      restricted: new Set(parsed.roles.restricted),
      chatbot: new Set(parsed.roles.chatbot),
    },
    channels: {
      musicCommands: new Set(parsed.channels.musicCommands),
      controlPanel: parsed.channels.controlPanel,
      auditLog: parsed.channels.auditLog,
      chatbot: new Set(parsed.channels.chatbot),
      birthdayAnnouncements: parsed.channels.birthdayAnnouncements,
      linkFix: new Set(parsed.channels.linkFix),
      joinAnnouncements: parsed.channels.joinAnnouncements,
      leaveAnnouncements: parsed.channels.leaveAnnouncements,
    },
    timezone: parsed.timezone,
    linkFixPlatforms: parsed.linkFixPlatforms,
    music: {
      defaultVolume: parsed.music.volume.default,
      maximumVolume: parsed.music.volume.maximum,
      volumeButtonStep: parsed.music.volume.buttonStep,
      emptyQueueAction: parsed.music.emptyQueue.action,
      emptyQueueDelayMs: parsed.music.emptyQueue.delayMs,
      emptyChannelAction: parsed.music.emptyChannel.action,
      emptyChannelGracePeriodMs: parsed.music.emptyChannel.gracePeriodMs,
      resumeWhenOccupied: parsed.music.emptyChannel.resumeWhenOccupied,
      djModeEnabled: parsed.music.djModeEnabled,
    },
    chat: parsed.chat,
    sourceFile,
  };
}

export function toGuildConfigurationDocument(configuration: GuildConfiguration): ParsedGuildConfigurationFile {
  return guildConfigurationFileSchema.parse({
    schemaVersion: 1,
    guild: { id: configuration.guildId, name: configuration.guildName },
    branding: {
      displayName: configuration.displayName,
      embedColor: configuration.embedColor,
      idleImageUrl: configuration.idleImageUrl,
      idleImageAsset: configuration.idleImageAsset,
    },
    panel: configuration.panel,
    features: configuration.features,
    roles: {
      botAdministrator: [...configuration.roles.botAdministrator],
      musicController: [...configuration.roles.musicController],
      restricted: [...configuration.roles.restricted],
      chatbot: [...configuration.roles.chatbot],
    },
    channels: {
      musicCommands: [...configuration.channels.musicCommands],
      controlPanel: configuration.channels.controlPanel,
      auditLog: configuration.channels.auditLog,
      chatbot: [...configuration.channels.chatbot],
      birthdayAnnouncements: configuration.channels.birthdayAnnouncements,
      linkFix: [...configuration.channels.linkFix],
      joinAnnouncements: configuration.channels.joinAnnouncements,
      leaveAnnouncements: configuration.channels.leaveAnnouncements,
    },
    timezone: configuration.timezone,
    linkFixPlatforms: configuration.linkFixPlatforms,
    music: {
      volume: {
        default: configuration.music.defaultVolume,
        maximum: configuration.music.maximumVolume,
        buttonStep: configuration.music.volumeButtonStep,
      },
      emptyQueue: { action: configuration.music.emptyQueueAction, delayMs: configuration.music.emptyQueueDelayMs },
      emptyChannel: {
        action: configuration.music.emptyChannelAction,
        gracePeriodMs: configuration.music.emptyChannelGracePeriodMs,
        resumeWhenOccupied: configuration.music.resumeWhenOccupied,
      },
      djModeEnabled: configuration.music.djModeEnabled,
    },
    chat: configuration.chat,
  });
}

export function applyGuildConfigurationUpdate(
  document: ParsedGuildConfigurationFile,
  input: UpdateGuildConfigurationInput,
): ParsedGuildConfigurationFile {
  const next = structuredClone(document);
  if (input.idleImageUrl !== undefined) next.branding.idleImageUrl = input.idleImageUrl;
  if (input.idleImageAsset !== undefined) next.branding.idleImageAsset = input.idleImageAsset;
  if (input.controlPanelChannelId !== undefined) next.channels.controlPanel = input.controlPanelChannelId;
  if (input.auditLogChannelId !== undefined) next.channels.auditLog = input.auditLogChannelId;
  if (input.progressBar !== undefined) next.panel.progressBar = structuredClone(input.progressBar);
  if (input.botAdministratorRoleIds !== undefined) next.roles.botAdministrator = [...input.botAdministratorRoleIds];
  if (input.musicControllerRoleIds !== undefined) next.roles.musicController = [...input.musicControllerRoleIds];
  if (input.restrictedRoleIds !== undefined) next.roles.restricted = [...input.restrictedRoleIds];
  if (input.chatbotRoleIds !== undefined) next.roles.chatbot = [...input.chatbotRoleIds];
  if (input.chatbotChannelIds !== undefined) next.channels.chatbot = [...input.chatbotChannelIds];
  if (input.chatbotEnabled !== undefined) next.features.chatbot = input.chatbotEnabled;
  if (input.chatbotPersonalityFile !== undefined) next.chat.personalityFile = input.chatbotPersonalityFile;
  if (input.chatbotPersonalityAsset !== undefined) next.chat.personalityAsset = input.chatbotPersonalityAsset;
  if (input.chatbotExamplesFile !== undefined) next.chat.examplesFile = input.chatbotExamplesFile;
  if (input.chatbotExamplesAsset !== undefined) next.chat.examplesAsset = input.chatbotExamplesAsset;
  if (input.chatbotCooldownSeconds !== undefined) next.chat.cooldownSeconds = input.chatbotCooldownSeconds;
  if (input.chatbotDeniedMessage !== undefined) next.chat.deniedMessage = input.chatbotDeniedMessage;
  if (input.chatbotDeniedLinkUrl !== undefined) next.chat.deniedLinkUrl = input.chatbotDeniedLinkUrl;
  if (input.chatbotDeniedLinkLabel !== undefined) next.chat.deniedLinkLabel = input.chatbotDeniedLinkLabel;
  if (input.chatbotWebSearchMode !== undefined) next.chat.webSearchMode = input.chatbotWebSearchMode;
  if (input.chatbotToolCallingEnabled !== undefined) next.chat.toolCallingEnabled = input.chatbotToolCallingEnabled;
  if (input.chatbotChannelMemoryModes !== undefined) {
    next.chat.channelMemoryModes = { ...next.chat.channelMemoryModes, ...input.chatbotChannelMemoryModes };
  }
  if (input.chatbotDisabledToolNames !== undefined) next.chat.disabledTools = [...input.chatbotDisabledToolNames];
  if (input.chatbotPersonaDriftEnabled !== undefined) next.chat.personaDriftEnabled = input.chatbotPersonaDriftEnabled;
  if (input.contextScanAddChannelId !== undefined && !next.chat.contextScanChannelIds.includes(input.contextScanAddChannelId)) {
    next.chat.contextScanChannelIds = [...next.chat.contextScanChannelIds, input.contextScanAddChannelId];
  }
  if (input.contextScanRemoveChannelId !== undefined) {
    next.chat.contextScanChannelIds = next.chat.contextScanChannelIds.filter((id) => id !== input.contextScanRemoveChannelId);
  }
  if (input.contextDailyAddChannelId !== undefined && !next.chat.contextDailyChannelIds.includes(input.contextDailyAddChannelId)) {
    next.chat.contextDailyChannelIds = [...next.chat.contextDailyChannelIds, input.contextDailyAddChannelId];
  }
  if (input.contextDailyRemoveChannelId !== undefined) {
    next.chat.contextDailyChannelIds = next.chat.contextDailyChannelIds.filter((id) => id !== input.contextDailyRemoveChannelId);
  }
  if (input.contextRemoveChannelId !== undefined) {
    next.chat.contextScanChannelIds = next.chat.contextScanChannelIds.filter((id) => id !== input.contextRemoveChannelId);
    next.chat.contextDailyChannelIds = next.chat.contextDailyChannelIds.filter((id) => id !== input.contextRemoveChannelId);
  }
  if (input.contextSeedDays !== undefined) next.chat.contextSeedDays = input.contextSeedDays;
  if (input.chatbotImageInputEnabled !== undefined) next.chat.imageInputEnabled = input.chatbotImageInputEnabled;
  if (input.chatbotImageGenerationEnabled !== undefined) next.chat.imageGenerationEnabled = input.chatbotImageGenerationEnabled;
  if (input.chatbotSelfReferenceImageAsset !== undefined) next.chat.selfReferenceImageAsset = input.chatbotSelfReferenceImageAsset;
  if (input.chatbotIncludeSources !== undefined) next.chat.includeSources = input.chatbotIncludeSources;
  if (input.chatbotMaxImagesPerRequest !== undefined) next.chat.maxImagesPerRequest = input.chatbotMaxImagesPerRequest;
  if (input.ambientReplies !== undefined) next.features.ambientReplies = input.ambientReplies;
  if (input.ambientCooldownSeconds !== undefined) next.chat.ambientCooldownSeconds = input.ambientCooldownSeconds;
  if (input.channelHistory !== undefined) next.features.channelHistory = input.channelHistory;
  if (input.channelHistoryLimit !== undefined) next.chat.channelHistoryLimit = input.channelHistoryLimit;
  if (input.birthdaysEnabled !== undefined) next.features.birthdays = input.birthdaysEnabled;
  if (input.birthdayAnnouncementsChannelId !== undefined) next.channels.birthdayAnnouncements = input.birthdayAnnouncementsChannelId;
  if (input.remindersEnabled !== undefined) next.features.reminders = input.remindersEnabled;
  if (input.joinAnnouncementsChannelId !== undefined) next.channels.joinAnnouncements = input.joinAnnouncementsChannelId;
  if (input.leaveAnnouncementsChannelId !== undefined) next.channels.leaveAnnouncements = input.leaveAnnouncementsChannelId;
  if (input.nsfwEnabled !== undefined) next.features.nsfw = input.nsfwEnabled;
  if (input.retainMemberDataOnLeave !== undefined) next.features.retainMemberDataOnLeave = input.retainMemberDataOnLeave;
  if (input.timezone !== undefined) next.timezone = input.timezone;
  if (input.linkFixEnabled !== undefined) next.features.linkFix = input.linkFixEnabled;
  if (input.linkFixChannelIds !== undefined) next.channels.linkFix = [...input.linkFixChannelIds];
  if (input.linkFixPlatformOverrides !== undefined) {
    next.linkFixPlatforms = { ...next.linkFixPlatforms, ...input.linkFixPlatformOverrides };
  }
  if (input.defaultVolume !== undefined) next.music.volume.default = input.defaultVolume;
  if (input.maximumVolume !== undefined) next.music.volume.maximum = input.maximumVolume;
  if (input.volumeButtonStep !== undefined) next.music.volume.buttonStep = input.volumeButtonStep;
  if (input.emptyQueueAction !== undefined) next.music.emptyQueue.action = input.emptyQueueAction;
  if (input.emptyQueueDelayMs !== undefined) next.music.emptyQueue.delayMs = input.emptyQueueDelayMs;
  if (input.emptyChannelAction !== undefined) next.music.emptyChannel.action = input.emptyChannelAction;
  if (input.emptyChannelGracePeriodMs !== undefined) next.music.emptyChannel.gracePeriodMs = input.emptyChannelGracePeriodMs;
  if (input.resumeWhenOccupied !== undefined) next.music.emptyChannel.resumeWhenOccupied = input.resumeWhenOccupied;
  if (input.djModeEnabled !== undefined) next.music.djModeEnabled = input.djModeEnabled;
  return guildConfigurationFileSchema.parse(next);
}
