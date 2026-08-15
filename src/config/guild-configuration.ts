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

export interface GuildConfiguration {
  schemaVersion: 1;
  guildId: string;
  guildName: string;
  displayName: string;
  embedColor: string;
  idleImageUrl: string | null;
  idleImageAsset: string | null;
  features: GuildFeatureConfiguration;
  roles: GuildRoleConfiguration;
  channels: GuildChannelConfiguration;
  music: GuildMusicConfiguration;
  chat: GuildChatConfiguration;
  sourceFile: string;
}
