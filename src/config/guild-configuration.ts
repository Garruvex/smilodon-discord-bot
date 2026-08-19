export type GuildFeatureName = "common" | "diagnostics" | "music" | "chatbot" | "birthdays" | "nsfw" | "linkFix";
export type RoleGroupName = "botAdministrator" | "musicController" | "chatbot";

export interface GuildFeatureConfiguration {
  common: boolean;
  diagnostics: boolean;
  music: boolean;
  chatbot: boolean;
  birthdays: boolean;
  nsfw: boolean;
  linkFix: boolean;
  // Whether a departing member's chat memories/birthday/customization are
  // kept (true, default) or deleted (false) when they leave the guild.
  retainMemberDataOnLeave: boolean;
  // Whether the bot may judge (via LLM call) and react/reply to messages
  // that merely name it without an explicit @mention. Off by default.
  ambientReplies: boolean;
  // Whether the bot fetches recent channel messages (from anyone, not just
  // reply-linked) as ambient context for a chat turn. Off by default —
  // surfaces messages from people who never addressed the bot to a
  // third-party LLM API, so it's a deliberate per-guild choice.
  channelHistory: boolean;
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
  birthdayAnnouncements: string | null;
  linkFix: ReadonlySet<string>;
}

export interface GuildChatConfiguration {
  personalityFile: string | null;
  personalityAsset: string | null;
  cooldownSeconds: number;
  deniedMessage: string;
  deniedLinkUrl: string | null;
  deniedLinkLabel: string | null;
  webSearchMode: "off" | "auto";
  toolCallingEnabled: boolean;
  imageInputEnabled: boolean;
  imageGenerationEnabled: boolean;
  includeSources: boolean;
  maxImagesPerRequest: number;
  // Minimum seconds between ambient (name-mention, non-@mention) LLM
  // judgment calls per channel, so a chatty channel that says the bot's
  // name often doesn't turn into a full-pipeline call on every message.
  ambientCooldownSeconds: number;
  // How many recent channel messages to fetch as ambient context when
  // features.channelHistory is on. A hard cap independent of the char
  // budget in chatMemoryLimits.maxChannelHistoryChars.
  channelHistoryLimit: number;
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
