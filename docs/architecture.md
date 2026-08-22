# Architecture

For concrete, step-by-step traces of how a request actually moves through the
code (command dispatch, music playback, guild setup, mention chat, and
channel-context memory), see [System Flows](system-flows.md). This document
covers boundaries and invariants; that one covers call order.

## Dependency direction

The project uses explicit boundaries so Discord and Lavalink remain adapters,
not the location of application rules.

```text
Discord commands and components
              |
              v
Application dispatch and music services
              |
              v
Domain policies and gateway interfaces
              |
              v
Discord, Lavalink, and database adapters
```

Commands may depend on application services. Application services may depend
on domain types and gateway interfaces. They must not import Lavalink types.
Only the Lavalink infrastructure adapter imports `lavalink-client`.

## Current music path

```text
/play
  -> CommandDispatcher
  -> AccessPolicyService
  -> PlayCommand
  -> PlaybackService
  -> MusicPlayerGateway
  -> LavalinkPlayerGateway
```

`PlaybackService` owns voice-channel rules. `LavalinkPlayerGateway` owns
library-specific player, queue, track, search, and voice packet operations.

## Authorization

Role IDs are configuration data. Commands reference semantic groups such as
`musicController`; they do not contain guild-specific role IDs.

The restricted-role group is evaluated before required role groups. Owner
bypass is explicit command metadata and can be disabled for a future command
when required.

Authorization resolves the current guild through
`GuildConfigurationProvider`. Unconfigured guilds and disabled features are
denied before role evaluation. A `botAdministrator` role inherits
`musicController` access.

## Guild profiles

`GuildConfigurationProvider` supports either local YAML or PostgreSQL as the
source of truth for server-specific behavior. Compose selects PostgreSQL;
native development may select either driver. A complete YAML example is
committed under `config/examples`.

All profiles are loaded and validated before Discord login. Loading is atomic:
the application does not start with a partially valid profile set. Duplicate
guild IDs, invalid snowflakes, conflicting volume limits, and music without a
controller role are rejected with source-file and field information.

Secrets remain in environment variables. Runtime data such as queues and
control-panel message IDs must not be written back into local profiles.

## Control-channel lifecycle

`ControlChannelService` owns typed song requests and the persistent panel.
Human-managed policy contains only the configured control channel ID. The
bot-managed message identity is stored through `ControlPanelStateStore`, with
atomic local JSON and PostgreSQL adapters. Replacing the configured channel
creates the new panel, updates state, and removes the obsolete bot message.

Lavalink state changes are published through `MusicEventBus`. The panel
subscribes to those application events, so Lavalink does not edit Discord
messages directly. Old or replaced panel messages cannot control a player
because button interactions must match the currently stored message identity.

## Registration

Command deployment is separate from startup. The deployment script builds a
manifest for each local guild profile and filters commands by enabled module.
An optional `--guild` argument limits deployment to one configured server.

`/setup` belongs to the `Bootstrap` command module and is the only global
command. Its access policy explicitly allows an unconfigured guild but still
requires a configured bot owner. Normal command modules remain default-deny
until the setup service atomically creates and reloads a local profile.

`LocalGuildSetupService` may reuse supplied Discord roles/channel or create
them. It then delegates to the profile provider, control-channel service, and
guild command deployment service rather than duplicating those responsibilities.

The bot process never overwrites registered commands while starting.

## Version 1 music boundary

Version 1 includes playback, queue viewing/removal/clearing, skip/previous,
shuffle, volume, repeat, autoplay, 24/7 session mode, Stage-channel speaker
requests, empty-listener and empty-queue policies, the persistent two-row
control panel, and repository-backed server settings.

Active queues, autoplay state, and 24/7 state are intentionally session-local;
they reset when the bot process restarts. Personal saved playlists, filters,
lyrics, dashboard integration, support commands, direct image uploads, and
chatbot behaviors remain Phase 2 work.

## Chat memory boundaries

Persona loading is exposed through the application-layer `PersonaSource`
interface. Mention and ambient chat share one injected implementation. The
default `FilePersonaSource` resolves the existing guild `personality.md` and
`examples.md` files; another stable source can replace it without changing
Discord behaviors or the conversation service.

An uploaded `personality.md` is also compiled once at upload time (see
`PersonaBundleCompiler`, `GuildAssetStore.savePersonality`) into a JSON
sidecar (`personality.bundle.json`) holding an always-sent "core" (identity,
voice, behavior rules) plus embedded "lore" chunks (backstory, relationships,
situational knowledge). `FilePersonaSource` reads this bundle when its stored
content hash matches the current file, and falls back to sending the whole
file — today's original behavior — when no bundle exists, it's stale, or
compilation failed. Lore chunks are narrowed to a relevance-selected subset
per turn by `PersonaLoreSelector`, using the same BM25 + embedding + RRF
fusion as the memory engine, so most of a large personality file's lore only
costs prompt tokens on the turns that actually need it.

Mention chat is orchestrated by an application service rather than the Discord
adapter. The service loads five layers: the configured personality core
(guild, static), a relevance-selected subset of persona lore (guild, static
pool but selected per turn, see above), a relevance-selected subset of the
guild's optional example exchanges (guild, static pool but selected per turn
— see below), bounded confirmed guild knowledge (channel-scoped, see below),
and only the current user's bounded private state (portable across
channels). Live Discord identities and role assignments are request context
and are not copied into learned memory as an authority source.

Guilds may also opt into an experimental **persona drift** layer
(`profile.chat.personaDriftEnabled`, off by default) — a small "current
mood/quirk" overlay, stored in `persona-drift.json` (`PersonaDriftStore`),
that nudges slightly each time channel history ages out and gets summarized
(same `ChatConversationService.consolidateDroppedExchanges` hook that already
writes episodic guild knowledge — see `ChatProvider.evolvePersonaDrift`).
It's additive only: the model is instructed never to let it contradict or
override the personality/lore above it, and every nudge is hard-capped in
size. Disabling the guild setting stops both evolution and prompt injection
without deleting the stored state, so re-enabling resumes where it left off;
an explicit reset (`/settings chat chatbot reset-persona-drift:true`) is the
only thing that clears it.

Normal chat remains one provider call. Its structured result contains the reply,
private user-memory actions, and proposed guild-knowledge candidates. The
application supplies ownership and validates subjects, topics, sizes, and
sensitive-content rules. Safe public self-reports may become confirmed guild
knowledge. Third-party claims remain expiring candidates and are excluded from
normal prompts until the subject or a future administrative workflow confirms
them.

Guild knowledge and the recent-exchange session are each scoped by
`(guildId, channelId)` in addition to their existing keys — a channel only ever
sees guild-wide facts (`channelId IS NULL`) plus its own, so one channel's
scene/context can't leak into another's, and the model is instructed to say it
doesn't know rather than guess when nothing relevant was supplied. When a
session's recent-exchange window ages out (past the count/char caps below), the
dropped exchanges aren't just discarded — they're summarized by a standalone
provider call into channel-scoped guild-knowledge candidates (`source:
"consolidation"`) so long-running channel continuity isn't silently lost. Guild
knowledge relevance ranking uses BM25 (rare-term-weighted, length-normalized)
fused with embedding similarity via Reciprocal Rank Fusion when embeddings are
configured, rather than flat keyword-overlap counting. Example-exchange
selection reuses the same BM25 scorer, but always lexical-only — the pool is
re-read from the guild's `examples.md` fresh every turn (no persisted store to
cache an embedding against), so an embedding variant would mean one API call
per example per message. The shared tokenizer segments CJK text (Han/Kana/
Hangul) via `Intl.Segmenter`, not just whitespace-delimited words, so Chinese/
Japanese/Korean content scores meaningfully instead of contributing no terms.

Persistence is isolated by instance runtime directory and then by guild, user,
and (for sessions/knowledge) channel. Two backends implement the same
application-layer store interfaces:

- **PostgreSQL** — `chat_sessions`, `chat_memories`, `dm_notes_preferences`,
  and `guild_knowledge` tables (Drizzle). Every instance is scoped to a schema
  derived from `INSTANCE_NAME`, allowing multiple instances to share one
  server and database without sharing tables. The application never uses the
  `public` schema.
- **Local (dev-only)** — the same four tables in a single SQLite file
  (`<runtimeDataDirectory>/chat.sqlite`, via `better-sqlite3`), migrated
  automatically on first run. User customization, birthdays, the control
  panel, and guild configuration remain plain JSON/YAML files on this
  backend — only chat/knowledge state moved to SQLite, to fix a lost-update
  race the JSON-file read-modify-write pattern had under concurrent writers.

Session persistence stores the exact Discord-visible assistant text, not the raw
unbounded provider output. Individual user messages are capped at 1,000
characters and Discord replies at 2,000 characters. Up to eight complete recent
exchanges are retained within a 16,000-character serialized budget; when the
budget is exceeded, whole oldest exchanges are removed (and consolidated, see
above) rather than leaving mid-sentence fragments.

Persistence bounds are separate from provider-context bounds. The replaceable
`RecentPromptHistorySelector` sends at most the newest four complete exchanges
within a 6,000-character serialized budget. This preserves additional local
continuity without paying to send all retained history on every request.

## Birthdays

`BirthdayStore` follows the same local/PostgreSQL split as chat state: local
JSON is one document per guild (`birthdays/<guildId>.json`) holding each
member's month/day and a bounded list of already-announced dates; PostgreSQL
uses `birthdays` and `birthday_announcements` tables with the same shape. No
birth year is stored.

`BirthdayAnnouncer` checks hourly, using a per-guild-per-date record in the
store to avoid re-posting after a same-day restart. Announcements require both
`features.birthdays` and a configured `channels.birthdayAnnouncements`, enforced
at the schema level. `/settings community birthdays` manages both; `/birthday set|view|remove`
is user-facing.

## NSFW image commands

`features.nsfw` is a guild-level opt-in for the booru/reaction-image commands
sourced from third-party APIs (e621, bulge, butts). It is defense-in-depth on
top of Discord's own per-channel age-restriction flag: those commands are
built with `SlashCommandBuilder.setNSFW(true)`, so Discord already refuses to
show or run them outside an age-restricted channel. The guild toggle exists so
administrators can disable the category entirely even where an NSFW channel
exists. Non-adult reaction/animal-fact commands (hug, kiss, cat, dog, etc.) are
not gated and register under the `common` module like other fun commands.

Guild-memory selection is an application interface. The current
`FullGuildMemorySelector` returns the store's bounded confirmed set, keeping the
normal path to one provider round trip. Up to 100 confirmed records and 16,000
serialized characters may be included. Record and character counts are logged
with chat request metadata. Logs also report content-free sizes for personality,
selected example exchanges, application security/memory instructions, selected
history, private memory, replied-to content, and the current message. A future
semantic or model-based
selector can replace this implementation without changing Discord, persistence,
or provider adapters.
