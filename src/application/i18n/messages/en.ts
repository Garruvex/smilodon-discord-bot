// The English source of truth for every translatable message. A key is added
// here first; zh-TW.ts and ja.ts are typed against it, so the compiler flags
// a missing translation. `{name}` marks a value filled in at runtime — every
// language must use the same set of placeholders (tests/i18n checks this).
//
// Keep entries that are only ever shown to the model (chat tool results) out
// of here: the model answers in the user's language on its own.
export const en = {
  // Shared vocabulary.
  "music.autoqueue": "Autoqueue",
  "music.lyrics": "Lyrics",

  // Song requests typed into the music control channel.
  "panel.request.denied": "You need a music-controller role to request songs.",
  "panel.request.searching": "Searching…",
  "panel.request.failed": "The request could not be completed.",

  // Replies to a panel button press (ephemeral).
  "panel.control.unsupported": "This control is no longer supported.",
  "panel.control.guildOnly": "This control is only available in a server.",
  "panel.control.obsolete": "This control panel is obsolete. Use the current panel message.",
  "panel.control.denied": "You need a music-controller role to use this control.",
  "panel.control.staleReset": "The bot's voice connection was out of sync with the player, so the session was reset.",
  "panel.control.failed": "The control failed.",

  // Text above the Now Playing embed.
  "panel.hint.join": "Join a voice channel. {requesters}",
  "panel.hint.requestersOpen": "Anyone can queue songs here by name or URL.",
  "panel.hint.requestersRestricted": "Members with the music-controller role can queue songs here by name or URL.",
  "panel.hint.legend": "-# ♾️ Autoqueue: automatically adds a similar track when the queue runs out.  •  🔁 24/7: keeps the bot connected instead of leaving when idle.",

  // Now Playing embed.
  "panel.nowPlaying.idleTitle": "No song currently playing",
  "panel.nowPlaying.idleDescription": "The player is ready for a new request.",
  "panel.nowPlaying.titlePaused": "Playback paused",
  "panel.nowPlaying.titlePlaying": "Now Playing",
  "panel.nowPlaying.requestedBy": "Requested by {user}",
  "panel.nowPlaying.requestedByAutoqueue": "Requested by {user} (Autoqueue)",
  "panel.nowPlaying.requestedByAutoqueueUnknownBot": "Requested by Autoqueue",

  // Lyrics embed.
  "panel.lyrics.title": "🎤 Lyrics",
  "panel.lyrics.idle": "Nothing is playing right now.",
  "panel.lyrics.notFound": "No lyrics found for this track.",
  "panel.lyrics.searching": "Looking for lyrics…",

  // Queue embed.
  "panel.queue.title": "Queue",
  "panel.queue.empty": "Nothing queued.",
  "panel.queue.summary": "**{count} in queue** (total {duration})",
  "panel.queue.more": "…and {count} more — use `/queue show` for the rest",
  "panel.queue.footerEmpty": "Queue empty",
  "panel.queue.footerCount": "{count} queued",
  "panel.queue.footerLoop": "Loop {mode}",
  "panel.queue.autoqueueIssue": "⚠️ Autoqueue found nothing to add",
  "panel.repeat.off": "off",
  "panel.repeat.track": "track",
  "panel.repeat.queue": "queue",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;
