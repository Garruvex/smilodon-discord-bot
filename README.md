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
  personal reminders, quote cards (right-click a message, or `/quote`),
  join announcement cards, leave announcements, reaction-role menus, furry/animal image
  commands, and more — see the
  [command reference](docs/user-guide.md#commands).
- A mention-based AI chatbot (any OpenAI-compatible provider, or Google
  Gemini natively) with optional ambient replies, per-guild personality and
  example-exchange files (with in-Discord starter templates via
  `/settings chat template`), per-user memory and customization, image
  input/generation, web search, and tool calling into bot features like dice
  rolls and image search.
- A global `/setup` bootstrap command gated by Discord's Manage Server
  permission, and repository-backed `/settings` for everything else — no
  file editing required to run a guild.
- Optional channel-context memory: point the bot at specific channels for a
  one-time history scan and/or ongoing daily summaries, folded into durable
  guild knowledge with per-fact trust rules — see
  [Channel-context memory](#channel-context-memory).
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
POSTGRES_PASSWORD=choose_a_private_database_password
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

The root file is shared infrastructure only. Discord credentials, persistence,
storage paths, and optional AI provider settings belong to the selected
instance file. `DEFAULT_INSTANCE` is the filename stem used by native commands
that do not receive an explicit instance name. Docker services reference their
instance files directly in `compose.yaml`; the root `.env` does not decide
which bots start.

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

On Windows without Docker, select either `PERSISTENCE_DRIVER=file` or
`PERSISTENCE_DRIVER=postgres` in the default instance file and run:

```powershell
npm.cmd run local:setup
npm.cmd run local:start
```

`local:setup` is safe to rerun and installs workspace-local Java, Lavalink,
PostgreSQL, and the required plugins. `local:start` automatically starts
PostgreSQL and applies migrations when the selected instance uses the
`postgres` driver. After inviting the bot, the server owner
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
changing a command's definition (name, description, or options) or after a
guild is newly configured. Toggling a feature module on or off through
`/settings` takes effect immediately and needs no redeploy — every command is
always registered, and a disabled feature's commands are rejected at runtime
instead of being hidden from the picker. All setup responses are private.
Existing profiles are never overwritten by `/setup initialize`.

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

Commands are always registered as guild commands, and every command is always
deployed to every configured guild regardless of that profile's `features`
section — a disabled feature's commands are rejected at runtime instead of
being left off the guild's command list. Running the deployment without
`--guild` updates every locally configured guild. The sole global command is
`/setup`. Synchronizing bootstrap commands replaces the application's global
command manifest, preventing legacy global music commands from leaking into
every server.

### Local Docker Compose

For a compact list of native, Docker, deployment, and multi-instance commands,
see the [launch command cheatsheet](docs/launch-cheatsheet.md).

Docker Compose runs PostgreSQL 17 with pgvector, Lavalink, and the declared bot
services in the same private network. Database and Lavalink ports are bound
only to Windows localhost, not to the public network.

[`compose.example.yaml`](compose.example.yaml) is the generic copy-and-edit
template. Copy it to `compose.yaml` and replace the `myinstance` placeholders
with the instance names used in your own deployment.

1. Install Docker Desktop and start its Linux container engine.
2. Set `DATA_ROOT`, `POSTGRES_PASSWORD`, and `LAVALINK_PASSWORD` in `.env`.
  The bot services and their instance files are listed directly in your local
  `compose.yaml`.
3. Validate the configured instances:

```powershell
npm.cmd run instances:validate
```

4. Build and start the complete stack:

```powershell
npm.cmd run stack:up
```

`stack:up` builds one production bot image and starts the declared bot services
after healthy infrastructure. Each bot migrates its own schema, registers its
Discord commands, and then starts. Add another bot by copying one short bot
service entry and changing its env file and data paths; no generated Compose
overlay is involved.

Docker startup registers commands automatically. To register them again without
restarting the running bots:

```powershell
npm.cmd run stack:deploy
```

Stop the stack with `npm.cmd run stack:down`. Persistent Docker state is
organized below `DATA_ROOT` (default `./data`): PostgreSQL under `postgres/`,
Lavalink under `lavalink/`, and bot runtime state under `instances/<name>/`.
Guild configuration remains under `config/local/instances/<name>/`.

To deliberately discard the shared PostgreSQL cluster and rebuild all declared
instance schemas from the current baseline, run `npm.cmd run stack:reset`. This
stops the stack and permanently removes only `${DATA_ROOT}/postgres` before
starting again; instance files and runtime assets are preserved.

For native TypeScript hot reload backed by containerized infrastructure, start
the infrastructure services in one terminal and the bot in another:

```powershell
npm.cmd run services:start:docker
npm.cmd run dev
```

PostgreSQL and Lavalink bind only to Windows localhost for native development;
containers reach them through the private Compose network. PostgreSQL data is
stored under `${DATA_ROOT}/postgres`. Compose always selects PostgreSQL
persistence, creates one schema per instance, and runs Drizzle migrations
before starting each bot.

Native execution supports either persistence driver:

```env
# YAML guild profiles, JSON control-panel state, and a local SQLite database
# for chat sessions/memory/guild knowledge
PERSISTENCE_DRIVER=file

# PostgreSQL guild profiles, control-panel state, and chat/knowledge tables.
# Connection settings come from POSTGRES_* in the shared root .env.
PERSISTENCE_DRIVER=postgres
```

Run native PostgreSQL migrations with
`npm.cmd run instance:db:migrate -- myinstance`. PostgreSQL
configuration reads are cached in process after startup, while setup and panel
writes are persisted transactionally through their repository adapters. Under
`PERSISTENCE_DRIVER=file`, chat/knowledge state lives in a single SQLite file
(`<runtimeDataDirectory>/chat.sqlite`), created and migrated automatically on
first run — this is a dev-only backend, kept separate from the YAML/JSON
guild config and panel state.

To switch an existing file-backed installation, run the migration and then the
non-destructive importer before selecting the PostgreSQL driver:

```powershell
npm.cmd run instance:db:migrate -- myinstance
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
`tools/local` directory. `local:start` launches Lavalink and, when selected,
PostgreSQL; waits for their configured ports; applies database migrations; then
starts one stable TypeScript bot process. Stop the process group with `Ctrl+C`.
Use `npm.cmd run dev` separately only when intentional TypeScript hot reload is
needed; do not run it alongside `local:start` for the same Discord application.

### Multiple Discord applications

The root `.env` contains shared infrastructure values such as Lavalink,
Spotify, YouTube OAuth, and PostgreSQL administration. Each Discord application
and its optional chat providers are defined in
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
instance overlay. It leaves `DEFAULT_INSTANCE=myinstance`, so default commands such
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
npm.cmd run instances:start:local
```

Names may be supplied to `instances:start:local` to launch only those bots. It
starts the workspace-local PostgreSQL and Lavalink services before launching
the selected instances. Each PostgreSQL-backed instance must point at an
existing logical database, or instances may share a database with isolated
schemas. `local:start` and `deploy:commands` use the instance selected by
`DEFAULT_INSTANCE`.

PostgreSQL schema isolation is automatic. Every PostgreSQL instance uses a
schema derived from `INSTANCE_NAME` (`my-bot` becomes `my_bot`), so instances
share the PostgreSQL connection derived from root `POSTGRES_*` values without
sharing tables. There is no
configuration flag and no application fallback to the `public` schema.

## Configuring the AI chatbot

Mention chat uses any provider exposing an OpenAI-compatible
`/chat/completions` endpoint, or Google's Gemini API natively. One API key per
supported vendor is configured once and shared by both the main chat task and
the optional utility task below — each task just picks a provider/model and
draws its credential from whichever key matches, so using the same vendor for
both never means pasting the same key twice:

```env
OPENAI_API_KEY=your_private_provider_key
OPENAI_BASE_URL=https://your-provider.example/v1
GOOGLE_API_KEY=your_google_api_key
```

`OPENAI_BASE_URL` defaults to `https://api.openai.com/v1` and only needs
overriding for a third-party OpenAI-compatible endpoint (OpenRouter,
self-hosted, etc.) — xAI, OpenAI, and any such endpoint all use
`OPENAI_API_KEY`. There's one `OPENAI_BASE_URL` per instance, not one per
task, so a task that needs a genuinely different OpenAI-compatible endpoint
than the other task isn't representable this way.

Main chat is then just:

```env
CHATBOT_MODEL=your-provider-model-name
CHATBOT_PROVIDER=openai
CHATBOT_MODE=chat_completions
```

`CHATBOT_PROVIDER` picks which key above this task uses: `openai` (default)
or `gemini`. Within `openai`, `CHATBOT_MODE` picks the wire variant —
`chat_completions` (default) for generic OpenAI-compatible providers, or
`responses` for OpenAI's own Responses API to enable guarded image input,
optional model-selected web search, and LLM tool calling (dice, 8-ball, booru
search, memory/birthday lookup, music control — see
`/settings chat chatbot tool-calling`).

`CHATBOT_PROVIDER=gemini` gets the same image input, tool calling, and web
search feature set, backed by Gemini's own `googleSearch` grounding tool and
native multimodal image output rather than OpenAI's. `CHATBOT_MODE` doesn't
apply in this mode — Gemini has no chat_completions/responses split, so
setting it is rejected at startup rather than silently ignored.
`CHATBOT_GEMINI_THINKING_BUDGET` (tokens; `0` disables thinking, `-1` is
automatic) is optional and Gemini-only.

Provider support matrix — every mode implements channel-summarization (used
by [channel-context memory](#channel-context-memory)) and vector-assisted
recall (configured independently with `EMBEDDING_PROVIDER` and `EMBEDDING_MODEL`); the rest vary:

| Capability | `chat_completions` | `responses` | `gemini` |
| --- | --- | --- | --- |
| Image input | ❌ | ✅ | ✅ |
| Image generation | ❌ | ✅ | ✅ (native) |
| Web search | ❌ | ✅ | ✅ (`googleSearch` grounding) |
| Tool calling | ❌ | ✅ | ✅ |
| Channel summarization | ✅ | ✅ | ✅ |
| Vector-assisted recall (OpenAI or Gemini embeddings) | ✅ | ✅ | ✅ |

Enabling a capability a mode doesn't support (e.g. web search under
`chat_completions`) is inert, not an error — the guild toggle has no effect
in that mode, logged once per guild per process as a warning.

Optional: `CHATBOT_FALLBACK_MODELS` (comma-separated) walks an ordered list of
backup models on a 429/quota error instead of failing the turn outright.
`EMBEDDING_PROVIDER` plus `EMBEDDING_MODEL` (for example, OpenAI
`text-embedding-3-small` or a Gemini embedding model) enables vector-assisted
recall independently of the chat provider. You can mix Gemini chat with OpenAI
embeddings or OpenAI chat with Gemini embeddings. Leaving `EMBEDDING_MODEL`
unset keeps keyword-only behavior. The legacy `CHATBOT_EMBEDDING_MODEL` remains
accepted as an OpenAI configuration.

Optional: `CHATBOT_SUMMARY_MODEL` (+ `CHATBOT_SUMMARY_FALLBACK_MODELS`, same
comma-separated shape as above) points standalone structured-output calls
that aren't a chat reply — customization-file analysis, dropped-exchange
consolidation, and channel-history summaries — at a separate, typically cheaper/smaller model on
the **same provider/key** as `CHATBOT_*`, since those are low-stakes extraction
tasks that don't need the primary reply model's quality. Leave unset to keep
using `CHATBOT_MODEL`/`CHATBOT_FALLBACK_MODELS` for those calls too.

`CHATBOT_SUMMARY_REASONING_EFFORT` (default `low`) and
`CHATBOT_SUMMARY_MAX_OUTPUT_TOKENS` (default `4096`) independently control
OpenAI Responses structured summaries. This keeps interactive replies on their
own `CHATBOT_REASONING_EFFORT`/`CHATBOT_MAX_OUTPUT_TOKENS` budget. A channel
summary that returns `status: incomplete` is retried on the configured summary
fallback model and reports the provider's incomplete reason if all models fail.

For a genuinely independent model for those same two calls — own provider,
even a different vendor entirely (e.g. main chat on OpenAI, utility calls on
Gemini) — use the `UTILITY_*` namespace instead, same shape as `CHATBOT_*`
(`UTILITY_MODEL`/`UTILITY_PROVIDER`/`UTILITY_MODE`/`UTILITY_FALLBACK_MODELS`/
`UTILITY_GEMINI_THINKING_BUDGET`). It supersedes `CHATBOT_SUMMARY_MODEL`
entirely when set. Both are optional — leaving everything unset keeps the two
calls on the primary `CHATBOT_MODEL` chain, same as before either of these
existed. Since credentials come from the shared `OPENAI_API_KEY`/
`GOOGLE_API_KEY` pool above rather than a per-task key, pointing `UTILITY_*`
at the same vendor as `CHATBOT_*` is free — only pointing it at a
*different* vendor needs a second key configured.

Responses generation settings belong to each bot instance:

```env
CHATBOT_REASONING_EFFORT=low
CHATBOT_VERBOSITY=low
CHATBOT_MAX_OUTPUT_TOKENS=2048
```

Supported reasoning values remain model-dependent. These settings are ignored
by the generic Chat Completions provider.

`OPENAI_*`/`GOOGLE_*`, `CHATBOT_*`, and `UTILITY_*` — every value covered
above — are all instance-owned and must be placed in
`config/instances/<name>.env`. Named instances deliberately do not inherit
these values from the shared `.env`, allowing separate projects, keys, model
choices, and usage accounting. API keys are secrets.

To enable the behavior for a guild and assign its initial access policy, run
`/settings chat chatbot` — see the
[chat settings reference](docs/user-guide.md#chat) for every option
(web search, image input/generation, tool calling, personality and
example-exchange upload, and more). `/settings chat template` sends a starter
`personality.md` or `examples.md` file to download, edit, and upload back.
Advanced self-hosted installations may still set `chat.personalityFile`
directly in guild YAML; an uploaded personality takes precedence. See
[`docs/personality-guide.md`](docs/personality-guide.md) for how to write a
character personality file — and an optional example-exchanges file to teach
its actual voice — that reads like a real chat participant instead of an
assistant.

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

## Channel-context memory

Beyond per-conversation memory, an admin can point the bot at specific
channels so it builds durable, guild-wide knowledge from the messages that
happen there — without anyone needing to talk to the bot directly. Two
independent modes, both configured with `/settings chat`:

- **One-time scan** (`context-scan-add channel:# seed-days:7`) — reads that
  channel's past history back to `seed-days` (default 7) once, folds it into
  memory, then never runs again for that channel unless you explicitly pass
  `restart:true` (which re-reads from the seed boundary, replacing scan
  progress; existing memories from the prior scan are not deleted).
- **Daily consolidation** (`context-daily-add channel:#`) — summarizes each
  day's new messages, checked hourly. Independent of the scan set; a channel
  can be in either, both, or neither.

`context-daily-remove` and `context-remove` (both scan and daily) stop future
processing for a channel; already-written memories are kept, not bulk-deleted,
and re-adding the channel later resumes rather than re-reading the same
history. `context-status` shows provider availability, whether the chatbot
feature is currently paused, and each configured channel's scan/daily
progress, cursor, and last error.

**Requirements**: a chat provider must be configured (`CHATBOT_*` or
`UTILITY_*`, whichever this instance's scheduler prefers) that implements
channel summarization — every built-in provider mode does. `context-scan-add`
and `context-daily-add` reject outright, rather than silently queuing
something that will never run, when none is configured. Disabling the guild's
`chatbot` feature pauses all channel-context processing (no config or
checkpoint is touched) until it's re-enabled, resuming exactly where it left
off.

**Processing model**: messages are read in bounded batches (at most 75
messages or ~40,000 characters per model call, whichever comes first) so a
busy channel makes steady, incremental progress across hourly ticks rather
than one unbounded request. Each batch's outcome only advances that channel's
saved progress after the batch's facts are successfully written to memory —
a failed batch (provider error, database error) is retried on the next tick
from the same starting point, never silently skipped.

**Trust**: a fact about the guild, a team, or a project becomes active
(recallable) knowledge as soon as it's extracted. A fact *about a specific
member* only does the same when that member's own message is the evidence
behind it (a genuine self-report); a claim one member makes about another
stays an unconfirmed candidate, the same as it would from an ordinary chat
turn — participating in a channel that gets summarized never lets someone
else's claim about you become durable memory on your behalf. Extraction also
refuses to store secrets, credentials, and medical/financial/contact/
moderation/authority-related statements, the same content filter applied
everywhere else guild knowledge is written.

**Data retention**: channel-context memories are stored in the same unified
memory table as every other guild-knowledge fact, and follow the same
retention as the rest of that table — `context-remove`/`context-daily-remove`
stop future writes but never bulk-delete what's already there (use
`/memory forget` for a specific fact). The `retain-member-data-on-leave:false`
purge (see `MemberDataPurger`) only deletes a departing member's own
*private*, user-owned data: their private memories (`ownerUserId` matches
them), legacy chat memories, chat session transcripts, DM-notes preference,
birthday, customization, and reminders. Shared guild/channel-audience
memories are community knowledge, not the member's data — this includes any
member-subject fact extracted from channel context (e.g. "Alice prefers
async standups") — so those are retained even after the subject leaves,
the same as anything a member ever said publicly in the guild.

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
