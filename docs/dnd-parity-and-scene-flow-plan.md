# D&D action parity, scene flow, and lifecycle cleanup plan

Status: planning draft, 2026-10-01. Companion to the [panel spec](dnd-panel-spec.md) and the [code structure](dnd-code-structure.md). This defines intended work, not implemented behavior. Findings below come from reading the code on `feat/dnd-followups`; items marked *unverified* were not checked.

## Goals

1. Fix scene changes that happen without warning or agreement.
2. Keep the state of each scene so the party can return to it.
3. Clean up what a finished adventure leaves behind, without breaking reopen.
4. Shape the code so a Discord Activity can later be a second front end over the same engine, with no second rules path.

Non-goals: replacing the Discord panels, or putting any game rule in a web client.

## Findings that drive the plan

- **One write path.** `CampaignCommandBus.execute` ([campaign-command-bus.ts](../src/application/campaign/campaign-command-bus.ts)) serializes per campaign, checks revisions, and dedupes on `commandId`. `Actor` is `{ kind: "user", userId } | { kind: "system" }`. Nothing in it is Discord-specific.
- **Controller and views are Discord-free.** `campaign-play-controller.ts` and `application/campaign/views/*` import nothing from Discord. `TurnView` already returns "only legal choices" as plain data, and the engine re-checks every command.
- **State-to-controls lives in the Discord layer.** `controlsFor` and `combatControls` in [adventure-panel.ts](../src/infrastructure/discord/campaign/adventure-panel.ts) decide which buttons exist per `PanelMode`. A second front end would have to copy it.
- **Action names are mixed.** [campaign-ids.ts](../src/infrastructure/discord/campaign/campaign-ids.ts) has about 50 actions that blend game verbs (`act`, `pass`), menu steps (`turn`, `pick`, `aim`) and navigation (`myHero`, `pack`, `more`, `back`).
- **Scene moves are checked for legality, never for agreement.** The path is Planner `transitionScene` → `resolveStoryEffects` (scene exists, differs from current, reachable through `exits`) → one transition per round → `sceneTransitioned`, which overwrites `sceneId` ([evolve.ts](../src/domain/campaign/events/evolve.ts)).
- **Sources of a sudden jump:** one hero's action can move the whole party (the Planner prompt says "clearly travel"); authored `goto` results fire silently, including on a failed check; a scene without `exits` allows any destination; arrival, narration and image land in one reveal.
- **No scene history.** State keeps only `sceneId` and `sceneChangedRound`. Clues, flags, clocks, `encounterHistory` and killed NPCs are global, so returning to a scene would not reset a fight or replay rewards. Only the per-scene summary is missing.
- **Adventure data has few return links.** A rough check of `private/adventures` (46 adventures) found no scene with empty `exits`, but 16 adventures with no scene that is linked back from its exit target (for example `dream-ruins`, `frogs-below`, `rainy-night`, `ranger-trial`, `red-hood`, `treasure-hunt`). Some may be linear on purpose. The check ignores `requires`. `farm-fright` has no `exits` at all, so the Planner may go anywhere.
- **Ending a game deletes nothing.** `end()` sets `lifecycle: "archived"` and pauses the engine. `reopen()` restores the game paused, where it stopped, if the campaign state still exists. Scene images are held in `FileImageAssetStore` only until posted. Portraits (`FilePortraitStore`) and the monster art library are shared across games.

## Work streams and order

| Stream | Topic | Needed by Activity |
|---|---|---|
| B | Actions and phases: one action registry and one phase model | Yes (the parity layer) |
| A | Scene flow: pending move, agreement, departure record, summaries, data checks | Yes (scene and pending-move UI) |
| C | Lifecycle cleanup | No (backend only); needs A's summaries to survive compaction |
| D | Activity | Depends on B, and on A for the scene UI |

Order: Phase 0, then B, then A, then C, then D. C can move earlier since it is independent. Do not build A's confirm controls as Discord-only code.

## Phase 0: measure first

Count panel edits and HTTP 429s per round on a real session (the panel spec coalesces edits per channel but does not record them). This decides whether Phase 4 is worth doing, and sets the baseline for its savings gate. It is deferred until just before Phase 4. Phases 1 to 3 fix problems in the text version regardless.

Exit check: a number for edits and 429s per round, per channel.

## Phase 1: action registry and phase model (stream B)

- Add `actions(state, viewer) → ActionDescriptor[]` in the application layer. A descriptor has: id, i18n key, enabled or disabled with a reason, and the input it needs (none, target, text, spell and slot).
- Classify every action as one of three kinds: **game** (changes state through the bus), **navigation** (opens a private view, changes nothing), **table control** (pause, safety, away).
- Add an explicit turn phase owned by the domain: open, collecting, resolving, next. The panel spec's state and control matrix becomes data here, including the combat special case.
- Rename actions by kind: plain verbs for game actions, `open*` for navigation. Keep the `dnd:<action>:<campaignId>` custom ID format, and accept the old names when parsing so existing messages keep working.
- The Discord renderer consumes descriptors. User-visible behavior does not change.
- Add a post-commit revision hook beside `onWorkQueued`, publishing `{ campaignId, revision }`. Only the Discord panel updater subscribes for now.

Rules: a descriptor is a rendering hint only. The engine still validates every command. No game rule stays in a Discord handler.

Exit checks: the existing button tests pass unchanged; `controlsFor` and `combatControls` are gone from the Discord layer; no handler contains a rule check the controller does not.

## Phase 2: scene flow (stream A)

### Pending move

- The Planner proposes a move; it does not commit it. A proposed `transitionScene` becomes a **pending move** in state: destination, proposer, round.
- The panel shows "Go to *X*" and "Stay here" as descriptors, with who has agreed.
- Authored and forced moves (an escape, a trapdoor, a story beat) skip agreement but announce first, then move. They carry the reason `forced`.
- Committing a move emits an event with a reason: `agreed`, `forced`, or `retreat`, so the log explains every jump.
- Narration of the old scene, the arrival and the new image are separate steps, not one reveal.

### Scene record

On departure, write one record per **visit**, with its own visit id (the party can visit a scene more than once): scene id, visit id, arrival round, departure round, reason, a short summary, what was left behind (unrevealed clues, untried interactions, living NPCs), and where the party came from. The record is a projection rebuilt from the append-only event log. Only the summary text is deliberately persisted, as its own event, so replay never has to call the model again.

### Going back

Going back is an ordinary move along an exit, validated by the engine. The Adventure panel lists "Where you can go" from `reachableScenes`, which covers backtracking with no separate feature. Dead ends are acceptable only if they list the way they came in.

### Adventure data

Extend the validator at `adventure-document.ts` (it already walks exits):

- error: a scene unreachable from `startScene`;
- error: a scene with no way out that is not marked as an ending;
- warning: a one-way exit, with an explicit per-scene or per-adventure flag for deliberate linear travel.

Then go through the adventures and fix real dead ends. Do not auto-add links: some stories (a train, a dream, a one-way descent) are linear by design.

Exit checks: tests for refused, agreed, forced and timed-out moves; a replay test that rebuilds the scene record from events; the validator run over all adventures with a list of scenes to fix.

## Phase 3: lifecycle cleanup (stream C)

Two tiers, so nothing the organizer may want back is destroyed:

1. **On archive:** cancel pending timers and queued jobs; delete leftover scene-image buffer files. `reopen` still works because state is intact.
2. **After a grace period** (configurable): compact the event log to a final summary plus the scene summaries and each character's results, then remove remaining per-campaign files. After this, reopen is refused, and the end-game confirmation says so.

Safeguards: never remove shared assets (portraits of saved characters, the monster library) as part of a campaign cleanup; make cleanup idempotent and logged so a crash can safely rerun and the organizer can see what was removed.

*Unverified:* which database tables hold events, jobs and card references, and what a safe compaction looks like against that schema. Map them before sizing this phase.

Exit checks: archive then reopen still works inside the grace period; a rerun of cleanup changes nothing; shared assets survive.

## Phase 4: Activity prototype (stream D, only if the Phase 0 numbers support it)

Phase 0 counting is deferred until just before this phase; Phases 1 to 3 do not depend on it.

### Savings gate

Before building, write down what the Activity replaces and what stays in Discord, and the target:

- **Replaces:** routine live-panel edits while a session is actively using the Activity (panel refreshes, turn-menu refreshes, roll-reveal edits).
- **Stays in Discord:** narration, roll results, scene art, and durable history, plus a small launch and status message for entry and recovery.
- **Gate:** a target reduction in edits and 429s per round against the Phase 0 baseline. If the Activity ships but both surfaces keep editing, it adds work without lowering traffic and fails the gate.

### One active surface per campaign

Pick one rule and keep it simple:

- While a campaign has a live Activity session, the Discord panel goes **quiet**: it stops refreshing and shows a short "Activity running" status with a link, but its buttons still work and submit through the same command bus, so a player without the Activity can still act. Their action shows up in the Activity through the revision push.
- When the last Activity client disconnects (or after a timeout with no heartbeat), the Discord panel **resumes** and renders the current state once. Mixed use is therefore safe, because every action is the same validated command and both surfaces render the same revision, but only one surface does routine refreshing.
- A reconnecting client fetches the current view and revision. Missed pushes do not matter, because clients refetch and never apply patches.

### Identity and authorization

- **Auth flow:** the Embedded App SDK `authorize()` call returns an OAuth2 code; the backend exchanges it with the client secret, then calls Discord's `/users/@me` with the resulting token. The user id comes from that response, never from the request body or the client. The backend checks the token is for this application and that the Activity instance belongs to the campaign's guild and channel.
- **Roles and membership:** use the bot's own guild member data as the source, since the bot already holds it and applies the same checks as slash commands. If that data is unavailable or stale, refuse the action with a retryable error rather than falling back to client claims. `guilds.members.read` is not used in the prototype.
- **`commandId`:** client-supplied, but namespaced on the server by authenticated user and campaign (for example `activity:<campaignId>:<userId>:<clientId>`), so one user cannot replay or collide with another's, and the bus's existing dedupe returns the first outcome on a retry.
- Rate-limit and size-limit the endpoint; it is a new surface that accepts actions.

### Hosting constraint

The prototype runs the bot and the web server in **one process**, so the revision hook can feed an in-process WebSocket or SSE hub. This is an explicit constraint, not a design for scale. If they are ever split or run on several instances, the hub needs a shared broker, or clients fall back to polling the revision. Do not build that now.

### Build order and transport

- **Writes:** the Activity sends `{ commandId, action }`; the server calls the same controller methods as the buttons.
- **Reads:** per-viewer views at a `revision`. Send only the revision on any shared channel; fetch private data per user. A hidden roll or private journal entry must never ride on a broadcast.
- **Push:** the Phase 1 revision hook feeds the hub, which tells clients to refetch.
- **Staged roll reveal:** replayed in the client from the already-saved result.
- **Order:** read-only (scene, turn, roster), then one action, then the pending move. Keep the panel as the permanent fallback for players who do not open the Activity, and for mobile.

Hosting needs an HTTPS web server, the OAuth2 exchange on the backend, a realtime channel, and URL mappings in the Developer Portal. A tunnel or reverse proxy is enough for HTTPS.

Exit check: edits and 429s per round, compared with the Phase 0 baseline and the savings gate.

## Decisions to make now (cheap now, costly later)

1. Every player action is a command with a client-supplied `commandId` (already true).
2. Views return plain data per viewer, with private and public projections kept separate.
3. The bus publishes a revision after commit.
4. No game rule lives in a Discord handler.

## Open decisions

- **Who must agree to a move:** all active heroes, a majority, the organizer alone, or "no objection within the round timer"?
- **May forced or authored moves skip agreement?** Proposed: yes, with a warning line first.
- **Who writes the scene summary:** the model at departure (more natural, one extra call) or a rule-based digest of events (free, flatter)?
- **Cleanup trigger:** automatic after the grace period, or only an organizer purge? And the default grace period.
- **Activity parity:** full parity with the buttons, or a core set (act, speak, pass) with the rest left in Discord? The plan assumes the Discord panel goes quiet while an Activity session is live, since that is where the saving comes from; confirm.
- **Savings target** for the Phase 4 gate, once the baseline is measured.

## Risks

- The Activity doubles the front ends to keep in step, and adds hosting and an auth surface that accepts actions. Phase 0 and the savings gate exist so this cost is only paid if the numbers justify it.
- Phase 1 touches every button. Keeping old action names parseable and leaving rendering unchanged keeps the refactor reviewable.
- Compaction is irreversible. Do it only after the grace period and say so at end of game.
