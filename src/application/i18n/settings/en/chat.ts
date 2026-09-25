import type { SettingsTextCatalog } from "../catalog.js";

export const enChat: SettingsTextCatalog = {
  "chat": {
    title: "AI chat",
    description: "How the bot chats, what it can do, and who it is.",
    messages: { paused: "Note: the chatbot is turned off, so this has no effect until it's turned on." },
  },

  // Replies
  "chat.replies": { title: "Replies", description: "When the bot answers, and how it turns people away." },
  "chat.replies.mention-chat": { label: "Mention chat", description: "Reply when members with the AI chat role mention the bot." },
  "chat.replies.mention-chat.enabled": { label: "Chatbot", description: "Turn AI chat on or off for this server." },
  "chat.replies.mention-chat.channels": {
    label: "Chat channels",
    description: "Channels where mention chat works; empty means all.",
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
    description: "Follow up when people react to the bot's chat replies.",
    messages: { "wait-order": "The minimum wait ({min} min) can't be longer than the maximum ({max} min)." },
  },
  "chat.replies.reaction-replies.enabled": { label: "Reaction replies", description: "On or off." },
  "chat.replies.reaction-replies.min-wait": {
    label: "Min wait (minutes)",
    description: "Shortest wait after the first reaction.",
  },
  "chat.replies.reaction-replies.max-wait": {
    label: "Max wait (minutes)",
    description: "Longest wait; a random time in between is used.",
  },
  "chat.replies.reaction-replies.min-reactions": {
    label: "Min reactions",
    description: "People who must react first.",
  },

  "chat.replies.history-reactions": {
    label: "History reactions",
    description: "React to other messages seen during a chat turn.",
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
