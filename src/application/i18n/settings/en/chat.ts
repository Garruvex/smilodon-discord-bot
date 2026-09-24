import type { SettingsTextCatalog } from "../catalog.js";

const memoryModes = {
  shared: "Shared — memory is scoped by the model",
  isolated: "Isolated — memory stays in this channel",
  session_only: "Session only — nothing durable is written",
  disabled: "Disabled — no memory reads or writes",
};

export const enChat: SettingsTextCatalog = {
  "chat": {
    title: "AI chat",
    description: "How the bot chats, what it can do, what it remembers, and who it is.",
    messages: { paused: "Note: the chatbot is turned off, so this has no effect until it's turned on." },
  },

  // Replies
  "chat.replies": { title: "Replies", description: "When the bot answers, and how it turns people away." },
  "chat.replies.mention-chat": { label: "Mention chat", description: "Reply when members with the AI chat role mention the bot." },
  "chat.replies.mention-chat.enabled": { label: "Chatbot", description: "Turn AI chat on or off for this server." },
  "chat.replies.mention-chat.channels": {
    label: "Chat channels",
    description: "Text channels where mention chat is allowed.",
  },
  "chat.replies.mention-chat.cooldown-seconds": { label: "Cooldown (seconds)", description: "Per-member delay between requests." },

  "chat.replies.denied-message": {
    label: "Denied message",
    description: "What members without access see when they mention the bot.",
  },
  "chat.replies.denied-message.message": { label: "Message", description: "Playful reply shown to members without access." },
  "chat.replies.denied-message.link-url": {
    label: "Link URL",
    description: "https:// link button shown with the message; \"none\" removes it.",
    messages: { "not-https": "The link must be an https:// URL, or \"none\" to remove it." },
  },
  "chat.replies.denied-message.link-label": { label: "Link label", description: "Label for the link button." },

  "chat.replies.ambient-replies": {
    label: "Ambient replies",
    description: "Let the bot judge whether to react or reply when someone names it.",
  },
  "chat.replies.ambient-replies.enabled": { label: "Ambient replies", description: "Turn ambient replies on or off." },
  "chat.replies.ambient-replies.cooldown-seconds": {
    label: "Cooldown (seconds)",
    description: "Minimum seconds between ambient judgments per channel.",
  },

  "chat.replies.reaction-replies": {
    label: "Reaction replies",
    description: "Let the bot judge whether to reply to reactions on its own replies.",
  },
  "chat.replies.reaction-replies.enabled": { label: "Reaction replies", description: "On or off." },

  "chat.replies.history-reactions": {
    label: "History reactions",
    description: "Let the bot react to other messages it already sees during a chat turn.",
  },
  "chat.replies.history-reactions.enabled": { label: "History reactions", description: "On or off." },

  // Abilities
  "chat.abilities": { title: "Abilities", description: "What the model may do while replying." },
  "chat.abilities.web-search": { label: "Web search", description: "Let the model search the public web when needed." },
  "chat.abilities.web-search.enabled": { label: "Web search", description: "On or off." },
  "chat.abilities.include-sources": { label: "Include sources", description: "Add web citation links to replies." },
  "chat.abilities.include-sources.enabled": { label: "Include sources", description: "On or off." },
  "chat.abilities.tool-calling": { label: "Tool calling", description: "Let the model call bot functions mid-reply." },
  "chat.abilities.tool-calling.enabled": { label: "Tool calling", description: "On or off." },
  "chat.abilities.image-input": { label: "Image input", description: "Let the model see images attached in Discord." },
  "chat.abilities.image-input.enabled": { label: "Image input", description: "Turn image input on or off." },
  "chat.abilities.image-input.max-images": { label: "Max images", description: "Most images accepted per request." },
  "chat.abilities.image-generation": { label: "Image generation", description: "Let the model generate images in mention chat." },
  "chat.abilities.image-generation.enabled": { label: "Image generation", description: "On or off." },

  "chat.abilities.tools": {
    label: "Chat tools",
    description: "Every tool the model can call, and whether it's enabled here.",
    messages: {
      none: "No chat tools are registered.",
      heading: "🟢 enabled · 🔴 disabled for this server",
    },
  },
  "chat.abilities.tool": {
    label: "Enable or disable a tool",
    description: "Turn one of the model's chat tools on or off.",
    messages: {
      unknown: "Unknown tool \"{name}\". Available tools: {available}.",
      done: "Disabled chat tools: {disabled}.",
    },
  },
  "chat.abilities.tool.name": { label: "Tool name", description: "A tool name, as the tools list shows it." },
  "chat.abilities.tool.enabled": { label: "Enabled", description: "Whether the model may call it." },

  // Memory
  "chat.memory": { title: "Memory", description: "What the bot reads back and remembers." },
  "chat.memory.channel-history": {
    label: "Channel history",
    description: "Use recent channel messages as context for replies.",
  },
  "chat.memory.channel-history.enabled": { label: "Channel history", description: "Turn channel history on or off." },
  "chat.memory.channel-history.limit": { label: "Messages", description: "How many recent channel messages to include." },

  "chat.memory.memory-mode": {
    label: "Channel memory mode",
    description: "Set how a channel's memory is isolated.",
    messages: {
      missing: "Pick a channel and a mode.",
      done: "{channel} memory mode set to {mode}.",
    },
  },
  "chat.memory.memory-mode.channel": { label: "Channel", description: "The channel to configure." },
  "chat.memory.memory-mode.mode": { label: "Mode", description: "The channel's memory mode.", choices: memoryModes },

  "chat.memory.context-daily": {
    label: "Daily summaries",
    description: "Channels summarized into memory once a day.",
  },
  "chat.memory.context-daily.channels": {
    label: "Channels",
    description: "Text channels to summarize daily.",
    messages: { unavailable: "No configured chat provider can summarize channels, so this can't be turned on." },
  },

  "chat.memory.context-scan": {
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
  "chat.memory.context-scan.channel": { label: "Channel", description: "The channel to scan." },
  "chat.memory.context-scan.seed-days": { label: "Days to read", description: "How many past days the first run reads (default 7)." },
  "chat.memory.context-scan.restart": { label: "Restart", description: "Run a finished scan again from scratch." },

  "chat.memory.context-remove": {
    label: "Stop summarizing",
    description: "Take a channel off both the scan and daily lists; its memories stay.",
    messages: {
      missing: "Pick a channel.",
      done: "{channel} won't be scanned or summarized any more. Memories already written are kept.",
    },
  },
  "chat.memory.context-remove.channel": { label: "Channel", description: "The channel to stop summarizing." },

  "chat.memory.context-status": {
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
  "chat.memory.context-status.channel": { label: "Channel", description: "Show one channel only." },

  // Persona
  "chat.persona": { title: "Persona", description: "Who the bot is when it chats." },
  "chat.persona.personality": { label: "Personality", description: "The character's personality, as a Markdown file." },
  "chat.persona.personality.file": {
    label: "Personality file",
    description: "Upload personality.md (get a starter with the template action).",
    messages: {
      lore: "Personality compiled: {count} section(s) kept as situational lore, sent only when relevant — {headings}. Move anything that should always apply out of a `##` section.",
    },
  },
  "chat.persona.use-default-personality": {
    label: "Use default personality",
    description: "Remove the uploaded personality and use the built-in one.",
    messages: { done: "Using the default personality." },
  },
  "chat.persona.examples": { label: "Example exchanges", description: "Sample conversations in the character's voice." },
  "chat.persona.examples.file": { label: "Examples file", description: "Upload examples.md (get a starter with the template action)." },
  "chat.persona.use-default-examples": {
    label: "Remove examples",
    description: "Remove the uploaded example exchanges.",
    messages: { done: "Uploaded examples removed." },
  },
  "chat.persona.template": {
    label: "Starter file",
    description: "Send a starter personality.md or examples.md to edit and upload.",
    messages: { done: "Starter `{file}` — edit it, then upload it with `{command}`." },
  },
  "chat.persona.template.kind": {
    label: "File",
    description: "Which starter file to send.",
    choices: { personality: "Personality", examples: "Examples" },
  },
  "chat.persona.self-reference-image": {
    label: "Self-reference image",
    description: "What the bot looks like when it draws itself.",
  },
  "chat.persona.self-reference-image.image": { label: "Image", description: "PNG, JPEG, WebP or GIF, up to 8 MB." },
  "chat.persona.remove-self-reference-image": {
    label: "Remove self-reference image",
    description: "Delete the uploaded self-reference image.",
    messages: { done: "Self-reference image removed." },
  },
  "chat.persona.persona-drift": {
    label: "Persona drift",
    description: "Experimental: let the character's mood and quirks slowly evolve.",
  },
  "chat.persona.persona-drift.enabled": { label: "Persona drift", description: "On or off." },
  "chat.persona.reset-persona-drift": {
    label: "Reset persona drift",
    description: "Wipe the character's evolved mood and quirks and start over.",
    messages: {
      unavailable: "Persona drift isn't available without a chat provider.",
      done: "Persona drift reset — the character starts fresh.",
    },
  },
};
