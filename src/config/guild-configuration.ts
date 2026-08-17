export type GuildFeatureName = "common" | "diagnostics" | "music" | "chatbot";
export type RoleGroupName = "botAdministrator" | "musicController" | "chatbot";

export interface GuildFeatureConfiguration {
  common: boolean;
  diagnostics: boolean;
  music: boolean;
  chatbot: boolean;
}

export interface GuildRoleConfiguration {
  botAdministrator: ReadonlySet<string>;
  musicController: ReadonlySet<string>;
  restricted: ReadonlySet<string>;
  chatbot: ReadonlySet<string>;
}

export interface GuildChannelConfiguration {
  musicCommands: ReadonlySet<string>;
  controlPanel: string | null;
  auditLog: string | null;
  chatbot: ReadonlySet<string>;
}

export interface GuildChatConfiguration {
  personalityFile: string | null;
  personalityAsset: string | null;
  cooldownSeconds: number;
  deniedMessage: string;
  webSearchEnabled: boolean;
  imageInputEnabled: boolean;
  includeSources: boolean;
  maxImagesPerRequest: number;
}

export interface GuildMusicConfiguration {
  defaultVolume: number;
  maximumVolume: number;
  volumeButtonStep: number;
  emptyQueueAction: "disconnect" | "stay_connected";
  emptyQueueDelayMs: number;
  emptyChannelAction: "continue" | "pause" | "disconnect";
  emptyChannelGracePeriodMs: number;
  resumeWhenOccupied: boolean;
}

export type ProgressBarStyle = "standard" | "yohta" | "custom" | "none";

interface ProgressBarEmojiReferenceBase {
  id: string;
  name: string;
  animated: boolean;
}

export interface GuildProgressBarEmojiReference extends ProgressBarEmojiReferenceBase {
  scope: "guild";
  guildId: string;
}

export interface ApplicationProgressBarEmojiReference extends ProgressBarEmojiReferenceBase {
  scope: "application";
  applicationId: string;
}

export type ProgressBarEmojiReference =
  | GuildProgressBarEmojiReference
  | ApplicationProgressBarEmojiReference;

export interface CustomProgressBarTheme {
  completed: ProgressBarEmojiReference;
  remaining: ProgressBarEmojiReference;
  playing: ProgressBarEmojiReference;
  paused: ProgressBarEmojiReference;
  ending: ProgressBarEmojiReference | null;
}

export interface ProgressBarSettings {
  style: ProgressBarStyle;
  length: number;
  customTheme: CustomProgressBarTheme | null;
}

export interface GuildPanelConfiguration {
  progressBar: ProgressBarSettings;
}

export interface GuildConfiguration {
  schemaVersion: 1;
  guildId: string;
  guildName: string;
  displayName: string;
  embedColor: string;
  idleImageUrl: string | null;
  idleImageAsset: string | null;
  panel: GuildPanelConfiguration;
  features: GuildFeatureConfiguration;
  roles: GuildRoleConfiguration;
  channels: GuildChannelConfiguration;
  music: GuildMusicConfiguration;
  chat: GuildChatConfiguration;
  sourceFile: string;
}
