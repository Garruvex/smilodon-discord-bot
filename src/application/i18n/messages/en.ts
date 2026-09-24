// The English source of every user-facing runtime message, and the fallback
// for any message a language hasn't translated yet. Keys are dotted paths:
// "music.panel.queue.title" becomes `text.music.panel.queue.title` (see
// ../texts.ts). `{name}` marks a value filled in at runtime; a message with
// placeholders becomes a function taking those values.
//
// Keep messages only the chat model sees (tool results) and log lines out of
// here: the model answers in the user's language on its own.
export const en = {
  // Labels shared by several music surfaces.
  "music.label.autoqueue": "Autoqueue",
  "music.label.lyrics": "Lyrics",
  "music.label.repeat.off": "off",
  "music.label.repeat.track": "track",
  "music.label.repeat.queue": "queue",

  // Song requests typed into the music control channel.
  "music.panel.request.denied": "You need a music-controller role to request songs.",
  "music.panel.request.searching": "Searching…",
  "music.panel.request.failed": "The request could not be completed.",

  // Replies to a panel button press (ephemeral).
  "music.panel.control.unsupported": "This control is no longer supported.",
  "music.panel.control.guildOnly": "This control is only available in a server.",
  "music.panel.control.obsolete": "This control panel is obsolete. Use the current panel message.",
  "music.panel.control.denied": "You need a music-controller role to use this control.",
  "music.panel.control.staleReset": "The bot's voice connection was out of sync with the player, so the session was reset.",
  "music.panel.control.failed": "The control failed.",

  // Text above the Now Playing embed.
  "music.panel.hint.join": "Join a voice channel. {requesters}",
  "music.panel.hint.requestersOpen": "Anyone can queue songs here by name or URL.",
  "music.panel.hint.requestersRestricted": "Members with the music-controller role can queue songs here by name or URL.",
  "music.panel.hint.legend": "-# ♾️ Autoqueue: automatically adds a similar track when the queue runs out.  •  🔁 24/7: keeps the bot connected instead of leaving when idle.",

  // Now Playing embed.
  "music.panel.nowPlaying.idleTitle": "No song currently playing",
  "music.panel.nowPlaying.idleDescription": "The player is ready for a new request.",
  "music.panel.nowPlaying.titlePaused": "Playback paused",
  "music.panel.nowPlaying.titlePlaying": "Now Playing",
  "music.panel.nowPlaying.requestedBy": "Requested by {user}",
  "music.panel.nowPlaying.requestedByAutoqueue": "Requested by {user} (Autoqueue)",
  "music.panel.nowPlaying.requestedByAutoqueueUnknownBot": "Requested by Autoqueue",

  // Lyrics embed.
  "music.panel.lyrics.title": "🎤 Lyrics",
  "music.panel.lyrics.idle": "Nothing is playing right now.",
  "music.panel.lyrics.notFound": "No lyrics found for this track.",
  "music.panel.lyrics.searching": "Looking for lyrics…",

  // Queue embed on the panel (the paginated /queue show view is music.queue.*).
  "music.panel.queue.title": "Queue",
  "music.panel.queue.empty": "Nothing queued.",
  "music.panel.queue.summary": "**{count} in queue** (total {duration})",
  "music.panel.queue.more": "…and {count} more — use `/queue show` for the rest",
  "music.panel.queue.footerEmpty": "Queue empty",
  "music.panel.queue.footerCount": "{count} queued",
  "music.panel.queue.footerLoop": "Loop {mode}",
  "music.panel.queue.autoqueueIssue": "⚠️ Autoqueue found nothing to add",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

// A language's translations: any subset of the English keys. A key left out
// falls back to English (see ../texts.ts and `npm run i18n:coverage`).
export type TranslationCatalog = Partial<Record<MessageKey, string>>;
