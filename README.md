# Smilodon Discord Bot

A configurable TypeScript Discord bot that can serve FNTU, Smilodon, or other
communities from one maintainable codebase. Server-specific features, roles,
channels, branding, and music policies live in validated local guild profiles.

It runs a Lavalink-backed music player with a persistent, restart-safe
control panel; role-gated slash commands for music, moderation, and fun/image
commands; a mention-based (and optional ambient) AI chatbot with per-guild
personality, memory, and tool calling; and a global `/setup` flow so a server
admin can bootstrap a guild without editing any files.

For a full end-user command reference and admin `/settings` walkthrough, see
the [user guide](docs/user-guide.md). For internal architecture, see
[Architecture](docs/architecture.md).

## Features

- Role-first access control (bot administrator, music controller, restricted,
  chatbot groups) with an optional bot-owner bypass and default-deny behavior
  for unconfigured guilds.
- A Lavalink v4 music player: playback, queue management, loop, volume,
  autoplay, 24/7 mode, shuffle, filters, seeking, and a persistent two-row
  control panel with song requests typed directly into the control channel.
- Fun and utility commands: dice, 8-ball, polls, Q&A embeds, birthdays,
  furry/animal image commands, and more — see the
  [command reference](docs/user-guide.md#commands).
- A mention-based AI chatbot (any OpenAI-compatible provider) with optional
  ambient replies, per-guild personality files, per-user memory and
  customization, image input/generation, web search, and tool calling into
  bot features like dice rolls and image search.
- A global `/setup` bootstrap command gated by Discord's Manage Server
  permission, and repository-backed `/settings` for everything else — no
  file editing required to run a guild.
- File (YAML) or PostgreSQL persistence, single- or multi-instance (multiple
  Discord applications from one deployment).

## Requirements

- Node.js 20 or newer
- A Discord application and bot token
- A Lavalink v4 node with at least one usable search source
- The Discord `Message Content Intent` enabled for the application

## Deployment

### 1. Create the Discord application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and create or select an application.
2. Open **Bot** and enable **Message Content Intent**. This is required because
   users can type song names and URLs directly into the persistent control
   channel.
3. Under **Token**, reset and copy the bot token.
4. Copy the **Application ID** from **General Information**.

The bot token is a secret and grants access to the bot account. Never commit,
post, or paste it into chat. The Application ID and Discord user IDs are not
secrets. The OAuth2 Client Secret is also sensitive, but this bot does not use
it; a 32-character Client Secret must not be placed in `DISCORD_TOKEN`.

### 2. Configure the local environment

Copy the shared and application templates:

```powershell
Copy-Item .env.example .env
Copy-Item config\instances\bot.env.example config\instances\myinstance.env
```

Keep shared infrastructure in `.env`:

```env
DEFAULT_INSTANCE=myinstance
LAVALINK_PASSWORD=choose_a_private_lavalink_password
```

Put Discord identity and application persistence in
`config/instances/myinstance.env`:

```env
INSTANCE_NAME=myinstance
DISCORD_TOKEN=the_bot_token_from_the_Bot_page
DISCORD_APPLICATION_ID=the_application_id
BOT_OWNER_IDS=your_discord_user_id
PERSISTENCE_DRIVER=file
GUILD_CONFIG_DIRECTORY=./config/local/instances/myinstance/guilds
RUNTIME_DATA_DIRECTORY=./data/instances/myinstance
```

Enable Discord Developer Mode and use **Copy User ID** on your account to obtain
`BOT_OWNER_IDS`. Multiple application operators can be provided as comma-separated
IDs. These are trusted operators of this Discord application, not the
administrator list for every server. Do not add a `Bot ` prefix or quotes around
`DISCORD_TOKEN`.

Install dependencies and validate the token:

```powershell
npm.cmd install
npm.cmd run local:check-token
```

The check should report `Discord token accepted`. If it identifies a Client
Secret, return to **Developer Portal > Bot > Token**, reset the bot token, and
replace the incorrect value.

### 3. Register the bootstrap command

```powershell
npm.cmd run deploy:commands
```

This synchronizes the global `/setup` command even when no guild profiles exist.
Its runtime access is limited to members with **Manage Server** and configured
bot operators. Global Discord commands can take time to appear. Run this command
again after changing slash-command definitions; restarting the bot alone does
not update Discord's registered command manifest.

### 4. Invite the bot

In **Developer Portal > OAuth2 > URL Generator**, select these scopes:

- `bot`
- `applications.commands`

Grant the bot these permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Messages
- Manage Channels
- Manage Roles
- Connect
- Speak

Open the generated URL and select the target server. The bot's server role must
be above any role it needs to create, assign, or manage.

### 5. Initialize YouTube OAuth for local Lavalink

For the first authorization, run Lavalink without the Discord bot:

```powershell
npm.cmd run local:lavalink
```

Open the Google device URL printed by Lavalink and enter the displayed code.
Use a separate/burner Google account, as recommended by the YouTube source
plugin. When Lavalink prints the refresh token, store it only in `.env`:

```env
YOUTUBE_REFRESH_TOKEN=the_generated_refresh_token
```

The refresh token is a secret. `lavalink/application.yml` reads it through the
`YOUTUBE_REFRESH_TOKEN` environment variable. Stop Lavalink with `Ctrl+C` and
restart it; a valid saved token prevents a new device authorization prompt.

### 6. Start and initialize the server

On Windows without Docker, set `PERSISTENCE_DRIVER=file` in the default
instance file and run:

```powershell
npm.cmd run local:setup
npm.cmd run local:start
```

`local:setup` is safe to rerun and installs the workspace-local Java, Lavalink,
and plugins required by `local:start`. After inviting the bot, the server owner
or a member with Discord's **Manage Server** permission can run
`/setup initialize`. A configured `BOT_OWNER_IDS` operator can also bootstrap or
recover setup through the owner-bypass policy.

Initialization can adopt existing roles and a text channel through command
options. The bundled Smilodon `no_bg.png` is displayed when no track is playing;
a stable HTTPS `idle-image-url` can override it per guild. Omitted resources are
created automatically. It then:

- grants the initializer the bot-administrator role;
- writes `config/local/guilds/<guild-id>.yaml` atomically;
- reloads and validates the complete profile set;
- creates and pins the persistent control panel;
- synchronizes that guild's enabled slash commands.

Use `/setup status` to inspect onboarding. Run `npm run deploy:commands` after
changing command definitions or enabled feature modules. All setup responses
are private. Existing profiles are never overwritten by `/setup initialize`.

After setup, join a voice channel and use `/play`, or type a song name or
supported URL directly into the configured control channel. For every other
command and every `/settings` option, see the
[user guide](docs/user-guide.md).

### Manual profile setup

Prefer this path for local development, or when running without `/setup`:

1. Copy `.env.example` to `.env` and fill in shared infrastructure secrets.
2. Copy `config/instances/bot.env.example` to an instance `.env` and fill in
   its Discord identity and persistence settings.
3. Create the instance's configured `GUILD_CONFIG_DIRECTORY`.
4. Copy `config/examples/guild.example.yaml` into that directory.
5. Rename and edit the profile with the real guild, role, and channel IDs.
6. Install dependencies with `npm install`.
7. Validate every local profile with `npm run config:validate`.
8. Deploy global setup and every configured guild with `npm run deploy:commands`.
9. Start the bot with `npm run dev`.

Deploy only one configured guild when iterating locally:

```powershell
npm run deploy:commands -- --guild 123456789012345678
```

Commands are always registered as guild commands. Each profile's `features`
section determines which command modules are visible in that server. Running
the deployment without `--guild` updates every locally configured guild. The
sole global command is `/setup`. Synchronizing bootstrap commands replaces
the application's global command manifest, preventing legacy global music
commands from leaking into every server.

### Local Docker Compose

For a compact list of native, Docker, deployment, and multi-instance commands,
see the [launch command cheatsheet](docs/launch-cheatsheet.md).

Docker Compose runs the bot, PostgreSQL, and Lavalink in the same private
network. Database and Lavalink ports are bound only to Windows localhost, not
to the public network.

1. Install Docker Desktop and start its Linux container engine.
2. Fill in `.env`; `LAVALINK_PASSWORD` is shared automatically with Lavalink.
3. Build and start the bot, PostgreSQL, and Lavalink:

```powershell
npm.cmd run stack:up
```

In another terminal, register Discord commands without restarting the running
bot:

```powershell
docker compose run --rm bot node dist/scripts/deploy-commands.js
```

Stop the local stack with `Ctrl+C`, or use `docker compose down` after starting
it in detached mode. The guild profiles and runtime state are bind-mounted and
survive container replacement. Only one bot replica should run at a time.

For native TypeScript hot reload backed by containerized infrastructure, start
the infrastructure services in one terminal and the bot in another:

```powershell
npm.cmd run dev:services
npm.cmd run dev
```

PostgreSQL and Lavalink bind only to Windows localhost for native development;
containers reach them through the private Compose network. PostgreSQL data is
stored in the `postgres-data` named volume. Compose runs Drizzle migrations
before starting the bot and selects PostgreSQL persistence automatically.

Native execution supports either persistence driver:

```env
# YAML guild profiles and JSON control-panel state
PERSISTENCE_DRIVER=file

# PostgreSQL guild profiles and control-panel state
PERSISTENCE_DRIVER=postgres
DATABASE_URL=postgresql://fntu_bot:password@127.0.0.1:5432/fntu_bot
```

Run native PostgreSQL migrations with `npm.cmd run db:migrate`. PostgreSQL
configuration reads are cached in process after startup, while setup and panel
writes are persisted transactionally through their repository adapters.

To switch an existing file-backed installation, run the migration and then the
non-destructive importer before selecting the PostgreSQL driver:

```powershell
npm.cmd run db:migrate
npm.cmd run db:import-files
```

The importer copies validated YAML profiles and JSON panel identities in one
transaction and preserves database rows that already exist.

#### Spotify links

Create a Spotify Web API application, then set `SPOTIFY_CLIENT_ID` and
`SPOTIFY_CLIENT_SECRET` in `.env`. Compose passes both values only to Lavalink;
they are not stored in guild configuration or the Docker image. LavaSrc resolves
Spotify metadata and mirrors playback through the configured YouTube/SoundCloud
providers because Spotify itself is not used as the audio stream.

### Native Windows startup without Docker

For an initial Windows test, the bot can use file persistence and a downloaded
workspace-local Java/Lavalink runtime. No system Java or PostgreSQL installation
is required.

```powershell
npm.cmd run local:setup
npm.cmd run local:start
```

`local:setup` downloads Eclipse Temurin JRE 21 and Lavalink into the ignored
`tools/local` directory. `local:start` launches Lavalink, waits for port 2333,
then starts one stable TypeScript bot process. Set `PERSISTENCE_DRIVER=file` in
the default instance `.env` for this workflow. Stop both processes with `Ctrl+C`.
Use `npm.cmd run dev` separately only when intentional TypeScript hot reload is
needed; do not run it alongside `local:start` for the same Discord application.

### Multiple Discord applications

The root `.env` contains shared infrastructure values such as Lavalink,
Spotify, YouTube OAuth, PostgreSQL administration, and an optional shared chat
provider. Each Discord application overlays it with
`config/instances/<instance>.env`. The command argument must exactly match that
filename: `myinstance` loads `config/instances/myinstance.env`.

Create the first overlay from the current legacy `.env` without moving its
database, guild profiles, or runtime assets:

```powershell
npm.cmd run instance:init -- myinstance
npm.cmd run instance:promote-default -- myinstance
```

The initializer refuses to overwrite an existing file. `promote-default` moves
application ownership out of the root `.env` by removing Discord, persistence,
database URL, guild-directory, and runtime-directory values after verifying the
instance overlay. It leaves `DEFAULT_INSTANCE=myinstance`, so legacy commands such
as `local:start`, `local:check-token`, and `deploy:commands` continue resolving
`myinstance` automatically. For another application,
copy `config/instances/bot.env.example` to `otherinstance.env` and give it a
unique Discord application ID, database URL, guild configuration directory,
and runtime data directory. Real instance `.env` files are ignored by Git.

Validate every discovered instance and reject shared application IDs,
databases, configuration directories, or asset directories:

```powershell
npm.cmd run instances:validate
```

Manage one application:

```powershell
npm.cmd run instance:check-token -- myinstance
npm.cmd run instance:config:validate -- myinstance
npm.cmd run instance:db:migrate -- myinstance
npm.cmd run instance:deploy -- myinstance
npm.cmd run instance:start -- myinstance
```

`instance:start` starts only that Discord bot and expects shared infrastructure
to be running. The same is true for the multi-instance launcher:

```powershell
npm.cmd run instances:start
```

Names can also be supplied to run a selected subset:

```powershell
npm.cmd run instances:start -- myinstance otherinstance
```

Each bot remains a separate process and Discord/Lavalink session, but the
combined launcher prefixes their output and stops the group if a process fails.
To start the workspace-local Lavalink service and every discovered bot with one
native command, run:

```powershell
npm.cmd run all:start
```

Names may be supplied to `all:start` to launch only those bots. This path does
not require Docker when file persistence is selected. With PostgreSQL
persistence, start PostgreSQL separately and point every instance at a different
logical database. Legacy `local:start` and `deploy:commands` continue to use the
root `.env` unchanged.

## Configuring the AI chatbot

Mention chat uses any provider exposing an OpenAI-compatible
`/chat/completions` endpoint. Configure all three values together in `.env`:

```env
CHAT_API_KEY=your_private_provider_key
CHAT_BASE_URL=https://your-provider.example/v1
CHAT_MODEL=your-provider-model-name
CHAT_API_MODE=chat_completions
```

Use `CHAT_API_MODE=responses` with OpenAI's Responses API to enable guarded
image input, optional model-selected web search, and LLM tool calling (dice,
8-ball, booru search, memory/birthday lookup, music control — see
`/settings chat chatbot tool-calling`). Keep `chat_completions` for generic
OpenAI-compatible providers that do not implement Responses.

Optional: `CHAT_FALLBACK_MODELS` (comma-separated) walks an ordered list of
backup models on a 429/quota error instead of failing the turn outright.
`CHAT_EMBEDDING_MODEL` (e.g. `text-embedding-3-small`) enables vector-assisted
guild-knowledge recall — semantic search over confirmed guild facts, additive
to the existing keyword-overlap ranking. Both are opt-in; leaving them unset
keeps today's single-model, keyword-only behavior.

Responses generation settings belong to each bot instance:

```env
CHAT_REASONING_EFFORT=low
CHAT_VERBOSITY=low
CHAT_MAX_OUTPUT_TOKENS=2048
```

Supported reasoning values remain model-dependent. These settings are ignored
by the generic Chat Completions provider.

All `CHAT_*` values, including provider credentials, base URL, model, and API
mode, are instance-owned and must be placed in `config/instances/<name>.env`.
Named instances deliberately do not inherit `CHAT_*` values from the shared
`.env`, allowing separate projects, keys, model choices, and usage accounting.
The API key is a secret.

To enable the behavior for a guild and assign its initial access policy, run
`/settings chatbot` — see the
[chat settings reference](docs/user-guide.md#chat) for every option
(web search, image input/generation, tool calling, personality upload, and
more). Advanced self-hosted installations may still set `chat.personalityFile`
directly in guild YAML; an uploaded personality takes precedence. See
[`docs/personality-guide.md`](docs/personality-guide.md) for how to write a
character personality file that reads like a real chat participant instead of
an assistant.

Every provider call emits content-free usage logs. The start record includes
the model, API mode, generation settings, Discord identifiers, image count, and
web-search mode. The completion record adds latency, whether search was actually
used, citation count, provider-reported token counts (including cached input and
reasoning when available), and character/count totals for each context layer.
Questions, replies, personality text, image bytes, responses, and API keys are
never included in these usage records.

At launch, each instance also logs a content-safe effective configuration
summary: instance name, environment, persistence driver, chat API mode, model,
reasoning effort, verbosity, output limit, enabled guild features, and guild
chat capabilities. API keys, personality contents, and conversation data are
never included.

## Configuration boundaries

The root `.env` contains shared infrastructure secrets such as Lavalink and
provider credentials. Each instance file contains that Discord application's
token, application ID, trusted operator IDs, persistence connection, and local
paths. Local YAML profiles contain ordinary guild policy and are ignored by Git.

The committed example documents the complete initial schema:

- feature enablement;
- branding;
- administrator, music-controller, and restricted role mappings;
- allowed music command channels;
- future control-panel and audit-log channels;
- volume and voice lifecycle defaults.

If a profile is missing or invalid, the application fails safely. A guild the
bot has joined without a profile cannot execute commands.

## Persistent music control channel

Set `channels.controlPanel` in a guild profile. On startup the bot restores the
stored panel message; if that message or channel changed, it creates a new
panel and stores the identity under `data/local/control-panels.json`.

Users can join a voice channel and type a song name or supported URL directly
into the configured control channel. The request and temporary status response
are removed so the persistent panel remains the channel's focal message.

The bot needs View Channel, Send Messages, Embed Links, Read Message History,
and Manage Messages in that channel.

Pause/Resume, Skip, and Stop buttons require a `musicController` or
`botAdministrator` role. A restricted role denies typed requests and panel
controls unless the configured bot-owner bypass applies.

## Access precedence

The role-first authorization order is:

1. The guild must have a valid local profile.
2. The command's feature module must be enabled.
3. A member with a configured restricted role is denied.
4. A configured owner may bypass that denial when the command permits it.
5. Owner-only policy is checked.
6. Guild and command channel restrictions are checked.
7. Required semantic role groups are checked.
8. Native member and bot Discord permissions are checked.

`botAdministrator` inherits `musicController` access. Restricted roles still
win unless owner bypass is enabled for that command.

Command implementations do not perform these checks themselves. Every command
passes through the shared access-policy service before execution.

## Development

### Generate a slash-command template

Create a command class and matching test stub with the repository conventions:

```powershell
npm.cmd run command:create -- server-info common "Shows server information."
```

Supported modules are `common`, `music`, and `diagnostics`. Music templates use
the music-controller access policy, diagnostics templates are owner-only, and
common templates use the standard public policy. The generator refuses to
overwrite existing files. After generation, implement the handler and register
the command in `src/bootstrap/dependencies.ts`.

### Run project checks

```powershell
npm run check
npm run build
```

On Windows PowerShell, use `npm.cmd` instead of `npm` if the execution policy
blocks `npm.ps1`:

```powershell
npm.cmd run check
npm.cmd run build
```

## Further documentation

- [User guide](docs/user-guide.md) — every slash command, the control panel,
  AI chat behavior, and the full `/settings` reference.
- [Launch command cheatsheet](docs/launch-cheatsheet.md) — native, Docker,
  deployment, and multi-instance commands at a glance.
- [Architecture](docs/architecture.md) — dependency boundaries and
  implementation slices.
- [Personality guide](docs/personality-guide.md) — writing a guild chatbot
  personality file.
