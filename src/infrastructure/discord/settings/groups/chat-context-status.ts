import type { ChannelSummaryCheckpoint } from "../../../../application/context/channel-summary-checkpoint-store.js";
import type { SettingValues } from "../engine/request.js";
import type { NodeContext } from "../registry/types.js";

type Checkpoint = ChannelSummaryCheckpoint | null;

// "failed" is the most recent attempt, not a permanent state: a later
// success clears the error (see ChannelSummaryCheckpointStore.recordSuccess).
function scanState(checkpoint: Checkpoint): string {
  if (checkpoint?.scanCompletedAt) return "complete";
  if (checkpoint?.lastErrorCode) return "failed";
  if (checkpoint?.lastMessageId) return "running";
  return "queued";
}

function dailyState(checkpoint: Checkpoint): string {
  if (checkpoint?.lastErrorCode) return "failed";
  if (checkpoint?.dailyCursor) return "running";
  return "enabled";
}

const iso = (at: number): string => new Date(at).toISOString();

// The channel-context channels (scan and daily) and how each last ran.
export async function renderContextStatus(context: NodeContext & { values: SettingValues }): Promise<string> {
  const { deps, profile, text, path, values } = context;
  const message = (name: string, params?: Readonly<Record<string, string | number>>): string =>
    text.message(path, name, params);
  const only = values.getChannel("channel")?.id ?? null;
  const scan = profile.chat.contextScanChannelIds.filter((id) => only === null || id === only);
  const daily = profile.chat.contextDailyChannelIds.filter((id) => only === null || id === only);

  const lines = [
    message(deps.channelSummaryProviderAvailable ? "provider-available" : "provider-unavailable"),
    message(profile.features.chatbot ? "chatbot-enabled" : "chatbot-paused"),
    message("seed-days", { days: profile.chat.contextSeedDays }),
  ];
  if (scan.length === 0 && daily.length === 0) {
    return [...lines, message(only ? "channel-not-configured" : "none-configured")].join("\n");
  }

  for (const channelId of new Set([...scan, ...daily])) {
    const checkpoint = await deps.channelSummaryCheckpointStore?.get(profile.guildId, channelId) ?? null;
    lines.push(`<#${channelId}>:`);
    if (scan.includes(channelId)) {
      lines.push(`  ${message("scan", { state: message(`state-${scanState(checkpoint)}`) })}`);
      if (checkpoint?.lastMessageId && !checkpoint.scanCompletedAt) {
        lines.push(`  ${message("scan-cursor", { cursor: checkpoint.lastMessageId })}`);
      }
    }
    if (daily.includes(channelId)) {
      lines.push(`  ${message("daily", { state: message(`state-${dailyState(checkpoint)}`) })}`);
      if (checkpoint?.dailyCursor) lines.push(`  ${message("daily-cursor", { cursor: checkpoint.dailyCursor })}`);
      else if (checkpoint?.dailyHighWaterMarkAt) {
        lines.push(`  ${message("daily-high-water", { at: iso(checkpoint.dailyHighWaterMarkAt) })}`);
      }
    }
    if (checkpoint?.lastSuccessAt) lines.push(`  ${message("last-success", { at: iso(checkpoint.lastSuccessAt) })}`);
    if (checkpoint?.lastErrorCode) {
      lines.push(`  ${message("last-error", { code: checkpoint.lastErrorCode, error: checkpoint.lastError ?? "" })}`);
    }
  }
  return lines.join("\n");
}
