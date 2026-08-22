// Single source of truth for guild-configurable numeric bounds. The zod schema
// (validation) and the Discord slash-command option builders (input UI) both
// read from here so the two can't drift out of sync.

export const CHAT_LIMITS = {
  cooldownSeconds: { min: 0, max: 86_400, default: 30 },
  ambientCooldownSeconds: { min: 0, max: 86_400, default: 20 },
  maxImagesPerRequest: { min: 0, max: 4, default: 2 },
  channelHistoryLimit: { min: 1, max: 100, default: 8 },
} as const;

export const MUSIC_LIMITS = {
  volumeDefault: { min: 0, max: 1_000, default: 75 },
  volumeMaximum: { min: 1, max: 1_000, default: 150 },
  volumeButtonStep: { min: 1, max: 100, default: 10 },
  emptyQueueDelayMs: { min: 0, max: 86_400_000, default: 120_000 },
  emptyChannelGracePeriodMs: { min: 0, max: 86_400_000, default: 30_000 },
} as const;

export const PANEL_LIMITS = {
  progressBarLength: { min: 6, max: 16, default: 12 },
} as const;
