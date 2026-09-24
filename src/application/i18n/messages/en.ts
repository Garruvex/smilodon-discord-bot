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
  "music.panel.hint.request": "🎧 Join a voice channel, then type a song name or link here.",
  "music.panel.hint.controllersOnly": "-# Only members with the music-controller role can request songs.",
  "music.panel.hint.help": "-# What the buttons do: `/help autoplay` · `/help 247`",

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
  "music.panel.lyrics.retrying": "Couldn't reach the lyrics services. Trying again shortly…",
  "music.panel.lyrics.unreachable": "Couldn't reach the lyrics services for this track.",

  // Queue embed on the panel (the paginated /queue show view is music.queue.*).
  "music.panel.queue.title": "Queue",
  "music.panel.queue.empty": "Nothing queued.",
  "music.panel.queue.summary": "**{count} in queue** (total {duration})",
  "music.panel.queue.more": "…and {count} more — use `/queue show` for the rest",
  "music.panel.queue.footerEmpty": "Queue empty",
  "music.panel.queue.footerCount": "{count} queued",
  "music.panel.queue.footerLoop": "Loop {mode}",
  "music.panel.queue.autoqueueIssue": "⚠️ Autoqueue found nothing to add",

  // Music failures — MusicError subclasses (see musicErrorText) and
  // command-level checks.
  "music.error.playerNotFound": "There is no active music player in this server.",
  "music.error.searchEmpty": "No playable tracks were found for that query.",
  "music.error.voiceRequired": "You're not in a voice channel! Join one, then try this command again.",
  "music.error.voiceMismatch": "You must be in the same voice channel as the bot.",
  "music.error.channelAccess": "I don't have permission to join that voice channel — I need View Channel, Connect, and Speak there.",
  "music.error.rateLimitOne": "You're sending requests too quickly. Try again in {seconds} second.",
  "music.error.rateLimitMany": "You're sending requests too quickly. Try again in {seconds} seconds.",
  "music.error.guildOnly": "Music commands are only available in a server.",
  "music.error.noVoiceAccess": "You don't have access to that voice channel.",
  "music.error.nothingPlaying": "Nothing is playing right now.",
  "music.error.dmFailed": "Couldn't DM you — check that your DMs are open for this server.",
  "music.error.seekParse": "Couldn't parse that time. Try `90`, `1:30`, or `1h2m3s`.",

  // Music command replies.
  "music.reply.autoqueueEnabled": "Autoqueue enabled.",
  "music.reply.autoqueueDisabled": "Autoqueue disabled.",
  "music.reply.twentyFourSevenEnabled": "24/7 mode enabled.",
  "music.reply.twentyFourSevenDisabled": "24/7 mode disabled.",
  "music.reply.filtersCleared": "Filters cleared.",
  "music.reply.filterApplied": "Applied the **{filter}** filter.",
  "music.reply.repeatSet": "Repeat mode set to **{mode}**.",
  "music.reply.moved": "Moved **{title}** to position **{position}**.",
  "music.reply.paused": "Playback paused.",
  "music.reply.resumed": "Playback resumed.",
  "music.reply.stopped": "Playback stopped and the voice connection was closed.",
  "music.reply.previous": "Playing the previous track.",
  "music.reply.skipped": "Skipped the current track.",
  "music.reply.skippedTo": "Skipped to **{title}** — {author}.",
  "music.reply.shuffled": "The queue was shuffled.",
  "music.reply.replaying": "Replaying **{title}** — {author}.",
  "music.reply.removed": "Removed **{title}** from the queue.",
  "music.reply.clearedOne": "Cleared {count} queued track.",
  "music.reply.clearedMany": "Cleared {count} queued tracks.",
  "music.reply.saveSent": "Sent you a DM with the current track.",
  "music.reply.seeked": "Seeked to **{time}** in **{title}**.",
  "music.reply.volumeSet": "Volume set to **{level}%**.",

  // /queue history.
  "music.history.title": "Recently played",
  "music.history.empty": "Nothing has played in this server yet.",

  // /queue show — the paginated view (the panel's own queue is music.panel.queue.*).
  "music.queue.title": "Music queue",
  "music.queue.empty": "There are no upcoming tracks.",
  "music.queue.footer": "Page {page}/{pages}  •  {count} in queue  •  total {duration}",
  "music.queue.previousPage": "◀ Prev",
  "music.queue.nextPage": "Next ▶",

  // The card shown after a track is queued.
  "music.card.playlistAdded": "Playlist added",
  "music.card.nowPlaying": "Now playing",
  "music.card.addedToQueue": "Added to queue",
  "music.card.artist": "Artist",
  "music.card.unknownArtist": "Unknown artist",
  "music.card.duration": "Duration",
  "music.card.requestedBy": "Requested by",
  "music.card.tracksAdded": "Tracks added",
  "music.card.positionInQueue": "Position in queue",

  // The "Up next" vote autoqueue posts in the music control channel.
  "music.vote.title": "🗳️ Up next",
  "music.vote.titleLocked": "🔒 Up next",
  "music.vote.paused": "Paused",
  "music.vote.openUntilSkip": "Open until skip",
  "music.vote.closes": "Closes at {time}",
  "music.vote.rerollsLeft": "🎲 {count} left",
  "music.vote.rerolledBy": "🎲 {user} rerolled · {count} left",
  "music.vote.similar": "Similar",
  "music.vote.sameArtist": "Same artist",
  "music.vote.ended": "This vote has ended.",
  "music.vote.restricted": "You can't vote on the music queue.",
  "music.vote.failed": "The vote failed.",
  "music.error.voteUnavailable": "There's no autoqueue vote running right now.",
  "music.error.rerollEmpty": "Couldn't find enough other options to reroll into, so the current ones stay.",
  "music.error.rerollEmptyArtist": "Couldn't find enough other songs by {artist}, so the current options stay.",
  "music.error.voteClosed": "Voting has closed for this song; the next track is locked in.",
  "music.error.rerollLimit": "This vote has already been rerolled {limit} times.",

  // /vote polls.
  "poll.yes": "Yes",
  "poll.no": "No",
  "poll.title": "🗳️ {title}",
  "poll.titleEnded": "🗳️ {title} — ended",
  "poll.footer": "Poll by {name}",
  "poll.endButton": "End poll",
  "poll.tallyOne": "{count} vote · {share}%",
  "poll.tallyMany": "{count} votes · {share}%",
  "poll.openUntilEnded": "Open until the creator ends it.",
  "poll.closes": "Closes {time}.",
  "poll.soFarOne": "{count} vote so far.",
  "poll.soFarMany": "{count} votes so far.",
  "poll.retractHint": "-# Click your pick again to take your vote back.",
  "poll.noVotes": "**Poll ended with no votes.**",
  "poll.winnerOne": "🏆 **Winner: {choice}** ({top} of {total} vote)",
  "poll.winnerMany": "🏆 **Winner: {choice}** ({top} of {total} votes)",
  "poll.tieOne": "🤝 **Tie between {choices}** ({top} vote each, {total} total)",
  "poll.tieMany": "🤝 **Tie between {choices}** ({top} votes each, {total} total)",
  "poll.inactive": "This poll is no longer active.",
  "poll.endDenied": "Only the poll creator or a moderator can end this poll.",
  "poll.needTwoChoices": "Give at least two choices, or none for a Yes/No poll.",
  "poll.duplicateChoices": "Each choice needs to be different.",

  // Birthday announcements.
  "birthday.announce.title": "🎂 Happy Birthday!",
  "birthday.announce.one": "Everyone wish {user} a happy birthday today!",
  "birthday.announce.many": "Everyone wish these members a happy birthday today!\n{users}",

  // Join card and leave message.
  "member.welcome.title": "Welcome, {name}!",
  "member.welcome.subtitle": "Glad you found {server}",
  "member.welcome.number": "Member #{number}",
  "member.leave": "👋 **{tag}** has left the server.",

  // Delivered reminders.
  "reminder.title": "⏰ Reminder",

  // Role picker menus.
  "roleMenu.placeholder": "Choose your roles",
  "roleMenu.everyoneRole": "{role} is the @everyone role and can't be assigned.",
  "roleMenu.managedRole": "{role} is managed by an integration and can't be assigned manually.",
  "roleMenu.cannotManage": "I can't manage {role} — move my role above it in Server Settings → Roles.",
  "roleMenu.noBotMember": "Couldn't resolve my own member in this server.",
  "roleMenu.notConfigured": "This role menu is no longer configured.",
  "roleMenu.guildOnly": "This only works in a server.",
  "roleMenu.added": "Added: {roles}",
  "roleMenu.removed": "Removed: {roles}",
  "roleMenu.noChanges": "No changes.",

  // Failures shown by the command dispatcher, for any command.
  "command.unavailable": "This command is not available. It may have been removed or replaced.",
  "command.unavailableTitle": "Command unavailable",
  "command.denied": "You are not allowed to use this command here.",
  "command.deniedTitle": "Permission denied",
  "command.failed": "The command could not be completed. The error has been logged.",
  "command.errorTitle": "Command error",
  "command.musicErrorTitle": "Music command unavailable",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

// A language's translations: any subset of the English keys. A key left out
// falls back to English (see ../texts.ts and `npm run i18n:coverage`).
export type TranslationCatalog = Partial<Record<MessageKey, string>>;
