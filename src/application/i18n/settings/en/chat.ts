import type { SettingsTextCatalog } from "../catalog.js";

export const enChat: SettingsTextCatalog = {
  "participation.thread-scope": {"label": "Thread scope", "description": "Select a thread explicitly by ID; parent channels do not grant access.", "messages": {"invalid": "Choose a valid accessible thread in this server and at least one scope change.", "needs-observation": "Enable observation for this thread before allowing spontaneous replies.", "done": "Thread scope updated. Provider, history and participation controls still apply."}},
  "participation.thread-scope.thread-id": {"label": "Thread ID", "description": "ID of a thread the bot can access in this server."},
  "participation.thread-scope.observe": {"label": "Observe", "description": "Allow passive reading and optional follow-ups in this thread."},
  "participation.thread-scope.spontaneous": {"label": "Spontaneous", "description": "Include this thread in the spontaneous allow-list; global controls still apply."},
  "participation.status": {"label": "Participation status", "description": "Show provider readiness and passive channel scope.", "messages": {"available": "Decision provider available. Participation also needs channel history, a selected channel and enabled controls.", "paused": "Optional participation is paused: no structured decision provider or utility fallback is available. Explicit requests remain available.", "scope": "Passive reading uses {count} selected channels. Threads require their own selection."}},
  "participation.observation-channels": {"label": "Observation and follow-up channels", "description": "Select channels for passive reading and optional replies. Empty means none."},
  "participation.observation-channels.channels": {"label": "Channels", "description": "Exact channels or threads; guild memory does not grant access to other channels."},
  "participation.controls.messages-per-decision": {"label": "Messages per decision", "description": "Human messages per spontaneous decision (1-20). Continuations and direct requests bypass this."},
  "participation.controls.spontaneous-threshold": {"label": "Spontaneous contribution threshold (%)", "description": "Minimum score after recipient, contribution label and opening checks pass."},
  "participation.controls.continuation-threshold": {"label": "Follow-up contribution threshold (%)", "description": "Minimum follow-up score after recipient, label and opening checks pass."},
  "participation.continuation-limits.interval": {"label": "Follow-up interval (seconds)", "description": "Minimum seconds between delivered optional follow-ups in a channel."},
  "participation.continuation-limits": { label: "Continuation exchange limits", description: "Limit replies during an ongoing conversation." },
  "participation.continuation-limits.exchange": { label: "Replies per exchange", description: "Replies per exchange; resets after two idle minutes." },
  "participation.continuation-limits.window": { label: "Replies per ten minutes", description: "Maximum continuation replies in one channel over ten minutes." },
  "participation.resources": { label: "Guild resources", description: "Server-wide capacity for chat and character reviews." },
  "participation.resources.concurrency": { label: "Concurrent turns per guild", description: "How many chat requests this server can process at once." },
  "participation.resources.optional-turns": { label: "Optional turns per 10 minutes", description: "Shared ten-minute server budget for optional chat and reviews." },
  "participation": {"title":"Participation","description": "When the bot joins conversations and how often."},
  "participation.controls": {"label":"Participation","description": "Choose whether to continue exchanges or join new topics."},
  "participation.controls.continuation": {"label":"Continue conversations","description": "Reply to follow-ups without another ping. Needs channel history."},
  "participation.controls.spontaneous": {"label":"Join spontaneously","description": "Join topics in the allowed channels. Needs channel history."},
  "participation.controls.activity": {"label":"Activity preset","description": "Pauses and limits for spontaneous replies, optional follow-ups and reactions.","choices":{"quiet":"Quiet","balanced":"Balanced","lively":"Lively"}},
  "participation.controls.bare-pings": {"label":"Bare pings","description": "Choose how to answer a ping with no question.","choices":{"acknowledge":"Brief acknowledgment","personality":"Personality decides"}},
  "participation.controls.shadow": {"label":"Preview decisions","description": "Log participation decisions without sending replies or saving facts."},
  "participation.spontaneous-channels": {"label":"Spontaneous channels","description": "Choose where the bot may start joining topics."},
  "participation.spontaneous-channels.channels": {"label":"Allowed channels","description": "Select channels; leave empty to stop spontaneous participation."},
  "participation.activity-limits": {"label":"Advanced activity limits","description": "Override the activity preset with specific pauses and limits."},
  "participation.activity-limits.evaluation": {"label":"Evaluation cooldown (seconds)","description": "Seconds between participation checks in a channel; continuation skips this."},
  "participation.activity-limits.text": {"label":"Unsolicited text cooldown (seconds)","description": "Seconds between optional text replies in the same channel."},
  "participation.activity-limits.reaction": {"label":"Reaction cooldown (seconds)","description": "Seconds between the bot adding reactions in a channel."},
  "participation.activity-limits.text-budget": {"label":"Unsolicited texts per 10 minutes","description": "Maximum optional text replies per channel in ten minutes."},
  "participation.activity-limits.reaction-budget": {"label":"Reactions per 10 minutes","description": "Maximum outgoing reactions per channel in ten minutes."},
  "participation.participation-channel": {"label":"Channel participation override","description": "Give this channel its own participation settings.","messages":{"missing":"Choose a channel.","done":"Updated participation for {channel}."}},
  "participation.participation-channel.channel": {"label":"Channel","description": "Channel whose participation settings you want to change."},
  "participation.participation-channel.continuation": {"label":"Continue conversations","description": "Allow plain-message follow-ups in this channel."},
  "participation.participation-channel.spontaneous": {"label":"Join spontaneously","description": "Allow topic joining here; also add it to spontaneous channels."},
  "participation.participation-channel.reactions": {"label":"Outgoing reactions","description": "Allow the bot to react to messages in this channel."},
  "participation.participation-channel.activity": {"label":"Activity preset","description": "Activity preset to use in this channel.","choices":{"quiet":"Quiet","balanced":"Balanced","lively":"Lively"}},
  "participation.participation-channel.reset": {"label":"Restore inheritance","description": "Clear this override and use the server defaults."},
  "participation.activity-reset": {"label":"Reset advanced limits","description": "Clear custom limits and use the activity preset again.","messages":{"done":"Advanced overrides cleared; activity presets apply."}},
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
      saved: "Personality file saved and now in use.",
      lore: "Personality compiled: {count} section(s) kept as situational lore, sent only when relevant — {headings}. Move anything that should always apply out of a `##` section.",
    },
  },
  "chat.persona.use-default-personality": {
    label: "Use default personality",
    description: "Remove the uploaded personality and use the built-in one.",
    messages: { done: "Using the default personality." },
  },
  "chat.persona.examples": { label: "Example exchanges", description: "Sample conversations in the character's voice." },
  "chat.persona.examples.file": {
    label: "Examples file",
    description: "Upload examples.md (get a starter with the template action).",
    messages: { saved: "Examples file saved and now in use." },
  },
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
