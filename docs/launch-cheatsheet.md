# Launch command cheatsheet

Run commands from the repository root. In Windows PowerShell, use `npm.cmd`
instead of `npm` if the execution policy blocks `npm.ps1`.

## Choose the correct launcher

| Configuration | Launch command | What it starts |
| --- | --- | --- |
| Default/single instance | `npm.cmd run local:start` | One Lavalink process and the default bot instance |
| Every configured instance | `npm.cmd run instances:start` | One shared Lavalink process and every `config/instances/*.env` bot |
| Selected instances | `npm.cmd run instances:start -- pinecone smilodon` | One shared Lavalink process and only the named bots |
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
| Start PostgreSQL and Lavalink only | `npm.cmd run dev:services` |
| Follow stack logs | `npm.cmd run stack:logs` |
| Restart the stack | `npm.cmd run stack:restart` |
| Stop and remove the stack containers | `npm.cmd run stack:down` |
| Deploy commands inside Compose | `docker compose run --rm bot node dist/scripts/deploy-commands.js` |

For native TypeScript development backed by containerized services, run
`npm.cmd run dev:services` in one terminal and `npm.cmd run dev` in another.

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
| Start every configured instance | `npm.cmd run instances:start` |
| Start selected instances | `npm.cmd run instances:start -- pinecone smilodon` |
| Start one instance | `npm.cmd run instance:start -- INSTANCE` |
| Check one instance token | `npm.cmd run instance:check-token -- INSTANCE` |
| Validate one instance configuration | `npm.cmd run instance:config:validate -- INSTANCE` |
| Migrate one instance database | `npm.cmd run instance:db:migrate -- INSTANCE` |
| Deploy one instance's commands | `npm.cmd run instance:deploy -- INSTANCE` |

`instance:start` expects shared infrastructure such as Lavalink and PostgreSQL
(when selected) to already be running. In contrast, `instances:start` launches
one shared local Lavalink process along with all requested bot processes.

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
npm.cmd run instances:start -- pinecone smilodon
```

To launch every discovered instance, omit the names from the last command:

```powershell
npm.cmd run instances:start
```

Each instance needs a unique Discord application ID and isolated persistence,
guild configuration, and runtime directories. If an instance uses PostgreSQL,
start PostgreSQL separately before launching and give each instance a different
logical database.
