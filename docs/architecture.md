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
