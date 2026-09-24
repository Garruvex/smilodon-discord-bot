import { CHAT_LIMITS } from "../../../../config/guild-configuration-limits.js";
import { action, channelList, group, integer, report, toggle } from "../registry/builders.js";
import type { NodeContext } from "../registry/types.js";
import { chatSetting, pausedSuffix } from "./chat.js";
import { renderContextStatus } from "./chat-context-status.js";

// The chatbot's memory: what it reads back and what it keeps. Its own
// /settings-memory command rather than a /settings-chat section, so
// neither command runs into Discord's per-command size limit.

const summarizationUnavailable = ({ deps, text, path }: NodeContext): string | null =>
  deps.channelSummaryProviderAvailable ? null : text.message(path, "unavailable");

export const memory = group("memory", [
  chatSetting("channel-history", {
    enabled: toggle({ read: (p) => p.features.channelHistory, write: (v) => ({ channelHistory: v }) }),
    limit: integer({
      min: CHAT_LIMITS.channelHistoryLimit.min,
      max: CHAT_LIMITS.channelHistoryLimit.max,
      read: (p) => p.chat.channelHistoryLimit,
      write: (v) => ({ channelHistoryLimit: v }),
    }),
  }),

  // Whether a channel's memory can ever become guild-wide: the model's own
  // scoping is only advisory (see memory-channel-policy.ts).
  action("memory-mode", {
    params: {
      channel: { kind: "channel", textOnly: true, required: true },
      mode: { kind: "choice", choices: ["shared", "isolated", "session_only", "disabled"], required: true },
    },
    run: ({ profile, text, path, values }) => {
      const channelId = values.getChannel("channel")?.id;
      const mode = values.getString("mode") as "shared" | "isolated" | "session_only" | "disabled" | null;
      if (!channelId || !mode) return Promise.resolve({ ok: false, message: text.message(path, "missing") });
      return Promise.resolve({
        ok: true,
        message: text.message(path, "done", { channel: `<#${channelId}>`, mode: text.choice(`${path}.mode`, mode) }),
        patch: { chatbotChannelMemoryModes: { ...profile.chat.channelMemoryModes, [channelId]: mode } },
      });
    },
  }),

  // Ongoing daily summaries into channel memory.
  chatSetting("context-daily", {
    channels: channelList({
      textOnly: true,
      read: (p) => [...p.chat.contextDailyChannelIds],
      write: (v) => ({ contextDailyChannelIds: [...v] }),
      validate: (v, context) => {
        const adding = v.some((id) => !context.profile.chat.contextDailyChannelIds.includes(id));
        return adding && !context.deps.channelSummaryProviderAvailable ? context.error("unavailable") : null;
      },
    }),
  }),

  // A one-time read of past history, folded into memory. Runs on the
  // summary scheduler's next tick; re-adding a queued channel reports its
  // state, and only `restart` re-reads a completed one.
  action("context-scan", {
    params: {
      channel: { kind: "channel", textOnly: true, required: true },
      "seed-days": { kind: "integer", min: 1, max: 90 },
      restart: { kind: "toggle" },
    },
    run: async (context) => {
      const { deps, profile, text, path, values } = context;
      const unavailable = summarizationUnavailable(context);
      if (unavailable) return { ok: false, message: unavailable };
      const channelId = values.getChannel("channel")?.id;
      if (!channelId) return { ok: false, message: text.message(path, "missing") };
      const seedDays = values.getInteger("seed-days");

      const queued = profile.chat.contextScanChannelIds.includes(channelId);
      if (queued) {
        const checkpoint = await deps.channelSummaryCheckpointStore?.get(profile.guildId, channelId) ?? null;
        if (checkpoint?.scanCompletedAt == null) return { ok: false, message: text.message(path, "in-progress") };
        if (values.getBoolean("restart") !== true) return { ok: false, message: text.message(path, "completed") };
        await deps.channelSummaryCheckpointStore?.resetScan(profile.guildId, channelId, Date.now());
      }
      return {
        ok: true,
        message: text.message(path, queued ? "restarted" : "queued", { channel: `<#${channelId}>` }) + pausedSuffix(context),
        patch: { contextScanAddChannelId: channelId, ...(seedDays !== null ? { contextSeedDays: seedDays } : {}) },
      };
    },
  }),

  action("context-remove", {
    params: { channel: { kind: "channel", textOnly: true, required: true } },
    run: ({ text, path, values }) => {
      const channelId = values.getChannel("channel")?.id;
      if (!channelId) return Promise.resolve({ ok: false, message: text.message(path, "missing") });
      return Promise.resolve({
        ok: true,
        message: text.message(path, "done", { channel: `<#${channelId}>` }),
        patch: { contextRemoveChannelId: channelId },
      });
    },
  }),

  report("context-status", renderContextStatus, {
    channel: { kind: "channel", textOnly: true },
  }),
]);
