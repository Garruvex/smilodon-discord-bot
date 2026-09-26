# Milestone 1 status: the Discord play slice

What is built, how to turn it on, what still needs a real table, and what was left for later. The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria); the screens are in the [panel specification](dnd-panel-spec.md).

## Turning it on

1. Set the AI dungeon master in the instance env file (see `config/instances/bot.env.example`): `CAMPAIGN_MODEL` (and `CAMPAIGN_PROVIDER`, `CAMPAIGN_FALLBACK_MODELS`, `CAMPAIGN_REASONING_EFFORT`). Keys come from the shared `OPENAI_API_KEY` or `GOOGLE_API_KEY`. Reasoning effort `none` met the latency targets. Without `CAMPAIGN_MODEL`, `/dnd new` says so and starts nothing.
2. Enable the feature for the server: the `campaign` switch (admin panel, `/settings-community`, or `features.campaign: true` in the guild profile).
3. Run `npm run deploy:commands` so Discord knows `/dnd`.
4. Give the bot the permissions it will list if any are missing: View Channel, Send Messages, Send Messages in Threads, Manage Channels, Manage Roles, Create Public Threads, Manage Threads, Manage Messages, Pin Messages, Embed Links, Read Message History.
5. A bot administrator runs `/dnd setup` in the channel that should be the hub, then `/dnd new name:<game>` to create a game. Data lives in `<RUNTIME_DATA_DIRECTORY>/campaign.sqlite`.

## What a table sees

- **Hub** (the channel `/dnd setup` ran in): one message listing every game with links to its channels.
- **Each game** gets `<name>` (the Adventure channel) and `<name>-stats` (the Party channel), read-only for players, plus a Table Talk thread under the Party channel.
- **Lobby card** in the Party channel: Join, My Hero, Leave, Start Adventure. Players pick a preset hero; the organizer starts once enough players are ready. The same message turns into the campaign card when play starts, followed by one card per hero.
- **Adventure panel**: one live control message under the latest narration, replaced each round. Act / Edit (a form), Pass, Roll, My Hero (private sheet), Away, I'm back, Continue.
- **History** in the Adventure channel: each roll result line, then the narration. Fights play out on cautious autopilot with a short flourish per round and the outcome and loot at the end.
- **Organizer** (in a game's channels): `/dnd pause`, `resume`, `close-round`, `rest`, `retry`, `repair`, `status`.
- A hero who falls for good is replaced from My Hero with a fresh preset, no old loot.
- After a restart, timed games pause until the organizer runs `/dnd resume`; no deadline fires unattended.

Everything is in `en` and `zh-TW`; `ja` falls back to English text. The game's language is chosen at `/dnd new` and used for cards, history, and private replies.

## Where the code is

| Piece | Location |
| --- | --- |
| Lobby rules | `src/domain/campaign/lobby/` |
| Campaign record, lobby service, play controller, runtime, workers | `src/application/campaign/` |
| Views (what the table sees, as data) | `src/application/campaign/views/` |
| Card renderers, card service, presenter, setup, gateways | `src/infrastructure/discord/campaign/` |
| `/dnd` command, controls | `src/infrastructure/discord/commands/campaign/`, `.../components/campaign-component-handler.ts` |
| Assembly and startup | `src/bootstrap/campaign-module.ts` |
| Store (SQLite) | `src/infrastructure/persistence/campaign/` |

## Tested, and not yet tested

Tested with fakes for Discord and the model: the lobby (including simultaneous joins), record and store contracts on both stores, the runtime and recovery, delivery order and retries, every card renderer in both languages, the card service (edit in place, replace at round change, deleted cards, failed sends, coalescing), server setup and its resume after a failure, the presenter, the controls with fake interactions, and the module's startup.

**Not yet exercised against a real Discord server and model.** The exit criterion asks a real group to play a one-hour Live session in each language and to restart the bot with a roll pending. Use this checklist for the playtest:

- [ ] `/dnd setup` in a fresh server; the hub card appears; the category exists.
- [ ] `/dnd new` creates both channels and the thread; players cannot type in the channels; they can in the thread.
- [ ] Two accounts join at the same moment for the last seat: exactly one gets it.
- [ ] Start; the lobby card becomes the campaign card; hero cards appear; the Adventure panel appears.
- [ ] A full round: Act, Pass, roll result line, narration, new panel below it, old panel gone.
- [ ] A fight: encounter reveal, flourishes, outcome, loot, and a hero at 0 HP waking at 1.
- [ ] Away and I'm back; everyone away puts play on hold and Continue resumes it.
- [ ] Restart the bot with a roll pending: the game shows "paused after a restart"; `/dnd resume` continues and the roll resolves once.
- [ ] Delete the panel message: it comes back after `/dnd repair` or the next round.
- [ ] Repeat in Traditional Chinese.
- [ ] Rate each transcript with the rubric in the [milestone 0 report](dnd-milestone-0-report.md).

## Left for later milestones

Speak (in-character lines as the hero), Journal, Safety, and the More… menu; reminders at 50% of a timer; the staged dice reveal (a result line is posted at once); portraits and images; the inventory and trade screens and the retry-a-lost-fight command (the engine has both; no buttons yet); reaction prompts and combat controls (milestone 2); members-only visibility with a campaign role; the guided character builder (milestone 4); PostgreSQL for campaign data (milestone 6); uploads and the Adventure Author (milestone 4).
