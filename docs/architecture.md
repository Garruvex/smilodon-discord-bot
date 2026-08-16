# Architecture

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

Mention chat is orchestrated by an application service rather than the Discord
adapter. The service loads three deliberately separate inputs: the configured
personality, bounded confirmed guild knowledge, and only the current user's
bounded private state. Live Discord identities and role assignments are request
context and are not copied into learned memory as an authority source.

Normal chat remains one provider call. Its structured result contains the reply,
private user-memory actions, and proposed guild-knowledge candidates. The
application supplies ownership and validates subjects, topics, sizes, and
sensitive-content rules. Safe public self-reports may become confirmed guild
knowledge. Third-party claims remain expiring candidates and are excluded from
normal prompts until the subject or a future administrative workflow confirms
them.

File persistence is isolated by instance runtime directory and then by guild and
user:

```text
chat/<guildId>/guild-knowledge.json
chat/<guildId>/users/<userId>.json
```

Each user document atomically contains that user's recent session and private
memories. Guild knowledge is maintained independently with its own smaller hard
bounds and deterministic topic/slot upserts. A one-time idempotent migration
copies the earlier aggregate `chat-state.json` into per-user documents and
retains the source file. PostgreSQL adapters implement the same application
interfaces with separate session, user-memory, and guild-knowledge tables.

Session persistence stores the exact Discord-visible assistant text, not the raw
unbounded provider output. Individual user messages are capped at 1,000
characters and Discord replies at 2,000 characters. Up to eight complete recent
exchanges are retained within a 16,000-character serialized budget; when the
budget is exceeded, whole oldest exchanges are removed rather than leaving
mid-sentence fragments.

Guild-memory selection is an application interface. The current
`FullGuildMemorySelector` returns the store's bounded confirmed set, keeping the
normal path to one provider round trip. Up to 100 confirmed records and 16,000
serialized characters may be included. Record and character counts are logged
with chat request metadata. A future semantic or model-based selector can replace
this implementation without changing Discord, persistence, or provider adapters.
