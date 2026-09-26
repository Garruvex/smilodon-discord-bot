# Milestone 1 status: the Discord play slice

What is built, how to turn it on, what still needs a real table, and what was left for later. The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria); the screens are in the [panel specification](dnd-panel-spec.md).

## Turning it on

1. Set the AI dungeon master in the instance env file (see `config/instances/bot.env.example`): `CAMPAIGN_MODEL` (and `CAMPAIGN_PROVIDER`, `CAMPAIGN_FALLBACK_MODELS`, `CAMPAIGN_REASONING_EFFORT`). Keys come from the shared `OPENAI_API_KEY` or `GOOGLE_API_KEY`. Reasoning effort `none` met the latency targets. Without `CAMPAIGN_MODEL`, `/dnd new` says so and starts nothing.
2. Enable the feature for the server in the admin panel's **D&D** group (or `/settings-dnd campaigns enabled:true`, or `features.campaign: true` in the guild profile). The same group has **Set up D&D** (makes the D&D category with a #dnd-games hub, and repairs it), **Move the hub**, the **DnD Admin role**, and a status summary.
3. Run `npm run deploy:commands` so Discord knows `/dnd`.
4. Give the bot the permissions it will list if any are missing: View Channel, Send Messages, Send Messages in Threads, Manage Channels, Manage Roles, Create Public Threads, Manage Threads, Manage Messages, Pin Messages, Embed Links, Read Message History.
5. A bot administrator runs `/dnd setup` (or **Set up D&D** in the panel). It makes the D&D category with a #dnd-games hub channel, a **DnD Admin** role, and the hub's pinned control message. Give the role to whoever should run games. Then press **Create game** in the hub (or run `/dnd new name:<game>`). Data lives in `<RUNTIME_DATA_DIRECTORY>/campaign.sqlite`.

## What a table sees

- **Hub** (#dnd-games in the D&D category): a pinned control message first, with **Create game**, then one message per unfinished game (state, links to its channels, **Manage**). Finished games leave the hub.
- **Create game** opens a private wizard: language, pace and most players in menus, then **Next** asks for the name. Nothing is created until the name is submitted. The choices live in the controls' IDs, so an old wizard still works after a restart.
- **Manage** (private, for the game's organizer and DnD Admins): Pause or Resume, Close round, Retry the DM, Short rest, Long rest, Repair cards, and **End game** (asks first; the game is archived, its clock stops, its channels stay as a record). DnD Admins can also run the `/dnd` organizer commands in any game's channels.
- **Hero cards** (Party channel) always show what the hero wears (armor and shield), the weapons carried, the pack (potions and spare armor), their own gold and the party purse, the party stash, and for casters cantrips, prepared spells and slots left, plus limited uses such as Second Wind. Gear follows the 2014 rules: one armor and one shield are worn, weapons are drawn as needed, and armor is put on or taken off only outside a fight. **My Hero** (private) has a menu to put on or take off the armor and shield the hero carries, outside fights only. A shield in a fight, which costs an action, comes with the combat controls in milestone 2.
- **Gold from fights** is a house rule chosen in the Create game wizard: a shared party purse (the default) or an even split between the heroes still standing, any remainder to the first in party order. The 2014 rules leave treasure to the table.
- **Starting a game**: when the organizer presses Start, the DM tells an opening scene first (the world, the place, the party by name, what draws them in, then "what do you do?"). The panel shows "The DM is setting the scene…", no timer runs while the table reads, and after it the panel asks everyone to press **Ready** (with **Begin now** for the organizer), and round 1 opens when every present player is ready (a player who goes away is not waited for). If the model is down, a template built from the adventure's own text is used. A round in which everyone only passes or misses opens the next round straight away while someone is present (missed rounds still mark players away). Games left without a round by older builds get one at the next restart.
- **If someone deletes a post**: deleting the hub control, a game's hub message, or any of a game's cards draws it again at once (the hub control first, with the games re-posted below it). Deleting the hub channel or a game's channel makes it again and redraws its cards. At startup every card is checked against Discord, so anything deleted while the bot was away comes back. `/dnd repair` (or **Repair cards**) does the same check on demand.
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
- [ ] After the opening, the panel shows Ready for everyone; round 1 opens only when all press it (or the organizer presses Begin now). Take armor off and on from My Hero and watch the hero card and AC.
- [ ] Start a game: the opening scene appears in the Adventure channel first, then the round panel below it; the timer only starts after the opening. Pass the whole round: a new round panel appears at once.
- [ ] Delete the panel message: it comes back after `/dnd repair` or the next round.
- [ ] Delete the hub control message, then a game's hub message, then a game's stats card: each comes back by itself, the control first with the games below it.
- [ ] Delete the hub channel, then a game's adventure channel: each is made again with its cards. Stop the bot, delete a card, start it: the card is back.
- [ ] Create a game with the wizard in each language, as a DnD Admin; a member without the role gets a private refusal on Create game and on Manage.
- [ ] A DnD Admin who is not the organizer pauses and resumes a game from Manage; End game asks first, then the hub message goes and the game stops.
- [ ] Repeat in Traditional Chinese.
- [ ] Rate each transcript with the rubric in the [milestone 0 report](dnd-milestone-0-report.md).

## Left for later milestones

Reopening an ended game; a deleted Table Talk thread is only recreated by `/dnd repair`; Speak (in-character lines as the hero), Journal, Safety, and the More… menu; reminders at 50% of a timer; the staged dice reveal (a result line is posted at once); portraits and images; the inventory and trade screens and the retry-a-lost-fight command (the engine has both; no buttons yet); reaction prompts and combat controls (milestone 2); members-only visibility with a campaign role; the guided character builder (milestone 4); PostgreSQL for campaign data (milestone 6); uploads and the Adventure Author (milestone 4).
