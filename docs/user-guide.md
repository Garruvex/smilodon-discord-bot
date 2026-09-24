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
| **Bot Administrator** | Everything below, plus the admin panel, `/settings-…` and `/setup` |
| **Music Controller** | `/play` and every other music command, plus the control-panel buttons |
| **Restricted** | Explicitly *denied* music and chatbot access, even if another role would allow it |

Bot Administrators automatically get Music Controller access too. Run
`/status` at any time to see which roles are currently assigned to each
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
| `/birthday set <month> <day> [user]` | Saves your birthday for the server's birthday announcements. Bot administrators can pass `user` to set someone else's. |
| `/birthday view [user]` | Shows a member's saved birthday. |
| `/birthday remove [user]` | Removes your saved birthday. Bot administrators can pass `user` to remove someone else's. |
| Right-click a message → Apps → **Quote**, or `/quote message:<link or ID>` | Generates an image quote card from that message — greyscale avatar, wrapped quote text, author name and handle. |
| `/remind set <duration> <message> [delivery]` | Sets a personal reminder (e.g. `30m`, `2h`, `1d`, or `1d12h`). `delivery` picks **DM** (default — private, falls back to the channel it was set in if your DMs are closed) or **This channel** (always posts there, visible to everyone). |
| `/remind list` | Shows your pending reminders and their IDs. |
| `/remind cancel <id>` | Cancels one of your reminders. |
| `/reactionroles create <channel> <title> <role1> [role2-5]` | Posts a dropdown role-picker menu (needs Manage Roles). Members pick roles from it to self-assign. |
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
server's NSFW setting to be turned on (`/settings-community nsfw`).

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

#### Autoqueue vote

With autoqueue on (`/autoplay` or the panel's ♾️ button), listeners pick what
plays next instead of the bot. While a song plays with nothing queued after
it, the bot posts a short **🗳️ Up next** message in the control channel with
a few related songs (3 by default), each with a vote bar.

- **Who can vote:** anyone in the bot's voice channel. You don't need the
  Music Controller role. Voting again moves your vote; clicking your pick
  again takes it back.
- **Who wins:** most votes. A tie, or no votes at all, goes to the option
  marked ▶ (the one autoqueue would have picked anyway), so ignoring the vote
  changes nothing.
- **Rerolls:** 🎲 **Similar** swaps in other related songs; 🎙️ ***Artist***
  swaps in other songs by the artist playing now. Each vote allows 3 rerolls,
  a reroll clears the votes, and the message shows who rerolled.
- **🎤** next to a song means synced lyrics were found for it ahead of time.
- **Timing:** the vote opens when the song starts (or as soon as autoqueue is
  turned on) and 🔒 locks 10 seconds before the song ends, showing the winner.
  Skipping closes it immediately with whatever is leading. Pausing freezes the
  countdown and seeking moves it. If less than 30 seconds are left when a vote
  would open, there's no vote for that song and autoqueue picks on its own.
- The vote is hidden while someone has queued a song by hand, and when a
  repeat mode is on, since autoqueue isn't picking then.

`/help autoplay` shows a short version of this in Discord.

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
`/settings-chat persona personality file:<file>`) that changes how the bot talks,
plus an optional set of **example exchanges**
(`/settings-chat persona examples file:<file>`) that teach it the character's
actual voice — see the [personality guide](personality-guide.md) if you're
writing either.

Admins can also turn on **persona drift** (`/settings-chat persona
persona-drift enabled:true`), an experimental, off-by-default feature that lets a
small "current mood/quirk" layer evolve slightly over time from real
conversation activity — it only ever adds a light overlay on top of the
personality/lore above, never rewrites them. Turning it off just pauses
evolution (nothing is lost, turning it back on resumes where it left off);
`/settings-chat persona reset-persona-drift` wipes it and starts the character over.

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

Then run `/setup guide`: a private walkthrough of the main settings, one per
step. It starts with the server's language, so the rest of the guide is in it,
then a channel for the [admin panel](#the-admin-panel) (or creating a private
one), then roles, music, chat and community basics. Every change saves the moment you make it; **Skip**
leaves a setting as it is and **Finish later** keeps your place until the bot
restarts. Like `/setup`, it needs Manage Server.

Run `/status` afterward to confirm what got configured. `/setup
initialize` never overwrites an existing profile — rerunning it on an
already-configured server is a no-op check, not a reset.

## Admin settings

Every setting can be changed two ways, and both do exactly the same thing:

- **The admin panel** — a channel showing every setting with its description,
  its current value and a control to change it.
- **`/settings-<group>` commands** — `/settings-access`, `/settings-music`,
  `/settings-chat` and `/settings-community`.

Both need the **Bot Administrator** role. Changes write straight to the
server's configuration, show up in the panel right away, and (if an audit log
channel is set) log what changed from what to what.

### The admin panel

Set its channel with `/setup guide` or `/settings-access admin-panel
channel:#channel`. The bot posts a header with links to each section, then one
message per section: toggles are buttons, choices and channels/roles are
menus, numbers and text open a small form (**Edit**), uploads open a form
with a file field, and one-off actions (history scans, starter files, resets)
are **Run** buttons — the destructive ones ask first. The panel is in the
server's language.

It looks after itself:

- only the bot can post in the panel channel (it denies Send Messages to
  @everyone there);
- a deleted panel message is reposted after a few seconds, along with every
  message after it so the order stays right — if messages keep getting
  deleted (more than 3 times in 10 minutes) it stops and says so in the audit
  log;
- if the channel is deleted, the panel setting is turned off;
- `/status` shows anything the bot can't fix itself, such as missing
  permissions in the panel channel;
- `/settings-access repair-panel` (also a button on the panel) takes the
  whole panel down and posts it again.

Keep the panel channel visible to bot admins only; the header warns you if
everyone can see it.

### Lists, clearing and the command shape

A setting that holds a list — roles in an access group, watched channels —
takes `add-…` and `remove-…` options on its command (just `add`/`remove` when
the list is the setting's only option), and is a multi-select on the panel.
An optional channel has a `clear` option (`clear-<name>` when the setting has
several). Chat settings are grouped into sections, so they read
`/settings-chat <section> <setting>`.

### Access

| Command | What it does |
| --- | --- |
| `/settings-access roles [add-/remove-administrator] [add-/remove-music-controller] [add-/remove-chatbot] [add-/remove-restricted]` | Adds or removes roles in each access group. The last bot-admin role can't be removed, nor the last music-controller or chatbot role while that feature is on. |
| `/settings-access admin-panel [channel] [clear]` | Sets or turns off the [admin panel](#the-admin-panel) channel. |
| `/settings-access repair-panel` | Takes the admin panel down and posts it again. |
| `/settings-access audit-log [channel] [clear]` | Sets or turns off the audit-log channel. |
| `/settings-access access` | Shows who holds each access group and what the group allows. |
| `/settings-access audit [count]` | Shows recent audit-log entries inline. |

### Music

| Command | What it does |
| --- | --- |
| `/settings-music panel [channel] [progress-style] [progress-length]` | Sets the control channel and the now-playing panel's progress bar. |
| `/settings-music progress-emojis <completed> <remaining> <playing> <paused> <ending>` | Sets your own emoji for each progress-bar piece and switches to the Custom style. |
| `/settings-music idle-image [file] [url]` | Uploads the image shown when nothing is playing (no external hosting needed), or points at an https URL. |
| `/settings-music default-idle-image` | Goes back to the bundled idle image. |
| `/settings-music volume [default] [maximum] [button-step]` | Sets default/maximum volume and the panel button's volume step. |
| `/settings-music lifecycle [empty-queue-action] [queue-delay-seconds] [empty-channel-action] [channel-grace-seconds] [resume-when-occupied]` | Controls what happens when the queue empties or everyone leaves voice. |
| `/settings-music dj-mode [enabled]` | Lets music controllers control playback from anywhere. |
| `/settings-music open-queue-requests [enabled]` | Lets anyone queue songs without joining the bot's voice channel. |
| `/settings-music autoqueue-vote [enabled] [bar-style] [options]` | Turns the [autoqueue vote](#autoqueue-vote) on or off (on by default; off means autoqueue picks on its own), picks the bar style (colored squares or a thin bar matching the progress bar), and sets how many songs it offers (2–6, default 3). |

Panel progress styles: **Standard** (plain bar), **Yohta** (bot-owned emoji
preset, works in any server the bot is in once provisioned), **Custom** (your
own emoji for each segment), or **Timestamps only**.

### Chat

| Command | What it does |
| --- | --- |
| `/settings-chat replies mention-chat [enabled] [add-/remove-channels] [cooldown-seconds]` | Turns AI chat on or off, limits it to some channels (none means everywhere), and sets the per-member cooldown. Who may chat is the Chatbot group in `/settings-access roles`. |
| `/settings-chat replies denied-message [message] [link-url] [link-label]` | What members without access see; `link-url:none` removes the link button. |
| `/settings-chat replies ambient-replies [enabled] [cooldown-seconds]` | Lets the bot judge whether to answer when someone names it, with a per-channel cooldown. |
| `/settings-chat replies reaction-replies [enabled]` / `history-reactions [enabled]` | Replies to reactions on its own messages; reacts to other messages it sees. |
| `/settings-chat abilities web-search` / `include-sources` / `tool-calling` / `image-generation [enabled]` | Turns each ability on or off. |
| `/settings-chat abilities image-input [enabled] [max-images]` | Lets the model see attached images, and how many per request. |
| `/settings-chat abilities tools` | Lists every chat tool and whether it's enabled here. |
| `/settings-chat abilities tool <name> <enabled>` | Turns one chat tool on or off. |
| `/settings-chat memory channel-history [enabled] [limit]` | Includes recent messages from anyone as extra context. |
| `/settings-chat memory memory-mode <channel> <mode>` | Sets a channel's memory isolation: shared, isolated, session only, or disabled. |
| `/settings-chat memory context-daily [add] [remove]` | Channels summarized into memory once a day, checked hourly. |
| `/settings-chat memory context-scan <channel> [seed-days] [restart]` | Queues a one-time history scan (default 7-day lookback) folded into memory. `restart:true` re-reads a completed scan. |
| `/settings-chat memory context-remove <channel>` | Takes a channel off both the scan and daily lists (existing memories are kept; re-adding resumes rather than re-reading history). |
| `/settings-chat memory context-status [channel]` | Shows provider availability, whether the chatbot is paused, and per-channel scan/daily progress and errors. |
| `/settings-chat persona personality [file]` / `use-default-personality` | Uploads the character's personality, or goes back to the built-in one. |
| `/settings-chat persona examples [file]` / `use-default-examples` | Uploads example exchanges, or removes them. |
| `/settings-chat persona template <kind>` | Sends a starter `personality.md` or `examples.md` to edit and upload. |
| `/settings-chat persona self-reference-image [image]` / `remove-self-reference-image` | What the bot looks like when it draws itself. |
| `/settings-chat persona persona-drift [enabled]` / `reset-persona-drift` | The experimental evolving mood layer, and wiping it. |

Chat settings changed while the chatbot is off say so: they take effect once
it's turned on. The history-scan and daily-summary settings need a chat
provider with channel summarization (every built-in provider mode has it) —
see the README's [Channel-context memory](../README.md#channel-context-memory)
section for the full processing model and trust rules.

### Community

| Command | What it does |
| --- | --- |
| `/settings-community language <language>` | Sets the language (English, 繁體中文, 日本語) for everything the bot posts in this server: the music panel, the admin panel, announcements, votes, and replies. Slash-command descriptions are separate — Discord shows those in each member's own client language. Defaults to English. |
| `/settings-community timezone <zone>` | Sets the IANA time zone (e.g. `America/New_York`) birthday announcements are computed in. Defaults to UTC. |
| `/settings-community birthdays [enabled] [channel]` | Turns on birthday announcements and sets the announcement channel (required before enabling). |
| `/settings-community reminders [enabled]` | Turns `/remind` on or off for this server. |
| `/settings-community welcome [join-channel] [leave-channel] [clear-join-channel] [clear-leave-channel]` | Sets the join/leave announcement channels. Each is independent — leaving one unset just means that event stays silent. Join posts a generated welcome card; leave is a plain text line. |
| `/settings-community link-fix [enabled] [add-/remove-channels] [twitter] [threads] [tiktok] [instagram] [reddit] [bilibili]` | Rewrites Twitter/X, Threads, Instagram, Bilibili, TikTok, and Reddit links for better embeds in watched channels. Each service can be toggled independently of the overall `enabled` switch. |
| `/settings-community nsfw <enabled>` | Allows NSFW image commands server-wide (still needs an age-restricted channel per use). |
| `/settings-community member-data <retain>` | Whether a departing member's private memories, chat sessions/preferences, birthday, customization, and reminders are retained. Shared guild/channel memories remain community history. |

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| A command doesn't appear in `/help` | You lack the required role, or the feature it belongs to is disabled — ask a bot administrator to check the admin panel or `/settings-…`. |
| A command shows up in Discord's own command list but says "you are not allowed to use this command here" when run | The feature it belongs to is disabled for this server — every command is always registered, so a disabled feature rejects it at runtime instead of hiding it from the picker. An admin can turn it on from the admin panel or `/settings-…`; no redeploy needed. |
| A command doesn't appear in Discord's command list at all | This server has no bot profile yet — a member with Manage Server needs to run `/setup initialize`. |
| Mentioning the bot gets a "no access" message | You're missing the Chatbot role, or you have the Restricted role. |
| `/play` or panel typing does nothing | You need the Music Controller role and must be in the bot's voice channel for pause/skip/stop. |
| NSFW commands say they're unavailable | The channel isn't age-restricted, or `/settings-community nsfw` is off. |
| Volume caps out lower than expected | The server's configured maximum (`/settings-music volume`) limits `/volume`. |
| Control panel disappeared or looks wrong | It's restored automatically on bot restart; if the channel or message was deleted, the bot recreates it the next time it needs to render. |
| Admin panel messages went missing or out of order | The bot reposts deleted panel messages itself; if it stopped (see `/status`), run `/settings-access repair-panel`. |

For setup, hosting, and deployment topics — environment files, Lavalink,
Docker, multiple bot instances — see the [README](../README.md) and the
[launch command cheatsheet](launch-cheatsheet.md).
