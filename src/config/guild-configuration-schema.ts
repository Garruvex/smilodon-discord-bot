import { z } from "zod";

import { CHAT_LIMITS, MUSIC_LIMITS, PANEL_LIMITS } from "./guild-configuration-limits.js";

const snowflake = z.string().regex(/^\d{17,20}$/);
const snowflakeList = z.array(snowflake).default([]);

export function isValidTimeZone(value: string): boolean {
  try {
    // Constructed purely to throw RangeError on an invalid IANA name.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z.string().trim().min(1).refine(isValidTimeZone, {
  message: "Must be a valid IANA time zone name (e.g. \"America/New_York\").",
}).default("UTC");

const guildChatSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const chat = value as Record<string, unknown>;
  if (chat.webSearchMode !== undefined || typeof chat.webSearchEnabled !== "boolean") return value;
  const { webSearchEnabled, ...rest } = chat;
  return { ...rest, webSearchMode: webSearchEnabled ? "auto" : "off" };
}, z.object({
  personalityFile: z.string().trim().min(1).nullable().default(null),
  personalityAsset: z.string().regex(/^guild-assets\/\d{17,20}\/personality\.md$/).nullable().default(null),
  examplesFile: z.string().trim().min(1).nullable().default(null),
  examplesAsset: z.string().regex(/^guild-assets\/\d{17,20}\/examples\.md$/).nullable().default(null),
  cooldownSeconds: z.number().int().min(CHAT_LIMITS.cooldownSeconds.min).max(CHAT_LIMITS.cooldownSeconds.max).default(CHAT_LIMITS.cooldownSeconds.default),
  deniedMessage: z.string().trim().min(1).max(500).default("This feature requires a premium subscription. Try looking richer and ask again."),
  deniedLinkUrl: z.string().trim().url().nullable().default(null),
  deniedLinkLabel: z.string().trim().min(1).max(80).nullable().default(null),
  webSearchMode: z.enum(["off", "auto"]).default("off"),
  toolCallingEnabled: z.boolean().default(false),
  // Deny-list within toolCallingEnabled's master switch — a tool name here
  // (see ChatToolRegistry, matched against ChatTool.name) is withheld from
  // the model even when tool calling is otherwise on. Unknown names (a tool
  // renamed/removed since this was set) are simply ignored, not errors.
  disabledTools: z.array(z.string()).default([]),
  imageInputEnabled: z.boolean().default(false),
  imageGenerationEnabled: z.boolean().default(false),
  selfReferenceImageAsset: z.string().regex(/^guild-assets\/\d{17,20}\/self-reference\.(png|jpg|webp|gif)$/).nullable().default(null),
  includeSources: z.boolean().default(true),
  maxImagesPerRequest: z.number().int().min(CHAT_LIMITS.maxImagesPerRequest.min).max(CHAT_LIMITS.maxImagesPerRequest.max).default(CHAT_LIMITS.maxImagesPerRequest.default),
  ambientCooldownSeconds: z.number().int().min(CHAT_LIMITS.ambientCooldownSeconds.min).max(CHAT_LIMITS.ambientCooldownSeconds.max).default(CHAT_LIMITS.ambientCooldownSeconds.default),
  channelHistoryLimit: z.number().int().min(CHAT_LIMITS.channelHistoryLimit.min).max(CHAT_LIMITS.channelHistoryLimit.max).default(CHAT_LIMITS.channelHistoryLimit.default),
  // Per-channel memory isolation mode (see src/application/memory/memory-channel-policy.ts).
  // Unlisted channels default to "shared" — today's behavior, unchanged.
  channelMemoryModes: z.record(snowflake, z.enum(["shared", "isolated", "session_only", "disabled"])).default({}),
  personaDriftEnabled: z.boolean().default(false),
  // Channel-context (Plan 2): contextScanChannelIds get one one-time
  // history scan; contextDailyChannelIds get an ongoing daily summary. A
  // channel can be in both or either — see channel-summary-scheduler.ts.
  contextScanChannelIds: snowflakeList,
  contextDailyChannelIds: snowflakeList,
  contextSeedDays: z.number().int().min(1).max(90).default(7),
}));

const progressBarEmojiBase = {
  id: snowflake,
  name: z.string().trim().min(1).max(32),
  animated: z.boolean(),
};
const progressBarEmojiSchema = z.discriminatedUnion("scope", [
  z.object({ ...progressBarEmojiBase, scope: z.literal("guild"), guildId: snowflake }),
  z.object({
    ...progressBarEmojiBase,
    scope: z.literal("application"),
    applicationId: snowflake,
  }),
]);

const customProgressBarThemeSchema = z.object({
  completed: progressBarEmojiSchema,
  remaining: progressBarEmojiSchema,
  playing: progressBarEmojiSchema,
  paused: progressBarEmojiSchema,
  ending: progressBarEmojiSchema.nullable().default(null),
});

const defaultProgressBar = {
  style: "standard" as const,
  length: 12,
  customTheme: null,
};

export const guildConfigurationFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    guild: z.object({
      id: snowflake,
      name: z.string().trim().min(1),
    }),
    branding: z
      .object({
        displayName: z.string().trim().min(1),
        embedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        idleImageUrl: z
          .string()
          .url()
          .refine((url) => url.startsWith("https://"), "Idle image URL must use HTTPS.")
          .nullable()
          .default(null),
        idleImageAsset: z.string().regex(/^guild-assets\/\d{17,20}\/idle\.(png|jpg|webp|gif)$/).nullable().default(null),
      })
      .default({
        displayName: "FNTU Bot",
        embedColor: "#3B82F6",
        idleImageUrl: null,
        idleImageAsset: null,
      }),
    panel: z
      .object({
        progressBar: z
          .object({
            style: z.enum(["standard", "yohta", "custom", "none"]).default("standard"),
            length: z.number().int().min(PANEL_LIMITS.progressBarLength.min).max(PANEL_LIMITS.progressBarLength.max).default(PANEL_LIMITS.progressBarLength.default),
            customTheme: customProgressBarThemeSchema.nullable().default(null),
          })
          .default(defaultProgressBar),
      })
      .default({ progressBar: defaultProgressBar }),
    features: z
      .object({
        common: z.boolean().default(true),
        diagnostics: z.boolean().default(true),
        music: z.boolean().default(false),
        chatbot: z.boolean().default(false),
        birthdays: z.boolean().default(false),
        reminders: z.boolean().default(false),
        nsfw: z.boolean().default(false),
        linkFix: z.boolean().default(false),
        retainMemberDataOnLeave: z.boolean().default(true),
        ambientReplies: z.boolean().default(false),
        channelHistory: z.boolean().default(false),
      })
      .default({
        common: true, diagnostics: true, music: false, chatbot: false, birthdays: false,
        reminders: false, nsfw: false, linkFix: false, retainMemberDataOnLeave: true, ambientReplies: false,
        channelHistory: false,
      }),
    roles: z
      .object({
        botAdministrator: snowflakeList,
        musicController: snowflakeList,
        restricted: snowflakeList,
        chatbot: snowflakeList,
      })
      .default({
        botAdministrator: [],
        musicController: [],
        restricted: [],
        chatbot: [],
      }),
    channels: z
      .object({
        musicCommands: snowflakeList,
        controlPanel: snowflake.nullable().default(null),
        auditLog: snowflake.nullable().default(null),
        chatbot: snowflakeList,
        birthdayAnnouncements: snowflake.nullable().default(null),
        linkFix: snowflakeList,
        joinAnnouncements: snowflake.nullable().default(null),
        leaveAnnouncements: snowflake.nullable().default(null),
      })
      .default({
        musicCommands: [],
        controlPanel: null,
        auditLog: null,
        chatbot: [],
        birthdayAnnouncements: null,
        linkFix: [],
        joinAnnouncements: null,
        leaveAnnouncements: null,
      }),
    timezone: timezoneSchema,
    linkFixPlatforms: z
      .object({
        twitter: z.boolean().default(true),
        threads: z.boolean().default(true),
        tiktok: z.boolean().default(true),
        instagram: z.boolean().default(true),
        reddit: z.boolean().default(true),
        bilibili: z.boolean().default(true),
      })
      .default({
        twitter: true, threads: true, tiktok: true, instagram: true, reddit: true, bilibili: true,
      }),
    chat: guildChatSchema
      .default({
        personalityFile: null,
        personalityAsset: null,
        examplesFile: null,
        examplesAsset: null,
        cooldownSeconds: 30,
        deniedMessage: "This feature requires a premium subscription. Try looking richer and ask again.",
        webSearchMode: "off",
        imageInputEnabled: false,
        imageGenerationEnabled: false,
        includeSources: true,
        maxImagesPerRequest: 2,
        ambientCooldownSeconds: 20,
        channelHistoryLimit: 8,
      }),
    music: z
      .object({
        volume: z
          .object({
            default: z.number().int().min(MUSIC_LIMITS.volumeDefault.min).max(MUSIC_LIMITS.volumeDefault.max).default(MUSIC_LIMITS.volumeDefault.default),
            maximum: z.number().int().min(MUSIC_LIMITS.volumeMaximum.min).max(MUSIC_LIMITS.volumeMaximum.max).default(MUSIC_LIMITS.volumeMaximum.default),
            buttonStep: z.number().int().min(MUSIC_LIMITS.volumeButtonStep.min).max(MUSIC_LIMITS.volumeButtonStep.max).default(MUSIC_LIMITS.volumeButtonStep.default),
          })
          .default({ default: 75, maximum: 150, buttonStep: 10 }),
        emptyQueue: z
          .object({
            action: z.enum(["disconnect", "stay_connected"]).default("disconnect"),
            delayMs: z.number().int().min(MUSIC_LIMITS.emptyQueueDelayMs.min).max(MUSIC_LIMITS.emptyQueueDelayMs.max).default(MUSIC_LIMITS.emptyQueueDelayMs.default),
          })
          .default({ action: "disconnect", delayMs: 120_000 }),
        emptyChannel: z
          .object({
            action: z.enum(["continue", "pause", "disconnect"]).default("pause"),
            gracePeriodMs: z.number().int().min(MUSIC_LIMITS.emptyChannelGracePeriodMs.min).max(MUSIC_LIMITS.emptyChannelGracePeriodMs.max).default(MUSIC_LIMITS.emptyChannelGracePeriodMs.default),
            resumeWhenOccupied: z.boolean().default(true),
          })
          .default({
            action: "pause",
            gracePeriodMs: 30_000,
            resumeWhenOccupied: true,
          }),
      })
      .default({
        volume: { default: 75, maximum: 150, buttonStep: 10 },
        emptyQueue: { action: "disconnect", delayMs: 120_000 },
        emptyChannel: {
          action: "pause",
          gracePeriodMs: 30_000,
          resumeWhenOccupied: true,
        },
      }),
  })
  .superRefine((configuration, context) => {
    if (
      configuration.panel.progressBar.style === "custom" &&
      !configuration.panel.progressBar.customTheme
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Custom progress style requires a custom theme.",
        path: ["panel", "progressBar", "customTheme"],
      });
    }

    if (configuration.music.volume.default > configuration.music.volume.maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Default volume cannot exceed maximum volume.",
        path: ["music", "volume", "default"],
      });
    }

    if (
      configuration.features.music &&
      configuration.roles.musicController.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Music requires at least one musicController role.",
        path: ["roles", "musicController"],
      });
    }

    if (
      configuration.features.birthdays &&
      !configuration.channels.birthdayAnnouncements
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Birthdays requires a birthdayAnnouncements channel.",
        path: ["channels", "birthdayAnnouncements"],
      });
    }

    if (
      configuration.features.linkFix &&
      configuration.channels.linkFix.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Link fix requires at least one watched channel.",
        path: ["channels", "linkFix"],
      });
    }
  });

export type ParsedGuildConfigurationFile = z.infer<typeof guildConfigurationFileSchema>;
