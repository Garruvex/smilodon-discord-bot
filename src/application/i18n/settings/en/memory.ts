import type { SettingsTextCatalog } from "../catalog.js";

const memoryModes = {
  shared: "Shared — memory is scoped by the model",
  isolated: "Isolated — memory stays in this channel",
  session_only: "Session only — nothing durable is written",
  disabled: "Disabled — no memory reads or writes",
};

export const enMemory: SettingsTextCatalog = {
  "memory": { title: "Memory", description: "What the bot reads back and remembers." },
  "memory.channel-history": {
    label: "Channel history",
    description: "Use recent channel messages as context for replies.",
  },
  "memory.channel-history.enabled": { label: "Channel history", description: "Turn channel history on or off." },
  "memory.channel-history.limit": { label: "Messages", description: "How many recent channel messages to include." },

  "memory.memory-mode": {
    label: "Channel memory mode",
    description: "Set how a channel's memory is isolated.",
    messages: {
      missing: "Pick a channel and a mode.",
      done: "{channel} memory mode set to {mode}.",
    },
  },
  "memory.memory-mode.channel": { label: "Channel", description: "The channel to configure." },
  "memory.memory-mode.mode": { label: "Mode", description: "The channel's memory mode.", choices: memoryModes },

  "memory.context-daily": {
    label: "Daily summaries",
    description: "Channels summarized into memory once a day.",
  },
  "memory.context-daily.channels": {
    label: "Channels",
    description: "Text channels to summarize daily.",
    messages: { unavailable: "No configured chat provider can summarize channels, so this can't be turned on." },
  },

  "memory.context-scan": {
    label: "History scan",
    description: "Read a channel's past history once and fold a summary into memory.",
    messages: {
      unavailable: "No configured chat provider can summarize channels, so this can't be queued.",
      missing: "Pick a channel to scan.",
      "in-progress": "That channel's scan is already queued or running — see context status.",
      completed: "That channel's scan already finished. Turn on restart to run it again.",
      queued: "{channel} is queued for a one-time history scan. It runs in the background; see context status for progress.",
      restarted: "{channel} scan restarted — its history will be read and summarized again. See context status for progress.",
    },
  },
  "memory.context-scan.channel": { label: "Channel", description: "The channel to scan." },
  "memory.context-scan.seed-days": { label: "Days to read", description: "How many past days the first run reads (default 7)." },
  "memory.context-scan.restart": { label: "Restart", description: "Run a finished scan again from scratch." },

  "memory.context-remove": {
    label: "Stop summarizing",
    description: "Take a channel off both the scan and daily lists; its memories stay.",
    messages: {
      missing: "Pick a channel.",
      done: "{channel} won't be scanned or summarized any more. Memories already written are kept.",
    },
  },
  "memory.context-remove.channel": { label: "Channel", description: "The channel to stop summarizing." },

  "memory.context-status": {
    label: "Context status",
    description: "Channels being scanned or summarized, and how each last ran.",
    messages: {
      "provider-available": "Provider: available",
      "provider-unavailable": "Provider: unavailable",
      "chatbot-enabled": "Chatbot: on",
      "chatbot-paused": "Chatbot: off (processing waits until it's turned on)",
      "seed-days": "Days read on a first run: {days}",
      "none-configured": "No channels are set up for scanning or daily summaries.",
      "channel-not-configured": "That channel isn't set up for scanning or daily summaries.",
      "scan": "Scan: {state}",
      "scan-cursor": "Scan cursor: {cursor}",
      "daily": "Daily: {state}",
      "daily-cursor": "Daily cursor (batch in progress): {cursor}",
      "daily-high-water": "Daily summarized up to: {at}",
      "last-success": "Last successful batch: {at}",
      "last-error": "⚠️ Last error ({code}): {error}",
      "state-queued": "queued",
      "state-running": "running",
      "state-complete": "complete",
      "state-failed": "failed",
      "state-enabled": "on",
    },
  },
  "memory.context-status.channel": { label: "Channel", description: "Show one channel only." },
};
