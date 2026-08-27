export type GuildFeatureName = "common" | "diagnostics" | "music" | "chatbot" | "birthdays" | "reminders" | "nsfw" | "linkFix";
export type RoleGroupName = "botAdministrator" | "musicController" | "chatbot";

// The individual services link-fix can rewrite/embed. features.linkFix is
// the master switch (and gates whether the behavior runs at all); these are
// per-service toggles underneath it — see LinkFixBehavior and
// domain/links/link-rewrite.ts.
export type LinkFixPlatform = "twitter" | "threads" | "tiktok" | "instagram" | "reddit" | "bilibili";

export type GuildLinkFixPlatformConfiguration = Readonly<Record<LinkFixPlatform, boolean>>;

export interface GuildFeatureConfiguration {
  common: boolean;
  diagnostics: boolean;
  music: boolean;
  chatbot: boolean;
  birthdays: boolean;
  reminders: boolean;
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
  // Two independent, optional channels — no separate enabled flag. An unset
  // channel means that event doesn't notify; see MemberWelcomeService.
  joinAnnouncements: string | null;
  leaveAnnouncements: string | null;
}

export interface GuildChatConfiguration {
  personalityFile: string | null;
  personalityAsset: string | null;
  examplesFile: string | null;
  examplesAsset: string | null;
  cooldownSeconds: number;
  deniedMessage: string;
  deniedLinkUrl: string | null;
  deniedLinkLabel: string | null;
  webSearchMode: "off" | "auto";
  toolCallingEnabled: boolean;
  disabledTools: readonly string[];
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
  // Per-channel memory isolation mode, keyed by channel id — see
  // src/application/memory/memory-channel-policy.ts. Unlisted channels
  // default to "shared".
  channelMemoryModes: Readonly<Record<string, "shared" | "isolated" | "session_only" | "disabled">>;
  // Experimental, off by default — see persona-drift-store.ts. Toggling
  // this off only pauses evolution/injection; it never deletes the guild's
  // accumulated persona-drift.json (see PersonaDriftStore.reset for the
  // explicit wipe action).
  personaDriftEnabled: boolean;
  // Channel-context (Plan 2) — see channel-summary-scheduler.ts. Plain
  // arrays (not Set) since `chat.*` passes through document<->configuration
  // conversion as-is, unlike `channels.*`/`roles.*` (see
  // guild-configuration-document.ts's toGuildConfiguration /
  // toGuildConfigurationDocument — chat is a direct passthrough, no Set
  // wrapping, same as disabledTools above).
  // contextScanChannelIds: one-time history scan, may be several channels.
  // contextDailyChannelIds: ongoing daily summary, independent of the scan
  // set (a channel can be in both, either, or neither).
  contextScanChannelIds: readonly string[];
  contextDailyChannelIds: readonly string[];
  // How many days back a channel's FIRST run (scan or daily) looks.
  contextSeedDays: number;
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
  linkFixPlatforms: GuildLinkFixPlatformConfiguration;
  music: GuildMusicConfiguration;
  chat: GuildChatConfiguration;
  sourceFile: string;
}
