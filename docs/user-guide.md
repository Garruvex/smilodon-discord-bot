# User guide

This guide covers day-to-day use of the bot inside a Discord server: what
every command does, how music and the control panel work, how the AI
chatbot behaves, and how a server admin configures all of it. For installing,
hosting, or developing the bot itself, see the [README](../README.md).

## Getting started

If the bot is already in your server and has been set up, skip to
[Commands](#commands). If you're inviting it for the first time, a member with
Discord's **Manage Server** permission runs `/setup initialize` once — see
[Setting up a new server](#setting-up-a-new-server).

## Roles that gate access

Most commands are open to everyone, but three role groups (configured once by
an admin) control the rest:

| Role group | Grants |
| --- | --- |
| **Bot Administrator** | Everything below, plus `/settings` and `/setup` |
| **Music Controller** | `/play` and every other music command, plus the control-panel buttons |
| **Restricted** | Explicitly *denied* music and chatbot access, even if another role would allow it |

Bot Administrators automatically get Music Controller access too. Run
`/setup status` at any time to see which roles are currently assigned to each
group. `/help` only lists commands you're currently allowed to use.

## Commands

### Utility & fun

| Command | What it does |
| --- | --- |
| `/help [command]` | Lists everything you can use, or details one command. |
| `/ping` | Checks the bot is alive and reports latency. |
| `/userinfo [user]` | Shows a member's account age, join date, and roles. |
| `/dice [sides] [count]` | Rolls dice (default: one d6). Rolling ≤10 six-sided dice shows animated die faces. |
| `/8ball <question>` | Asks the magic 8-ball a yes/no question. |
| `/vote <title> <description> [duration]` | Posts a button-based Yes/No poll. Each member gets one vote and can change it. Add `duration` (10s–24h) to auto-close it; omit it to leave the poll open. Poll state doesn't survive a bot restart. |
| `/qa <question> <answer> [image] [spoiler]` | Posts a Q&A embed, optionally with an image and spoiler-hidden answer. |
| `/owoify <text>` | Twanslates youw text into owo speak. |
| `/wolfy <text>` | Turns a sentence into random dog noises. |
| `/birthday set <month> <day>` | Saves your birthday for the server's birthday announcements. |
| `/birthday view [user]` | Shows a member's saved birthday. |
| `/birthday remove` | Removes your saved birthday. |
| `/clean [count]` | Deletes the bot's own recent messages in the channel (needs Manage Messages). |

### AI memory & personalization

| Command | What it does |
| --- | --- |
| `/memory list` | Shows what the chatbot has remembered about you from conversations. |
| `/memory forget [id] [all]` | Forgets one remembered fact (by ID prefix from `list`) or everything (`all:true`). |
| `/memory notes [dm]` | Toggles whether the bot DMs you extra notes about your chat requests (dropped images, truncated replies). |
| `/customize set <file>` | Uploads a `.md` file describing how *you* want the chatbot to talk to you. Reviewed and sanitized before saving; it can't override the bot's identity or rules. |
| `/customize view` | Shows your saved customization. |
| `/customize clear` | Clears it. |

### Images

| Command | What it does |
| --- | --- |
| `/e926 [query] [type] [order]` | Searches e926 (SFW) for furry art by tags. Empty query = random post. |
| `/e621 [query] [type] [order]` | Same, but NSFW (e621) — only usable in an age-restricted channel with NSFW enabled server-wide. |
| `/boop`, `/hold`, `/howl`, `/hug`, `/kiss`, `/lick` | Posts a themed reaction image. |
| `/bulge`, `/butts` | NSFW reaction images — same channel/server restrictions as `/e621`. |
| `/fursuit-furtrack [tag]` | Posts a random fursuit photo from furtrack.com (default tag: fursuit). |
| `/bird`, `/cat`, `/dog`, `/fox`, `/raccoon` | Posts a random animal photo with a fact. |

NSFW commands require both an age-restricted Discord channel *and* the
server's NSFW setting to be turned on (`/settings community nsfw`).

### Music

All music commands require the **Music Controller** role and only work while
connected to a voice channel.

| Command | What it does |
| --- | --- |
| `/play <query>` | Plays a song by name or URL, or queues it if something's already playing. |
| `/playnext <query>` | Same, but inserts at the front of the queue. |
| `/pause` / `/resume` | Pauses or resumes playback. |
| `/stop` | Stops playback, clears the queue, and disconnects. |
| `/skip` | Skips the current track. |
| `/skipto <position>` | Jumps to a specific queue position. |
| `/previous` | Replays the last track from history. |
| `/replay` | Restarts the current track from 0:00. |
| `/seek <time>` | Seeks within the current track (`90`, `1:30`, or `1h2m3s`). |
| `/queue show` | Lists up to 20 upcoming tracks. |
| `/queue remove <position>` | Removes one queued track. |
| `/queue clear` | Clears the upcoming queue. |
| `/queue history` | Shows recently played tracks. |
| `/move <track> <position>` | Reorders the queue. |
| `/shuffle` | Shuffles the upcoming queue. |
| `/loop <mode>` | Sets repeat to Off, Current track, or Queue. |
| `/autoplay` | Toggles auto-queueing related tracks when the queue empties. |
| `/filters <preset>` | Applies an audio filter: Nightcore, Vaporwave, Bassboost, Pop, 8D, Karaoke, Vibrato, Tremolo, or Off. |
| `/volume <level>` | Sets playback volume (0–1000, capped by the server's configured maximum). |
| `/247` | Toggles 24/7 mode — the bot stays connected even when idle or alone. |
| `/save` | DMs you a link to the currently playing track. |

#### The control panel

If the server has a music control channel configured, you don't need slash
commands for basic playback: just **type a song name or a supported URL**
directly into that channel. Your message and the bot's temporary status reply
are cleaned up automatically so the persistent control panel stays the
channel's only fixture.

The panel itself has two rows of buttons — previous, play/pause, stop, next,
volume, autoplay, 24/7, and shuffle. Pause/Resume, Skip, and Stop require you
to be in the *same voice channel* as the bot and to hold the Music Controller
role.

## AI chat

Two separate behaviors control how the bot talks with words instead of
buttons:

- **Mention chat** — `@mention` the bot with a question and it always
  replies (as long as you have chatbot access). Supports image attachments,
  replies-as-context (reply to a message and mention the bot to ask about
  it), and, if enabled, image generation with live previews.
- **Ambient chat** (opt-in, off by default) — if enabled, the bot may reply
  even without being @mentioned, whenever a message merely *names* it by its
  display name or nickname. The model itself decides whether to reply, just
  react with an emoji, both, or ignore it. An explicit `@mention` always
  takes priority over ambient triggering.

When enabled by an admin (`tool-calling:true`), the chatbot can also *use*
other bot features mid-conversation instead of guessing: it can actually roll
dice, consult the 8-ball, search e621/e926, and look up your saved memories
or birthday, so "roll me a d20" gets a real random result.

If you don't have chatbot access, mentioning the bot returns a configurable
"no access" message instead of a reply — ask a server admin about the
Chatbot role group.

Every server can have a custom **personality** (uploaded by an admin via
`/settings chat chatbot personality:<file>`) that changes how the bot talks,
plus an optional set of **example exchanges**
(`/settings chat chatbot examples:<file>`) that teach it the character's
actual voice — see the [personality guide](personality-guide.md) if you're
writing either.

Admins can also turn on **persona drift** (`/settings chat chatbot
persona-drift:true`), an experimental, off-by-default feature that lets a
small "current mood/quirk" layer evolve slightly over time from real
conversation activity — it only ever adds a light overlay on top of the
personality/lore above, never rewrites them. Turning it off just pauses
evolution (nothing is lost, turning it back on resumes where it left off);
`reset-persona-drift:true` wipes it and starts the character over.

## Setting up a new server

A member with Discord's **Manage Server** permission runs:

```text
/setup initialize
```

Optional parameters let you point it at existing roles/channels instead of
creating new ones: `display-name`, `idle-image-url`, `control-channel`,
`administrator-role`, `music-controller-role`, `restricted-role`. Anything
omitted is created automatically. This:

- grants you the Bot Administrator role;
- creates (or adopts) the control channel and pins the control panel;
- registers the server's enabled slash commands.

Run `/setup status` afterward to confirm what got configured. `/setup
initialize` never overwrites an existing profile — rerunning it on an
already-configured server is a no-op check, not a reset.

## Admin settings (`/settings`)

Everything below requires the **Bot Administrator** role. Settings write
straight to the server's configuration and (if an audit log channel is set)
log a diff of what changed.

### Access

| Subcommand | What it does |
| --- | --- |
| `/settings access access` | Shows the current role assignments for every group. |
| `/settings access roles [administrator] [music-controller] [restricted]` | Adds a role to a group (doesn't remove existing ones). |
| `/settings access role-add <group> <role>` / `role-remove <group> <role>` | Adds or removes one role from one group. |
| `/settings access audit-log [channel] [disable]` | Sets or disables the audit-log channel. |
| `/settings access audit [count]` | Shows recent audit-log entries inline. |

### Music

| Subcommand | What it does |
| --- | --- |
| `/settings music panel [channel] [idle-image-url] [idle-image] [use-default-image] [progress-style] [progress-length] [progress-completed/remaining/playing/paused] [progress-ending]` | Configures the control channel and the now-playing panel's look — including uploading a persistent idle image directly (`idle-image`), no external hosting needed. |
| `/settings music volume [default] [maximum] [button-step]` | Sets default/maximum volume and the panel button's volume step. |
| `/settings music lifecycle [empty-queue-action] [queue-delay-seconds] [empty-channel-action] [channel-grace-seconds] [resume-when-occupied]` | Controls what happens when the queue empties or everyone leaves voice. |

Panel progress styles: **Standard** (plain bar), **Yohta** (bot-owned emoji
preset, works in any server the bot is in once provisioned), **Custom** (your
own emoji for each segment), or **Timestamps only**.

### Chat

| Subcommand | What it does |
| --- | --- |
| `/settings chat chatbot [enabled] [role] [channel] [cooldown-seconds] [denied-message] [denied-link-url] [denied-link-label] [web-search] [tool-calling] [image-input] [image-generation] [include-sources] [max-images] [personality] [use-default-personality] [examples] [use-default-examples] [persona-drift] [reset-persona-drift]` | The main mention-chat switchboard: who can use it, where, how often, and which capabilities are on. |
| `/settings chat ambient-replies [enabled] [cooldown-seconds]` | Turns on ambient (non-mention) chat and its per-channel cooldown. |
| `/settings chat channel-history [enabled] [limit]` | Includes recent messages from anyone as extra context for ambient chat. |
| `/settings chat template <kind>` | Sends a starter `personality.md` or `examples.md` file to download, edit, and upload back via `/settings chat chatbot`. |
| `/settings chat context-scan-add channel [seed-days] [restart]` | Queues a channel for a one-time history scan (default 7-day lookback) folded into guild-wide memory. `restart:true` re-reads a completed scan from scratch. |
| `/settings chat context-daily-add channel` | Adds a channel to ongoing daily summarization, checked hourly. |
| `/settings chat context-daily-remove channel` | Stops daily summarization for a channel (existing memories are kept). |
| `/settings chat context-remove channel` | Removes a channel from both the scan and daily sets (existing memories are kept; re-adding resumes rather than re-reading history). |
| `/settings chat context-status [channel]` | Shows provider availability, whether the chatbot feature is paused, and per-channel scan/daily progress and errors. |

An empty channel list on `/settings chat chatbot` means mention chat is
allowed in every channel. Use `/settings access role-add`/`role-remove` with
the `Chatbot` group to manage multiple allowed roles at once.

The `context-*` commands require a chat provider configured with channel-
summarization support (every built-in provider mode has it) — see the
README's [Channel-context memory](../README.md#channel-context-memory)
section for the full processing model and trust rules.

### Community

| Subcommand | What it does |
| --- | --- |
| `/settings community birthdays [enabled] [channel]` | Turns on birthday announcements and sets the announcement channel (required before enabling). |
| `/settings community nsfw <enabled>` | Allows NSFW image commands server-wide (still needs an age-restricted channel per use). |
| `/settings community link-fix [enabled] [channel] [remove-channel]` | Rewrites Twitter/X, Threads, Instagram, Bilibili, TikTok, and Reddit links for better embeds in watched channels. |
| `/settings community member-data <retain>` | Whether a departing member's chat memories, birthday, and customization are kept (`true`) or deleted (`false`) if they leave. |

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| A command doesn't appear in `/help` or Discord's command list | You lack the required role, or the server admin hasn't run `deploy:commands` after enabling that feature — ask an admin. |
| Mentioning the bot gets a "no access" message | You're missing the Chatbot role, or you have the Restricted role. |
| `/play` or panel typing does nothing | You need the Music Controller role and must be in the bot's voice channel for pause/skip/stop. |
| NSFW commands say they're unavailable | The channel isn't age-restricted, or `/settings community nsfw` is off. |
| Volume caps out lower than expected | The server's configured maximum (`/settings music volume`) limits `/volume`. |
| Control panel disappeared or looks wrong | It's restored automatically on bot restart; if the channel or message was deleted, the bot recreates it the next time it needs to render. |

For setup, hosting, and deployment topics — environment files, Lavalink,
Docker, multiple bot instances — see the [README](../README.md) and the
[launch command cheatsheet](launch-cheatsheet.md).
