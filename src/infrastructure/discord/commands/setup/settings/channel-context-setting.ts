import type { ChannelOptionMetadata } from "../../../../../application/commands/command-metadata.js";
import type { MutationSettingDefinition, ReadOnlySettingDefinition } from "./setting-definition.js";

const contextScanChannelOption: ChannelOptionMetadata = {
  type: "channel", name: "channel", description: "The channel to configure.", required: true, guildTextOnly: true,
};

// One-time scan: an admin can point the bot at one or more channels to read
// some past history and fold a summary into memory once. Runs on the next
// ChannelSummaryScheduler tick, not synchronously — this command only edits
// config and replies immediately, same as every other /settings mutation.
// Re-adding a channel that's already queued/in progress reports its current
// state rather than silently re-queuing (it's already going to run). Once
// completed, re-adding without `restart:true` just reports completion —
// only `restart:true` actually resets scan progress (preserving daily
// state) and re-reads from the seed boundary.
export const contextScanAddSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "context-scan-add",
  description: "Adds a channel for a one-time history scan into memory (runs in the background).",
  configureOptions: () => [
    contextScanChannelOption,
    { type: "integer", name: "seed-days", description: "How many past days to read on the first run (default 7).", minValue: 1, maxValue: 90 },
    { type: "boolean", name: "restart", description: "Re-run a completed scan from scratch (default false)." },
  ],
  handle: async (context, deps, previousProfile, input) => {
    if (!deps.channelSummaryProviderAvailable) {
      return { ok: false, message: "No configured chat provider supports channel summarization, so this can't be queued." };
    }
    const channel = context.interaction.options.getChannel("channel", true);
    const seedDays = context.interaction.options.getInteger("seed-days");
    const restart = context.interaction.options.getBoolean("restart") ?? false;
    const alreadyQueued = previousProfile.chat.contextScanChannelIds.includes(channel.id);
    if (alreadyQueued) {
      const checkpoint = await deps.channelSummaryCheckpointStore?.get(previousProfile.guildId, channel.id) ?? null;
      const completed = checkpoint?.scanCompletedAt != null;
      if (!completed) {
        return { ok: false, message: "That channel's scan is already queued or in progress — check `/settings chat context-status`." };
      }
      if (!restart) {
        return { ok: false, message: "That channel's scan already completed. Pass `restart:true` to run it again." };
      }
      await deps.channelSummaryCheckpointStore?.resetScan(previousProfile.guildId, channel.id, Date.now());
    }
    input.contextScanAddChannelId = channel.id;
    if (seedDays !== null) input.contextSeedDays = seedDays;
    return { ok: true };
  },
  describe: (previous, updated, input) => {
    const channelId = input.contextScanAddChannelId;
    const note = updated.features.chatbot
      ? ""
      : "\nNote: the chatbot feature is currently disabled, so this is paused until it's enabled.";
    if (channelId && previous.chat.contextScanChannelIds.includes(channelId)) {
      return `<#${channelId}> scan restarted — history will be re-read from the seed boundary and re-summarized. ` +
        `Runs in the background; check progress with \`/settings chat context-status\`.${note}`;
    }
    return `<#${channelId}> queued for a one-time history scan — reads channel history, ` +
      `summarizes it via the configured utility/summary model, and stores the result as channel-scoped memory. Runs in the ` +
      `background; check progress with \`/settings chat context-status\`.${note}`;
  },
};

// Ongoing daily consolidation — independent of the scan set (see
// memory-mode-setting.ts's channel-mode enforcement and
// channel-summary-scheduler.ts for how the two sets compose).
export const contextDailyAddSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "context-daily-add",
  description: "Adds a channel for an ongoing daily summary into memory.",
  configureOptions: () => [contextScanChannelOption],
  handle: (context, deps, _previousProfile, input) => {
    if (!deps.channelSummaryProviderAvailable) {
      return Promise.resolve({
        ok: false,
        message: "No configured chat provider supports channel summarization, so this can't be queued.",
      });
    }
    const channel = context.interaction.options.getChannel("channel", true);
    input.contextDailyAddChannelId = channel.id;
    return Promise.resolve({ ok: true });
  },
  describe: (_previous, updated, input) => {
    const note = updated.features.chatbot
      ? ""
      : "\nNote: the chatbot feature is currently disabled, so this is paused until it's enabled.";
    return `<#${input.contextDailyAddChannelId}> will get a daily summary ` +
      `folded into channel-scoped memory — reads that day's messages, summarizes via the configured utility/summary model. ` +
      `One summary per day, checked hourly.${note}`;
  },
};

export const contextDailyRemoveSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "context-daily-remove",
  description: "Stops ongoing daily summarization for a channel (existing memories are kept).",
  configureOptions: () => [contextScanChannelOption],
  handle: (context, _deps, _previousProfile, input) => {
    const channel = context.interaction.options.getChannel("channel", true);
    input.contextDailyRemoveChannelId = channel.id;
    return Promise.resolve({ ok: true });
  },
  describe: () => "Daily summarization stopped for that channel. Memories already written are untouched.",
};

export const contextRemoveSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "context-remove",
  description: "Removes a channel from both scan and daily summarization (existing memories are kept).",
  configureOptions: () => [contextScanChannelOption],
  handle: (context, _deps, _previousProfile, input) => {
    const channel = context.interaction.options.getChannel("channel", true);
    input.contextRemoveChannelId = channel.id;
    return Promise.resolve({ ok: true });
  },
  describe: () =>
    "Removed from both the scan and daily lists — no further scanning or summarization for that channel. " +
    "Memories already written are kept (not bulk-deleted); re-adding later resumes rather than re-reading the " +
    "same history.",
};

type Checkpoint = {
  lastMessageId: string | null;
  scanCompletedAt: number | null;
  dailyCursor: string | null;
  dailyHighWaterMarkAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  lastSuccessAt: number | null;
} | null;

// "failed" reflects the most recent attempt, not a permanent state — any
// subsequent recordSuccess clears lastError/lastErrorCode (see
// ChannelSummaryCheckpointStore.recordSuccess), so a channel that fails then
// later succeeds reports its current state correctly, not a stale failure.
function describeScanState(inScan: boolean, checkpoint: Checkpoint): string {
  if (!inScan) return "not configured";
  if (checkpoint?.scanCompletedAt) return "complete";
  if (checkpoint?.lastErrorCode) return "failed";
  if (checkpoint?.lastMessageId) return "running";
  return "queued";
}

function describeDailyState(inDaily: boolean, checkpoint: Checkpoint): string {
  if (!inDaily) return "not configured";
  if (checkpoint?.lastErrorCode) return "failed";
  if (checkpoint?.dailyCursor) return "running";
  return "enabled";
}

function formatChannelStatus(channelId: string, inScan: boolean, inDaily: boolean, checkpoint: Checkpoint): string {
  const lines = [`<#${channelId}>:`];
  if (inScan) {
    lines.push(`  Scan: ${describeScanState(inScan, checkpoint)}`);
    if (checkpoint?.lastMessageId && !checkpoint.scanCompletedAt) lines.push(`  Scan cursor: ${checkpoint.lastMessageId}`);
  }
  if (inDaily) {
    lines.push(`  Daily: ${describeDailyState(inDaily, checkpoint)}`);
    if (checkpoint?.dailyCursor) lines.push(`  Daily cursor (in-progress batch): ${checkpoint.dailyCursor}`);
    else if (checkpoint?.dailyHighWaterMarkAt) {
      lines.push(`  Daily high-water mark: ${new Date(checkpoint.dailyHighWaterMarkAt).toISOString()}`);
    }
  }
  if (checkpoint?.lastSuccessAt) lines.push(`  Last successful batch: ${new Date(checkpoint.lastSuccessAt).toISOString()}`);
  if (checkpoint?.lastErrorCode) lines.push(`  ⚠️ Last actionable error (${checkpoint.lastErrorCode}): ${checkpoint.lastError}`);
  return lines.join("\n");
}

export const contextStatusSetting: ReadOnlySettingDefinition = {
  kind: "readOnly",
  name: "context-status",
  description: "Shows configured channel-context scan/daily channels and their last-run state.",
  configureOptions: () => [
    { type: "channel", name: "channel", description: "Show detail for one channel only.", guildTextOnly: true },
  ],
  run: async (context, deps, profile) => {
    const channelId = context.interaction.options.getChannel("channel")?.id ?? null;
    const scan = channelId
      ? profile.chat.contextScanChannelIds.filter((id) => id === channelId)
      : profile.chat.contextScanChannelIds;
    const daily = channelId
      ? profile.chat.contextDailyChannelIds.filter((id) => id === channelId)
      : profile.chat.contextDailyChannelIds;
    const header = [
      `Provider: ${deps.channelSummaryProviderAvailable ? "available" : "unavailable"}`,
      `Chatbot: ${profile.features.chatbot ? "enabled" : "paused (processing is skipped until re-enabled)"}`,
      `Seed days (first run lookback): ${profile.chat.contextSeedDays}`,
    ];
    if (scan.length === 0 && daily.length === 0) {
      return [
        ...header,
        channelId ? "That channel isn't configured for scanning or daily summaries." : "No channels are configured for scanning or daily summaries.",
      ].join("\n");
    }
    const allChannelIds = [...new Set([...scan, ...daily])];
    const lines = [...header];
    for (const id of allChannelIds) {
      const checkpoint = deps.channelSummaryCheckpointStore ? await deps.channelSummaryCheckpointStore.get(profile.guildId, id) : null;
      lines.push(formatChannelStatus(id, scan.includes(id), daily.includes(id), checkpoint));
    }
    return lines.join("\n");
  },
};
