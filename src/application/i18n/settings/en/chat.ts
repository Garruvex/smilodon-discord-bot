import type { SettingsTextCatalog } from "../catalog.js";

export const enChat: SettingsTextCatalog = {
  "participation": {"title": "Participation", "description": "When the bot speaks unasked and how often."},
  "participation.status": {"label": "Participation status", "description": "Show whether optional replies can run.", "messages": {"available": "Ready. Turn on follow-ups or joining and pick channels.", "paused": "Paused: no chat model is configured. Mentions still work.", "scope": "Observing {count} channels. Threads need their own selection.", "preview-on": "Preview is on: optional replies are logged, not sent.", "preview-off": "Preview is off: optional replies are sent."}},
  "participation.preview": {"label": "Preview", "description": "Trial run: log optional replies instead of sending. @mentions and replies to the bot still send."},
  "participation.preview.enabled": {"label": "Preview optional replies", "description": "Server default; a channel or thread can override it."},
  "participation.observation-channels": {"label": "Observed channels", "description": "Channels read passively for follow-ups and joining. Empty means none."},
  "participation.observation-channels.channels": {"label": "Channels", "description": "Exact channels; add threads with the channel command."},
  "participation.follow-ups": {"label": "Follow-ups", "description": "Keep replying in an exchange without another ping. Needs channel history."},
  "participation.follow-ups.enabled": {"label": "Follow-ups", "description": "Reply to follow-ups in observed channels."},
  "participation.follow-ups.threshold": {"label": "Follow-up threshold (%)", "description": "Minimum score after recipient, label and timing checks pass."},
  "participation.follow-ups.interval": {"label": "Interval (seconds)", "description": "Minimum seconds between follow-ups in a channel."},
  "participation.follow-ups.per-exchange": {"label": "Per exchange", "description": "Follow-ups per exchange; resets after two idle minutes."},
  "participation.follow-ups.per-10-minutes": {"label": "Per 10 minutes", "description": "Maximum follow-ups in one channel over ten minutes."},
  "participation.joining": {"label": "Joining conversations", "description": "Start talking in a topic unasked. Needs the switch and a listed channel."},
  "participation.joining.enabled": {"label": "Join conversations", "description": "Join topics in the listed channels. Needs channel history."},
  "participation.joining.channels": {"label": "Joining channels", "description": "Where the bot may join; channels must also be observed."},
  "participation.joining.threshold": {"label": "Joining threshold (%)", "description": "Minimum score after recipient, label and timing checks pass."},
  "participation.joining.check-every": {"label": "Check every N messages", "description": "Human messages between join checks (1-20). Follow-ups skip this."},
  "participation.decision-contract": {"label": "Decision contract", "description": "Method for optional turns: legacy or the simple one-question method. Inherit uses the default."},
  "participation.decision-contract.contract": {"label": "Contract", "description": "Server default; a channel can override it.", "choices": {"inherit":"Inherit","legacy":"Legacy","simple":"Simple (trial)"}},
  "participation.simple-threshold": {"label": "Simple-method thresholds", "description": "Minimum score (%) before the simple method acts. 0 is off; only native Decisions scores."},
  "participation.simple-threshold.followup": {"label": "Follow-up threshold (%)", "description": "Minimum action score for follow-ups."},
  "participation.simple-threshold.joining": {"label": "Joining threshold (%)", "description": "Minimum action score for joining."},
  "participation.pacing": {"label": "Pacing", "description": "Activity preset; numbers set here override it until reset-limits."},
  "participation.pacing.activity": {"label": "Activity preset", "description": "Pauses and limits for optional replies and reactions.", "choices": {"quiet": "Quiet", "balanced": "Balanced", "lively": "Lively"}},
  "participation.pacing.evaluation": {"label": "Check cooldown (seconds)", "description": "Seconds between join checks in a channel; follow-ups skip this."},
  "participation.pacing.text": {"label": "Text cooldown (seconds)", "description": "Seconds between optional text replies in a channel."},
  "participation.pacing.reaction": {"label": "Reaction cooldown (seconds)", "description": "Seconds between the bot adding reactions in a channel."},
  "participation.pacing.text-budget": {"label": "Texts per 10 minutes", "description": "Maximum optional text replies per channel in ten minutes."},
  "participation.pacing.reaction-budget": {"label": "Reactions per 10 minutes", "description": "Maximum outgoing reactions per channel in ten minutes."},
  "participation.bare-pings": {"label": "Bare pings", "description": "How to answer a ping with no question."},
  "participation.bare-pings.mode": {"label": "Response", "description": "Brief acknowledgment, or let the personality decide.", "choices": {"acknowledge": "Brief acknowledgment", "personality": "Personality decides"}},
  "participation.resources": {"label": "Guild resources", "description": "Server-wide capacity for chat and character reviews."},
  "participation.resources.concurrency": {"label": "Concurrent turns per guild", "description": "How many chat requests this server can process at once."},
  "participation.resources.optional-turns": {"label": "Optional turns per 10 minutes", "description": "Shared ten-minute server budget for optional chat and reviews."},
  "participation.reset-limits": {"label": "Reset limits", "description": "Clear custom pacing, follow-up and resource numbers; use the preset.", "messages": {"done": "Custom limits cleared; the activity preset applies."}},
  "participation.channel": {"label": "Channel or thread", "description": "Settings for one channel or thread; unset options stay as they are.", "messages": {"missing": "Choose a channel or thread.", "nothing": "Choose at least one change.", "needs-observation": "Turn on observe for this channel first.", "done": "Updated participation for {channel}."}},
  "participation.channel.channel": {"label": "Channel", "description": "Channel or thread; a parent channel never includes its threads."},
  "participation.channel.observe": {"label": "Observe", "description": "Read this channel passively for follow-ups and joining."},
  "participation.channel.joining": {"label": "Joining", "description": "Add to the joining list; the server joining switch still applies."},
  "participation.channel.preview": {"label": "Preview", "description": "Log optional replies here instead of sending; overrides the server."},
  "participation.channel.follow-ups": {"label": "Follow-ups", "description": "Allow follow-ups here; overrides the server switch."},
  "participation.channel.reactions": {"label": "Outgoing reactions", "description": "Allow the bot to react to messages here."},
  "participation.channel.activity": {"label": "Activity preset", "description": "Activity preset to use here.", "choices": {"quiet": "Quiet", "balanced": "Balanced", "lively": "Lively"}},
  "participation.channel.reset": {"label": "Restore inheritance", "description": "Clear this channel's overrides; lists are unchanged."},
  "participation.channel.decision-contract": {"label": "Decision contract", "description": "Decision contract used here; inherit follows the server.", "choices": {"inherit":"Inherit","legacy":"Legacy","simple":"Simple (trial)"}},
  "participation.channel.followup-threshold": {"label": "Follow-up threshold (%)", "description": "Simple-method follow-up score gate here; 0 turns it off."},
  "participation.channel.joining-threshold": {"label": "Joining threshold (%)", "description": "Simple-method joining score gate here; 0 turns it off."},
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
