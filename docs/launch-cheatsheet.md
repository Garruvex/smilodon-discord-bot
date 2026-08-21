# Launch command cheatsheet

Run commands from the repository root. In Windows PowerShell, use `npm.cmd`
instead of `npm` if the execution policy blocks `npm.ps1`.

## Choose the correct launcher

| Configuration | Launch command | What it starts |
| --- | --- | --- |
| Default/single instance | `npm.cmd run local:start` | One Lavalink process and the default bot instance |
| Complete native multi-instance stack | `npm.cmd run instances:start:local` | PostgreSQL, Lavalink, and every `config/instances/*.env` bot |
| Every configured instance, infrastructure already running | `npm.cmd run instances:start` | Every configured bot only |
| Selected instances, infrastructure already running | `npm.cmd run instances:start -- myinstance otherinstance` | Only the named bots |
| One instance, infrastructure already running | `npm.cmd run instance:start -- myinstance` | Only the named bot; no Lavalink or PostgreSQL |

Do not use `local:start` to launch a multi-instance configuration: it resolves
only the default instance.

## Native Windows (single instance)

Set the desired `PERSISTENCE_DRIVER` in the instance selected by
`DEFAULT_INSTANCE`, then:

| Goal | Command |
| --- | --- |
| One-time local Java and Lavalink setup | `npm.cmd run local:setup` |
| Start Lavalink, the selected bot, and PostgreSQL when configured | `npm.cmd run local:start` |
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
| Validate all instance files | `npm.cmd run instances:validate` |
| Build and start declared bots, PostgreSQL, and Lavalink | `npm.cmd run stack:up` |
| Start native PostgreSQL and Lavalink together | `npm.cmd run services:start` |
| Start PostgreSQL and Lavalink in Docker (detached) | `npm.cmd run services:start:docker` |
| Follow stack logs | `npm.cmd run stack:logs` |
| Restart both bot containers | `npm.cmd run stack:restart:bot` |
| Stop and remove the stack containers | `npm.cmd run stack:down` |
| Erase PostgreSQL and rebuild from the baseline | `npm.cmd run stack:reset` |
| Deploy commands for both Docker instances | `npm.cmd run stack:deploy` |
| Render the effective Compose configuration | `npm.cmd run stack:config` |

The root `.env` contains shared infrastructure values only. `compose.yaml`
declares `bot-yohta` and `bot-pinecone`, which load their matching files under
`config/instances/`. Compose waits for PostgreSQL and Lavalink, then each bot
migrates its isolated schema, registers its Discord commands, and starts. Add
another bot by copying a bot service entry; all instances reuse the same image,
PostgreSQL database, and Lavalink.

`services:start` runs the workspace-local PostgreSQL and Lavalink processes in
one foreground terminal. Use `services:start:docker` for the same two services
in detached containers, then run the bot separately.

## Discord command registration

Docker bot startup registers updated slash commands automatically. Native bot
startup does not.

| Goal | Command |
| --- | --- |
| Deploy global setup and configured guild commands | `npm.cmd run deploy:commands` |
| Deploy commands to one guild | `npm.cmd run deploy:commands -- --guild GUILD_ID` |

Run deployment after changing command definitions or enabled feature modules.

## Multiple bot instances

Replace `INSTANCE` with the matching filename stem under `config/instances/`.
For example, `myinstance` loads `config/instances/myinstance.env`.

| Goal | Command |
| --- | --- |
| Validate all instance definitions | `npm.cmd run instances:validate` |
| Start local services and every configured instance | `npm.cmd run instances:start:local` |
| Start local services and selected instances | `npm.cmd run instances:start:local -- myinstance otherinstance` |
| Start every configured instance | `npm.cmd run instances:start` |
| Start selected instances | `npm.cmd run instances:start -- myinstance otherinstance` |
| Start one instance | `npm.cmd run instance:start -- INSTANCE` |
| Check one instance token | `npm.cmd run instance:check-token -- INSTANCE` |
| Validate one instance configuration | `npm.cmd run instance:config:validate -- INSTANCE` |
| Migrate one instance database | `npm.cmd run instance:db:migrate -- INSTANCE` |
| Deploy one instance's commands | `npm.cmd run instance:deploy -- INSTANCE` |
| Synchronize every instance's bundled application emojis | `npm.cmd run instance:emojis:sync` |
| Synchronize selected instances' bundled application emojis | `npm.cmd run instance:emojis:sync -- INSTANCE...` |

Both `instance:start` and `instances:start` expect Lavalink and PostgreSQL (when
selected) to already be running. `instances:start:local` supplies both
infrastructure services before launching the selected bots.

## Before a release or troubleshooting

| Goal | Command |
| --- | --- |
| Run typecheck, lint, and tests | `npm.cmd run check` |
| Build production JavaScript | `npm.cmd run build` |
| Run tests once | `npm.cmd run test` |
| Validate guild profiles | `npm.cmd run config:validate` |
| Apply one instance's PostgreSQL migrations | `npm.cmd run instance:db:migrate -- INSTANCE` |

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
npm.cmd run instance:check-token -- myinstance
npm.cmd run instance:check-token -- otherinstance
npm.cmd run instance:deploy -- myinstance
npm.cmd run instance:deploy -- otherinstance
npm.cmd run instances:start:local -- myinstance otherinstance
```

To launch every discovered instance, omit the names from the last command:

```powershell
npm.cmd run instances:start:local
```

Each instance needs a unique Discord application ID, guild configuration, and
runtime directory. PostgreSQL connection credentials are shared through the
root `.env` `POSTGRES_*` values.

Every PostgreSQL instance automatically gets its own schema derived from its
instance name (`my-bot` becomes `my_bot`). Instances can therefore share one
server and database without sharing tables. The application
never falls back to the `public` schema. `npm run instance:db:migrate -- <name>`
creates and migrates the correct schema.
