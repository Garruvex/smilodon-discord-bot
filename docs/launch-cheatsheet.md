# Launch command cheatsheet

Run commands from the repository root. In Windows PowerShell, use `npm.cmd`
instead of `npm` if the execution policy blocks `npm.ps1`.

## Choose the correct launcher

| Configuration | Launch command | What it starts |
| --- | --- | --- |
| Default/single instance | `npm.cmd run local:start` | One Lavalink process and the default bot instance |
| Complete native multi-instance stack | `npm.cmd run all:start` | Workspace-local Lavalink and every `config/instances/*.env` bot |
| Every configured instance, infrastructure already running | `npm.cmd run instances:start` | Every configured bot only |
| Selected instances, infrastructure already running | `npm.cmd run instances:start -- pinecone smilodon` | Only the named bots |
| One instance, infrastructure already running | `npm.cmd run instance:start -- pinecone` | Only the named bot; no Lavalink or PostgreSQL |

Do not use `local:start` to launch a multi-instance configuration: it resolves
only the default instance.

## Native Windows (single instance)

Set `PERSISTENCE_DRIVER=file` in `.env`, then:

| Goal | Command |
| --- | --- |
| One-time local Java and Lavalink setup | `npm.cmd run local:setup` |
| Start Lavalink and the bot | `npm.cmd run local:start` |
| Stop both processes | Press `Ctrl+C` |
| Check the Discord token | `npm.cmd run local:check-token` |
| Start Lavalink only | `npm.cmd run local:lavalink` |
| Start the bot with hot reload | `npm.cmd run dev` |
| Start the bot once, without watching | `npm.cmd run dev:once` |

Do not run `local:start`, `dev`, or another launcher at the same time for the
same Discord application.

## Docker Compose

| Goal | Command |
| --- | --- |
| Build and start bot, PostgreSQL, and Lavalink | `npm.cmd run stack:up` |
| Start PostgreSQL and Lavalink only (foreground) | `npm.cmd run dev:services` |
| Start PostgreSQL and Lavalink only (detached/readiness wait) | `npm.cmd run services:docker` |
| Follow stack logs | `npm.cmd run stack:logs` |
| Restart the stack | `npm.cmd run stack:restart` |
| Stop and remove the stack containers | `npm.cmd run stack:down` |
| Deploy commands inside Compose | `docker compose run --rm bot node dist/scripts/deploy-commands.js` |

For native file-backed development, `npm.cmd run services:start` runs only the
workspace-local Lavalink service. For PostgreSQL-backed development, use
`dev:services` in one terminal or `services:docker` for detached containers,
then run the bot separately.

## Discord command registration

Bot startup does not register updated slash commands automatically.

| Goal | Command |
| --- | --- |
| Deploy global setup and configured guild commands | `npm.cmd run deploy:commands` |
| Deploy commands to one guild | `npm.cmd run deploy:commands -- --guild GUILD_ID` |

Run deployment after changing command definitions or enabled feature modules.

## Multiple bot instances

Replace `INSTANCE` with the matching filename stem under `config/instances/`.
For example, `pinecone` loads `config/instances/pinecone.env`.

| Goal | Command |
| --- | --- |
| Validate all instance definitions | `npm.cmd run instances:validate` |
| Start local Lavalink and every configured instance | `npm.cmd run all:start` |
| Start local Lavalink and selected instances | `npm.cmd run all:start -- pinecone smilodon` |
| Start every configured instance | `npm.cmd run instances:start` |
| Start selected instances | `npm.cmd run instances:start -- pinecone smilodon` |
| Start one instance | `npm.cmd run instance:start -- INSTANCE` |
| Check one instance token | `npm.cmd run instance:check-token -- INSTANCE` |
| Validate one instance configuration | `npm.cmd run instance:config:validate -- INSTANCE` |
| Migrate one instance database | `npm.cmd run instance:db:migrate -- INSTANCE` |
| Deploy one instance's commands | `npm.cmd run instance:deploy -- INSTANCE` |
| Synchronize every instance's bundled application emojis | `npm.cmd run instance:emojis:sync` |
| Synchronize selected instances' bundled application emojis | `npm.cmd run instance:emojis:sync -- INSTANCE...` |

Both `instance:start` and `instances:start` expect Lavalink and PostgreSQL (when
selected) to already be running. Native `all:start` supplies Lavalink; a selected
PostgreSQL persistence driver still requires PostgreSQL to be started separately.

## Before a release or troubleshooting

| Goal | Command |
| --- | --- |
| Run typecheck, lint, and tests | `npm.cmd run check` |
| Build production JavaScript | `npm.cmd run build` |
| Run tests once | `npm.cmd run test` |
| Validate guild profiles | `npm.cmd run config:validate` |
| Apply PostgreSQL migrations | `npm.cmd run db:migrate` |

## First launch: single instance

```powershell
npm.cmd install
npm.cmd run local:check-token
npm.cmd run deploy:commands
npm.cmd run local:setup
npm.cmd run local:start
```

After inviting the bot, run `/setup initialize` in Discord. The first local
Lavalink launch may also require YouTube device authorization; see the main
README for the OAuth and environment-variable instructions.

## First launch: multiple instances

Create one `.env` overlay per bot under `config/instances/`, then run:

```powershell
npm.cmd install
npm.cmd run local:setup
npm.cmd run instances:validate
npm.cmd run instance:check-token -- pinecone
npm.cmd run instance:check-token -- smilodon
npm.cmd run instance:deploy -- pinecone
npm.cmd run instance:deploy -- smilodon
npm.cmd run all:start -- pinecone smilodon
```

To launch every discovered instance, omit the names from the last command:

```powershell
npm.cmd run all:start
```

Each instance needs a unique Discord application ID and isolated persistence,
guild configuration, and runtime directories. If an instance uses PostgreSQL,
start PostgreSQL separately and give each instance a different logical database.
