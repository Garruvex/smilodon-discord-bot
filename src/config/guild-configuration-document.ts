import type { GuildConfiguration, ProgressBarSettings } from "./guild-configuration.js";
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
  chatbotCooldownSeconds?: number;
  chatbotDeniedMessage?: string;
  chatbotDeniedLinkUrl?: string | null;
  chatbotDeniedLinkLabel?: string | null;
  chatbotWebSearchMode?: "off" | "auto";
  chatbotImageInputEnabled?: boolean;
  chatbotImageGenerationEnabled?: boolean;
  chatbotIncludeSources?: boolean;
  chatbotMaxImagesPerRequest?: number;
  birthdaysEnabled?: boolean;
  birthdayAnnouncementsChannelId?: string | null;
  nsfwEnabled?: boolean;
  linkFixEnabled?: boolean;
  linkFixChannelIds?: readonly string[];
  defaultVolume?: number;
  maximumVolume?: number;
  volumeButtonStep?: number;
  emptyQueueAction?: "disconnect" | "stay_connected";
  emptyQueueDelayMs?: number;
  emptyChannelAction?: "continue" | "pause" | "disconnect";
  emptyChannelGracePeriodMs?: number;
  resumeWhenOccupied?: boolean;
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
    features: { common: true, diagnostics: true, music: true, chatbot: false, birthdays: false, nsfw: false, linkFix: false },
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
    },
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
    },
    music: {
      defaultVolume: parsed.music.volume.default,
      maximumVolume: parsed.music.volume.maximum,
      volumeButtonStep: parsed.music.volume.buttonStep,
      emptyQueueAction: parsed.music.emptyQueue.action,
      emptyQueueDelayMs: parsed.music.emptyQueue.delayMs,
      emptyChannelAction: parsed.music.emptyChannel.action,
      emptyChannelGracePeriodMs: parsed.music.emptyChannel.gracePeriodMs,
      resumeWhenOccupied: parsed.music.emptyChannel.resumeWhenOccupied,
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
    },
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
  if (input.chatbotCooldownSeconds !== undefined) next.chat.cooldownSeconds = input.chatbotCooldownSeconds;
  if (input.chatbotDeniedMessage !== undefined) next.chat.deniedMessage = input.chatbotDeniedMessage;
  if (input.chatbotDeniedLinkUrl !== undefined) next.chat.deniedLinkUrl = input.chatbotDeniedLinkUrl;
  if (input.chatbotDeniedLinkLabel !== undefined) next.chat.deniedLinkLabel = input.chatbotDeniedLinkLabel;
  if (input.chatbotWebSearchMode !== undefined) next.chat.webSearchMode = input.chatbotWebSearchMode;
  if (input.chatbotImageInputEnabled !== undefined) next.chat.imageInputEnabled = input.chatbotImageInputEnabled;
  if (input.chatbotImageGenerationEnabled !== undefined) next.chat.imageGenerationEnabled = input.chatbotImageGenerationEnabled;
  if (input.chatbotIncludeSources !== undefined) next.chat.includeSources = input.chatbotIncludeSources;
  if (input.chatbotMaxImagesPerRequest !== undefined) next.chat.maxImagesPerRequest = input.chatbotMaxImagesPerRequest;
  if (input.birthdaysEnabled !== undefined) next.features.birthdays = input.birthdaysEnabled;
  if (input.birthdayAnnouncementsChannelId !== undefined) next.channels.birthdayAnnouncements = input.birthdayAnnouncementsChannelId;
  if (input.nsfwEnabled !== undefined) next.features.nsfw = input.nsfwEnabled;
  if (input.linkFixEnabled !== undefined) next.features.linkFix = input.linkFixEnabled;
  if (input.linkFixChannelIds !== undefined) next.channels.linkFix = [...input.linkFixChannelIds];
  if (input.defaultVolume !== undefined) next.music.volume.default = input.defaultVolume;
  if (input.maximumVolume !== undefined) next.music.volume.maximum = input.maximumVolume;
  if (input.volumeButtonStep !== undefined) next.music.volume.buttonStep = input.volumeButtonStep;
  if (input.emptyQueueAction !== undefined) next.music.emptyQueue.action = input.emptyQueueAction;
  if (input.emptyQueueDelayMs !== undefined) next.music.emptyQueue.delayMs = input.emptyQueueDelayMs;
  if (input.emptyChannelAction !== undefined) next.music.emptyChannel.action = input.emptyChannelAction;
  if (input.emptyChannelGracePeriodMs !== undefined) next.music.emptyChannel.gracePeriodMs = input.emptyChannelGracePeriodMs;
  if (input.resumeWhenOccupied !== undefined) next.music.emptyChannel.resumeWhenOccupied = input.resumeWhenOccupied;
  return guildConfigurationFileSchema.parse(next);
}
