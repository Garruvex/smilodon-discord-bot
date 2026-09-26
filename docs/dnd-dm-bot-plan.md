# D&D DM bot: product and implementation plan

Status: planning draft, revised 2026-09-26. This document authorizes no deployment and does not represent implemented functionality.

## 1. Product goal and decisions

Build a Discord campaign feature where an AI acts as the DM, players join through a lobby, create characters privately, and play through buttons and text popups. The bot maintains the authoritative campaign record, resolves supported mechanics, narrates the adventure, and illustrates key scenes.

**The primary goal is that it is fun to play.** Correctness and recovery exist to protect the fun, not to replace it. Every milestone is gated on a playtest as well as on correctness (see §8).

The first complete journey is:

**Configure campaign → publish lobby → join → create heroes → ready → start scene → submit actions → resolve checks/combat → pause → resume.**

Decisions established in discussion:

- Use SRD 5.1 (2014 rules, the basis of Baldur's Gate 3 and of Traditional-Chinese community resources) as the baseline and implement a curated subset of mechanics directly in TypeScript. Expose a small set of validated rule options (house-rule cards) on top. An LLM rules importer is a later phase, built only after the engine proves which options it can run.
- Prove the AI DM in a headless harness (no Discord) before building Discord infrastructure.
- Pacing is configurable at setup through one mechanism, the round window (§5). Instant, live, and play-by-post play are presets of it.
- Exploration resolves in rounds: gather the present players' actions, then resolve them together.
- Players can be marked away; an away policy chosen at setup decides what their hero does (§5).
- Launch languages: English and Traditional Chinese (`en`, `zh-TW`). Each campaign has one narration language (§7).
- Campaign memory is layered: authoritative state from the database, a structured campaign ledger, compacted summaries, and the verbatim current scene. The whole transcript is sent only while it fits the budget (§6).
- Keep character creation and private controls in ephemeral interactions and modals.
- Keep public hero cards and campaign controls as persistent bot messages.
- Use exactly two campaign text channels: Party for cards, and Adventure for bot narration and interaction-based play. Player discussion goes in one Table Talk thread under the Party dashboard; no third text channel is created.
- Track actor identity, turn eligibility, dice, resources, and consequences in saved campaign state.
- Restore deleted cards from saved data through the same reconciliation path used for initial setup.
- Support scene illustrations without making image generation a prerequisite for play.

Proposed defaults, adjustable during planning or at campaign setup:

| Choice | Proposed default |
| --- | --- |
| Rules baseline | Fifth edition 2014, SRD 5.1 (CC-BY-4.0); identify the exact source revision |
| Languages | `en`, `zh-TW`; campaign language defaults to the guild language |
| Campaign layout | Confirmed: Party and Adventure text channels, plus a Table Talk thread under Party |
| DM responsibility | AI runs the adventure; organizer handles setup, corrections, and exceptional rulings |
| Initial party size | 1–6 players, one active hero per player |
| Pacing | Live preset; selectable Instant / Live / Play-by-post / Custom (§5) |
| Exploration resolution | Rounds; Instant preset resolves each action immediately |
| Away policy | Background in exploration, cautious autopilot in combat, no death while away (§5) |
| Dice interaction | Player clicks Roll for their check; bot resolves NPC rolls |
| Images | Opening and major scene changes, subject to a configurable budget |
| Initial positioning | Zones with engagement and fixed distances, defined by the positioning contract (§5); no tactical grid |

Choosing SRD 5.1 does not mean every option or rule is available at launch. The capability catalog must list the implemented subset. Do not silently mix 2014 and revised (2024) rules; familiar BG3-style changes are offered only as explicit house-rule options (§4). A 5.2.1 profile can be added later as a separate verified baseline.

## 2. First release boundaries

The first internal demonstration uses one short original adventure (authored in `en` and `zh-TW`) and three validated level-one character presets. It proves the play loop is fun in the headless harness, then the entire Discord journey, including a restart during play.

The first playable release adds guided creation from a curated catalog, basic combat, supported resources and conditions, house-rule option cards, pacing presets, away mode, multi-session memory, and scene images. A proposed progression target is levels 1–3 for the selected options; additional levels become available only after their mechanics and content pass validation.

The catalog is a delivery gate: enumerate supported classes, character options, equipment, spells, monster actions, conditions, and recovery rules before implementation. A caster option is available only when its offered spells are supported. Character creation must never offer an option whose required mechanics cannot run.

Deferred features: the LLM rules/document importer, additional languages (starting with `ja`), embedding-based long-term recall, complete SRD coverage, arbitrary game systems, multiclassing, tactical maps, voice recognition/narration, marketplace integrations, full published-adventure ingestion, and unrestricted scripting. These can be added through explicit capability work.

## 3. Discord experience

### Campaign setup

The organizer invokes `/campaign create` and receives a private setup flow:

1. Campaign name, language (`en` / `zh-TW`), tone, and party limits.
2. Table rules: content boundaries (lines and veils), pacing preset and timers, away policy, optional party caller.
3. Baseline rules profile, supported character catalog, and house-rule option cards.
4. Adventure selection: original starter adventure or a structured original outline.
5. Channel selection/creation, campaign membership visibility, and image preferences.
6. Summary of rules, table settings, and anything unsupported.
7. Publish the lobby.

Setup choices are shown as cards the organizer can revisit before start. After start, pacing and away settings can change while paused; rule options follow the rules-change process in §4.

Verify channel permissions before publishing. Track partially created resources so retrying setup resumes safely. Do not let partial setup create duplicate campaigns or channels.

### Server setup (once per server)

A server administrator enables campaigns once, through the existing settings commands:

1. Enable the Campaign module (`CommandModule.Campaign`) for the server.
2. Choose the **D&D category**: pick an existing category or let the bot create one named "D&D" (localized). All campaign channels are created inside it.
3. Choose who may organize: a `campaignOrganizer` role group, following the existing semantic access groups. Default: bot administrators only.
4. Optional server defaults: language, preset and house rules, pacing, away policy, glossary overrides, image budget, and an optional preselected campaign visibility (organizers still confirm it per campaign).
5. A **permission preflight** checks the bot's effective permissions in the category and lists anything missing before any campaign can be created: View Channel, Send Messages, Manage Channels, Manage Roles (for permission overwrites and members-only campaigns), Manage Webhooks, Create Public Threads, Send Messages in Threads, Manage Threads, Pin Messages, Attach Files, and Embed Links.

### Channel creation for a campaign

In step 5 of `/campaign create`, the default is **Create channels in the D&D category**:

```text
D&D  (category)
  # moonlit-ruins-party        dashboard + hero cards; Table Talk thread under it
  # moonlit-ruins-adventure    narration, results, action panel
  # sunken-temple-party        another campaign, same pattern
  # sunken-temple-adventure
```

- Channel names come from the campaign name (Unicode is allowed, so `月光遺跡-party` works). If a name is taken, a short suffix is added.
- The alternative is **Use existing channels**: the organizer binds two channels they created. The preflight checks those channels instead.
- **Visibility** is an explicit choice in each campaign's setup; the organizer must pick one before publishing. If the server administrator set a default visibility, setup preselects it, but the organizer still confirms it on the summary step. Changing visibility later is an organizer action that updates the channel overwrites and the campaign role.
  - **Open table**: anyone who can see the category can watch; only members can act. Channel overwrites deny Send Messages to everyone and allow thread messages for campaign members.
  - **Members only**: the bot creates one campaign role (for example "🎲 Moonlit Ruins") and hides both channels from everyone without it. A role, rather than per-member channel overwrites, lets the organizer ping the party for sessions, keeps membership visible to administrators, and makes adding a spectator a single role grant.
    - The role is not hoisted; mentioning it is limited to the bot and the organizer.
    - Join grants it; Leave, withdrawal, and organizer removal revoke it.
    - **Campaign membership in the database is the source of truth; the role only mirrors it for visibility.** Startup and Repair reconcile them: members missing the role get it back; users holding the role without membership are treated as spectators an administrator added deliberately. They can view but not act, because every control checks campaign membership, never the role.
    - Archive keeps the role so past players keep read access; deleting the campaign deletes the role.
    - Requires Manage Roles and the bot's highest role ranking above campaign roles; the preflight checks both and explains the fix. Servers are limited to 250 roles, which matters only at very large campaign counts.
- **Creation is resumable.** The campaign record and a `pending_resources` list are saved before any Discord call. Each created channel, role, thread, and webhook ID is saved immediately after creation. A retry resumes from the list, and a leftover resource from an uncertain send is found by its saved name/topic marker instead of creating a duplicate.
- A category holds at most 50 channels (25 campaigns). When the category is full, setup asks the administrator to choose or create another category.
- **Archive** locks both channels read-only and, if configured, moves them to a "D&D Archive" category. Deleting a campaign's channels is a separate, explicit organizer action with confirmation.

### Channel layout

| Channel | Purpose | Player interaction |
| --- | --- | --- |
| Party | Pinned campaign dashboard and one public hero card per member | Ordinary player messages disabled; buttons/private views remain available |
| Adventure | Narration, scene art, attributed player actions, visible rolls, outcomes | Current action panel; ordinary messages disabled by default |
| Table Talk thread (under Party) | Coordination and social conversation | Members can send messages in the thread; discussion never automatically changes game state |

Setup idea to settle in milestone 1: an organizer runs `/dnd setup` once in a main channel, which becomes the hub that tracks ongoing games with a card or thread per game. Each game gets its own two channels, named from the game (for example `<name>-stats` for the Party dashboard and `<name>` for the Adventure), matching the Party/Adventure split above. Open questions: whether the hub is per server or per category, and what the hub cards show.

**Campaign source (decided).** `/dnd setup` offers the bundled default campaign (Moonlit Ruins, original content, in `en` and `zh-TW`) or an uploaded campaign. An upload is either a file in the adventure format (YAML or JSON), validated directly, or a free-form document (text, Markdown, or PDF notes) that the Adventure Author converts to the adventure format. Both paths run the same checks: size and page limits, the strict schema, the structure check across language editions, the ruleset content check (an upload can only reference monsters, items, and spells the ruleset has), a reachability and difficulty check, and a headless smoke run. Uploaded text is data, never instructions to the DM. The organizer approves a spoiler-free preview before play; DM notes and secrets stay in the Planner-only layer. The upload prompt carries a short copyright notice, and bundled content is original or SRD 5.1 only. Approved adventures are saved with the campaign.

Create or bind only these two text channels and one discussion thread. Pin the campaign dashboard and keep its hero and Table Talk links current after repair. Keep Party cards in place and route discussion into Table Talk. My Hero on the Adventure panel provides direct private access without searching. Thread messages are table discussion, not submitted actions, and are excluded from automatic campaign-state or generic-chat-memory ingestion. Configure Send Messages in Threads separately from the parent channel's Send Messages permission; test both access paths.

Optional setting: allow in-character messages in Adventure, each treated as a Speak action for its author's hero. Default off, so every gameplay input goes through attributed controls.

Scope read access to the intended campaign audience. Check permissions for normal players, organizer, and bot, including member/role overrides. Ordinary players cannot delete bot messages; moderators and administrators can. Pins provide navigation, not a permanently visible header.

Use one current Adventure action panel per campaign, placed after the latest resolved round or combat-turn announcement. Edit it while collecting actions or waiting for checks; replace it at the next actionable round/turn and retire its predecessor. The Party control card and hero cards stay in place. Put My Hero access on the current panel; a slash-command fallback can recover controls that have scrolled away.

The companion [Discord panel specification](dnd-panel-spec.md) defines each public card, private view, button, permission check, state transition, and update/recovery rule. It is part of this plan's implementation contract.

### Lobby and registration

The lobby shows the adventure, language, rules version, pacing preset, party capacity, organizer, and each player's status: creating, ready, or withdrawn.

Buttons: **Join · My Character · Leave · Start Adventure**.

- Join records the Discord user as a participant and opens their private character hub.
- Repeated Join opens the existing draft and never creates another member.
- Registering the final available seat must be atomic under simultaneous clicks.
- Closing a popup retains saved steps; it does not withdraw the participant.
- Leave explicitly withdraws before start. Preserve a reusable draft when appropriate.
- Start is available when the minimum party size is met and every registered participant is ready. Only the organizer can execute it.
- The organizer can remove an inactive lobby participant; list that change publicly.
- Starting closes registration for the initial release. Later joins require a paused-session organizer flow.

Ephemeral views are opened by the user's interaction. Persist drafts independently of the view; My Character reopens them after dismissal or interaction expiry.

### Character creation and hero cards

Creation path: choose preset or guided creation → identity and appearance → supported background/class/options → abilities → equipment and resources → review → ready.

Derived values are calculated by the engine. The LLM may suggest names, backstory, and supported builds, but it cannot invent validated bonuses or equipment. Explain invalid choices privately and retain the draft.

Readiness stores the character revision and rules revision. A relevant rules change or character edit invalidates readiness until revalidated. Starting a campaign copies the accepted character into campaign state. Reusing a saved character creates a campaign-specific copy; it never shares live HP or inventory across games.

Public hero card:

- Name, player, portrait, class/level or equivalent supported labels.
- Current/max HP, defense, public conditions, turn/status indicator, and away status.
- View Details, My Actions, and Inventory controls.

My Actions and private inventory views require ownership checks. Other members may inspect only the public projection. Secret objectives, unrevealed information, and private notes must never enter the public card payload. Portraits can use a placeholder initially and should not regenerate when HP changes.

## 4. Rules and house-rule options

### Engine first, options second

Implement the curated SRD subset as ordinary, tested TypeScript in `src/domain/campaign/`. Expose rule variation through a small, versioned set of **house-rule option cards** with enumerated values, for example:

| Option | Values |
| --- | --- |
| Ability generation | Standard array, point buy, 4d6-drop-lowest |
| Critical hits | Double dice, max first die + roll |
| Natural 20/1 on ability checks and saves | No effect (2014 rules), automatic success/failure |
| Resting | Standard, gritty, heroic |
| Death | Standard death saves, no death while away, lingering injuries off/on. A fallen hero stays dead and their gear goes to the party stash. The player joins a new hero at the party's level with starting gear and no loot. A lost fight is a story defeat: the heroes who are down but not dead wake with 1 HP, and the story goes on (built in milestone 0). The organizer can retry a lost fight from its start with fresh dice (a saved checkpoint of the party, not an event-log rewind) |
| Item trading | Heroes can give or swap items outside combat with the receiving player's consent, and use a shared party stash. Items cannot be invented by player text (built in milestone 0) |
| Healing potions | Action, bonus action |
| Encumbrance | Off, simple |

Option cards can be bundled into named presets. Proposed: **BG3-style**, for players who learned D&D from Baldur's Gate 3. This is an explicit bundle of house rules over SRD 5.1, not a separate rules edition or a promise to reproduce the whole game.

| Candidate option | Evidence and proposed scope | Release requirement |
| --- | --- | --- |
| Drink a potion as a bonus action | BG3's [potion reference](https://bg3.wiki/wiki/Potions) documents bonus-action consumption. Apply only to drinking a supported potion yourself; do not infer the same cost for administering or throwing one. | Implement inventory consumption and action cost together; verify supported potion behavior. |
| Shove as a bonus action | BG3's [Shove reference](https://bg3.wiki/wiki/Shove) documents a bonus-action push. A cost-only change to SRD shove is a tabletop adaptation: BG3's push distance/physics and SRD's knock-prone option are not interchangeable. | Specify allowed outcomes, check, distance, and action cost on the card before enabling it. |
| Elevation attack modifier | BG3's [high-ground reference](https://bg3.wiki/wiki/High_ground_rules) documents +2 when at least 2.5 m above the target and -2 when at least 2.5 m below, applied to attack rolls rather than granting advantage. | Defer until the engine stores elevation and checks reach/range. Specify supported exceptions and any simplification; the LLM cannot award the modifier from scene prose alone. |

These sources are a community mechanics reference, not a recorded test of the installed game. Before release, record the BG3 build tested, exact option behavior, intentional tabletop differences, and engine verification. Include only implemented, validated options; hide unsupported options rather than silently approximating them. Surfaces, camp supplies, and other video-game systems remain out of scope. Terminology evidence is tracked separately in [BG3 reference notes](dnd-bg3-reference-notes.md).

Each option is implemented and tested in the engine; the card only selects it. Adding an option means adding engine code and tests, not free-form configuration. Mechanics that interact (stacking, concentration, resistance) require explicit semantics and tests.

A generalized operation schema (bounded expressions, allowlisted operations) grows out of the implemented options once patterns are clear. Never evaluate uploaded text, model output, or rule formulas as executable JavaScript.

Once a campaign starts, rules are fixed to their saved revision. A change requires pausing, previewing effects on existing heroes and pending actions, applying an explicit migration, revalidating affected data, and recording the decision. Block migrations that cannot preserve a coherent state.

### Later phase: LLM rules importer

After the option set and schema are proven, add text/document import:

1. Save source metadata and extract text within file/page/size limits (text, Markdown, text PDFs first; scanned PDFs report unsupported).
2. Give the LLM the verified baseline, supported schema, capability catalog, and source text.
3. Request a proposed patch, source passages, assumptions, clarification questions, and unsupported requests.
4. Validate the patch structurally and semantically; reject unknown operations and missing dependencies.
5. Produce a readable before/after summary and representative checks calculated by the engine.
6. Organizer resolves gaps and accepts; save an immutable rules revision and its provenance.

Classify each requested change as supported, needs clarification, narrative-only, or requires an engine extension. Narrative-only rulings cannot bypass resource/turn validation. Treat uploaded instructions as rule content, never as authority to change bot permissions or reveal secrets.

## 5. Gameplay, pacing, and turn flow

The AI DM opens with a saved scene, visible description, and an illustration job. Players see **Act · Speak · My Hero · Journal · Away · Safety**. Roll and reaction controls appear when applicable.

An Act popup collects intent, with a target selector where useful. Preserve the player's wording in the action record. The bot attributes public actions to the correct hero and narrates only the attempted action and resolved consequences. It must not invent a player's dialogue, choices, or motives.

**Player text is intent, never authority.** "I find a +5 sword" or "ignore the rules" is an attempted action the DM planner evaluates; it cannot grant items, change state, or override instructions.

### Rounds and the round window

Exploration and conversation run in rounds:

1. The DM narrates and opens a round window.
2. Present (non-away) players submit one action each; they can revise until the window closes. Speak lines post immediately as attributed dialogue without an LLM call.
3. With at least one present player, the window closes when every eligible player has submitted an action or Pass, the timer expires, or the organizer (or party caller) closes it. Freeze the round roster and final submission revisions at close.
4. The DM planner proposes a dependency-ordered batch. Independent checks may be issued together; dependent actions wait for their prerequisites to resolve.
5. Resolve checks and timeout dispositions, then narrate the committed outcomes and open the next round only if someone is present. A nonempty roster that only passes/misses receives a template waiting status, not an automatic model call, encounter advance, or repeated empty round.

Batching reduces LLM calls and message noise, gives every player a spotlight each round, and removes most stale-action conflicts. When actions conflict ("left door" vs "right door"), the DM may split the party, ask a quick in-fiction question, or defer to the party caller if one is configured.

### Dependencies within a round

Each proposed action includes an action ID, prerequisite action IDs/outcomes, preconditions, and required shared resources. Validate the complete proposal before any of its effects run; reject dependency cycles and resolve competing uses of a unique item before rolling. Freeze a stable ordering for independent actions (submission sequence, then action ID as tie-breaker). Use declared dependencies for actions such as unlocking a door before entering it; a party caller may resolve a party choice but cannot authorize another hero's resource use.

Process the valid plan in dependency stages. Reserve required resources transactionally, recheck preconditions against the latest committed state, and release reservations on cancellation or failure. Persist completion per stage so a restart resumes remaining work rather than replaying successful stages. Checks whose availability or modifiers depend on earlier outcomes must wait for that stage.

If a prerequisite fails, mark dependent actions blocked and retain the player's intent for clarification/revision. Do not spend their resources or roll them. Replanning covers unresolved actions only; previously committed outcomes stay fixed. A stale external state change invalidates unresolved work and requires revalidation. Two model calls per round is the ordinary independent-action path, not a hard limit for dependency or clarification cases.

### Pacing presets

All presets use the same round window; they only change its timers.

| Preset | Exploration round | Roll timer | Combat turn | Reaction window | Reminder |
| --- | --- | --- | --- | --- | --- |
| Instant | None: each action resolves immediately | None | None | 60 s | – |
| Live | 5 min, or when all submit | 2 min | 3 min | 60 s | At 50% |
| Play-by-post | 24 h, or when all submit | 12 h | 12 h | Pre-declared reactions | At 50% and 90% |
| Custom | Organizer sets each timer, including "no timer" | | | | |

Instant is intended for 1–2 player tables; with more players it falls back to serial resolution and conflict handling. Timers are saved as deadlines, survive restarts, and are paused with the campaign. For play-by-post, players can pre-declare reaction preferences (e.g. "use Shield if an attack would hit") so combat does not stall on reaction windows.

Timeout behavior is explicit by timer type:

| Expired timer | Required transition |
| --- | --- |
| Exploration submission | Record a missed/pass disposition without inventing an action; resolve available submissions if any |
| Roll for a validated pending check | Server auto-rolls that exact saved check once and labels it timed out; never chooses a new action or spends an unreserved resource. If its prerequisites no longer hold, cancel it and release reservations |
| Clarification or story choice | Keep the choice unresolved and pause affected progress; neither the proxy nor autopilot invents consent |
| Combat turn | Apply the away policy only to the remaining legal action budget, then end the turn once; do not grant an extra action |
| Reaction | Decline unless a valid pre-declared reaction is already authorized; evaluate that authorization and resource cost once |

Count at most one miss per player per exploration round or combat turn; default two consecutive misses marks them away. Freeze the participant set at round open; new returns join at the next boundary. Leaving/marking away explicitly disposes of that player's unsubmitted slot. Pending validated checks follow the roll policy. If nobody remains present, enter `waiting_for_players`, suspend timers, and preserve pending state; no new rounds, NPC turns, auto-rolls, or model calls execute until someone returns and explicitly continues.

Timers have persisted identities and a pending/fired/cancelled state; a player response and expiry race through the same transaction, so only one wins. On process restart, enter `recovery_paused` for active timed campaigns and reconcile cards. Resume shows overdue work to the organizer; they may continue from saved remaining durations or apply each already-overdue deadline once. Never simulate many unattended rounds to catch up with wall-clock time.

### Away mode

A player can mark themselves away, be marked by the organizer, or be marked automatically after missed timers. Away status is public on the hero card. Clicking **I'm back** returns the hero at the next round or turn with a private catch-up recap.

Away policy, chosen at setup:

| Situation | Options (default in bold) |
| --- | --- |
| Exploration | **Background: hero follows the party, takes no actions**; wait for the player |
| Combat | **Cautious autopilot**; proxy player; skip turn (Dodge) |
| Proxy | Owner may grant a named player control; proxy can act and roll but has the same limits as autopilot unless the owner allows resource use |
| Safety | **Protected while away** (below); standard rules |

Autopilot is deterministic engine logic, not LLM choice: take Dodge, or a basic weapon attack against the nearest threat already engaging the hero; never spend limited resources (spell slots, consumables, limited-use features), never move into new danger, never speak, and never make story choices. The narration mentions the hero briefly and neutrally.

**Protected while away.** Stabilizing alone is not enough: under the 2014 rules a stable creature that takes damage starts dying again, damage at 0 HP causes death-save failures, and massive damage kills outright. With the default Safety policy:

- **Start:** protection applies from the moment away status takes effect. If the hero is already dying at that moment, they become stable immediately.
- **While protected at 0 HP:** the hero is unconscious and stable, and is removed from targeting: monster tactic profiles and the target menu skip them, and area effects do not affect them. They make no death saving throws, and no effect can kill them or add death-save failures. Narration presents them as dragged clear or overlooked.
- **While protected above 0 HP:** normal rules apply, except that damage which would reduce them to 0 HP leaves them at 0 HP, stable, and protected as above. Massive-damage instant death does not apply.
- **Return:** protection ends when the player's return takes effect at the next round or turn boundary. The hero keeps their current HP. At 0 HP they remain stable and unconscious under normal rules (healing or regaining 1 HP after 1d4 hours), and from then on damage has its normal effect.
- **No escape hatch:** a player cannot mark themselves away while their hero is at 0 HP in combat, or during their own turn or pending death save. Auto-away from missed timers and organizer marking still apply, and the organizer can switch the campaign to standard rules.
- The hero card shows "Away · protected" so everyone understands why the hero is not being attacked.

### Positioning contract

Combat uses zones, not a grid, but every value the engine needs for legality is defined here, so the target menu can exclude illegal targets and the Planner's proposals can be validated.

- **Zones.** Each scene declares zones (for example "stairs", "ground floor", "courtyard") and the edges between adjacent zones. Each edge has a distance in feet (default 30) and a line-of-sight value: `clear`, `half cover`, `three-quarters cover`, or `blocked`. Zones that are not adjacent are connected through the shortest path.
- **Engagement.** Within a zone, a creature is either unengaged or engaged with specific creatures. Engaged creatures are within 5 feet of each other. Engagement is tracked as pairs.
- **Distances used for range.** Engaged: 5 ft. Same zone, not engaged: 15 ft. Different zones: the path's edge distances.
- **Movement costs** (against speed; Dash doubles speed):

  | Move | Cost |
  | --- | --- |
  | Engage a creature in the same zone | 10 ft |
  | Leave engagement, staying in the zone | 5 ft |
  | Move to an adjacent zone | Edge distance |
  | Stand up from Prone | Half of speed |
  | Difficult terrain (zone or edge tag) | Double |

- **Reach.** A 5-foot melee attack requires engagement with the target. Reach weapons (10 ft) can also target creatures engaged with an ally who is engaged with the attacker; none are in the milestone 0 catalog.
- **Ranged attacks and spells** compare the distance to normal and long range (long range gives disadvantage; beyond long range is illegal). A ranged attack while engaged with a hostile creature that can see the attacker and is not incapacitated has disadvantage.
- **Line of sight and cover.** Targets in the same zone are visible with no cover unless a scene tag says otherwise. Across zones, the path's worst edge value applies: half cover +2 AC and Dex saves, three-quarters +5, blocked means no line of sight and the target cannot be chosen. Heavily obscured zones and hidden creatures follow the engine's visibility rules.
- **Opportunity attacks.** Leaving engagement with a hostile creature (including moving to another zone) without Disengage triggers an opportunity attack from that creature if it can see the mover and has its reaction. The trigger happens before the creature leaves, through the attack sequence in the panel specification. Forced movement and teleportation do not trigger it.
- **Planner limits.** The Planner may propose movement only as a destination zone and engagement targets; the engine computes costs, triggers, and legality.

### Other modes

| Mode | Eligibility and sequencing |
| --- | --- |
| Exploration / conversation | Round window as above |
| Combat | Initiative order; active hero uses their action budget; turn timer applies; eligible reactions have their own window |
| Targeted decision/check | Only the addressed character responds, within the roll timer |
| Paused | Read-only campaign views and organizer controls; all timers frozen |

Check eligibility both when opening controls and when submitting. If the scene changed, explain the conflict privately and allow revision. Never silently discard a submission or automatically apply a stale action later.

### Resolution sequence

1. Acknowledge the Discord interaction promptly and identify the actor from Discord.
2. Validate membership, character ownership, campaign state, scene/turn revision, and duplicate submission ID.
3. At round close, ask the Planner (§6) for a bounded proposal: supported actions, required checks, targets, and effects per outcome.
4. Validate the proposal. Clarify ambiguous targets or unsupported mechanics before spending resources.
5. For each required check, persist the pending check and show Roll to its eligible owner.
6. Generate and durably save each roll exactly once. Fix modifiers and difficulty before the roll; record visibility for hidden checks.
7. Resolve mechanics and atomically save events, resource changes, action status, and delivery work.
8. Ask the Narrator to narrate from committed results, then refresh the relevant cards.

Use server-generated randomness through a testable dice service, extending `src/domain/games/dice.ts` where suitable. Save individual dice, modifiers, total, result, actor, purpose, and rule revision. Failed retries must reuse saved rolls. The model cannot select a favorable random result.

Do not automatically end a combat turn after the first action. End it explicitly, on timer expiry (applying the away policy), or when the rules establish completion. Resolve NPC turns through the same engine.

### Combat presentation

Waiting for a model call on every attack is slow. In combat:

- Mechanical results post immediately as template lines ("Goblin attacks Mira: 14 vs AC 16, miss"), with no model call.
- The Narrator writes one short flourish per combat round, covering what happened since the last one, plus special moments (natural 20/1, a hero dropping, a monster fleeing, the fight ending).
- The Combat card shows initiative order, whose turn it is, HP bands for monsters ("bloodied"), and each hero's remaining action budget.

### Playing without knowing the rules

Many players will not know D&D. The interface should never require it:

- The private Act view offers two or three **suggested actions** from the Narrator's last output and a Custom Action button opening a text popup. Suggestions are hints and require validation like typed actions.
- The Roll card explains the roll in plain words: "Stealth check: d20 + 5." Reveal the saved DC with the result, consistently with the campaign's check-visibility policy.
- My Hero includes "What can I do?": the hero's actions, spells, and features in plain language with their current uses.
- The planner explains `impossible` or `clarify` results privately and constructively, suggesting a supported alternative.
- The starter adventure's first scene teaches Act, Roll, and Speak in-fiction.

### Table safety and organizer controls

- **Safety button** (on the action panel): any player can privately ask to skip or rewind the latest content. Suspend unresolved gameplay while handling the request and preserve committed state; mechanical rewinds use validated corrections. The next narration steers away without naming who pressed it; the organizer sees an anonymous notice. Anonymity applies to player/organizer-facing UI, not service operators or audit infrastructure. See the panel specification for details.
- **Whisper to DM** (organizer): a private steering note added to the next Planner call ("the captain should surrender"). Notes are saved as DM knowledge. Only committed, publicly visible consequences reach the Narrator.
- **Regenerate narration** (organizer): rewrites the latest narration from the same committed results. It never rerolls dice or changes state.
- **Correct state** (organizer): explicit correction events as described in §9.

Pause retains the exact scene, pending work, and remaining timer durations. Resume checks permissions, repairs panels, and shows a recap plus the pending decision. Character departure during play marks the hero inactive and invokes an organizer policy; it does not erase the character or past events.

## 6. AI DM memory and context

### Why not always send the whole transcript

One session is roughly 150–250 actions plus narration, about 40–80k tokens, and fits comfortably. A multi-session campaign does not: every call would resend hundreds of thousands of tokens, raising cost and latency. Long raw transcripts also let stale numbers ("Mira has 12 HP") contradict current state, and make it harder to keep secrets out of narration.

The design therefore sends the whole transcript **only while it fits a budget**, and compacts older material into summaries and a structured ledger once it does not. Short campaigns get full context for free.

### Context layers

Assembled in this order so the stable prefix benefits from provider prompt caching:

| Layer | Contents | Changes | Source |
| --- | --- | --- | --- |
| A. DM instructions | DM style, output rules, tool contracts, language, glossary, table boundaries | Never within a campaign | Code + setup |
| B. Adventure bible | Outline, locations, NPCs with voices, secrets, planned threats | Rarely | Adventure setup |
| C. Campaign ledger | Established facts, NPC attitudes and knowledge, promises, open threads, clues found, named items, canonical names | Explicit events immediately; derived summaries asynchronously | App-owned facts plus model-proposed consolidation |
| D. Story so far | Chapter summaries plus scene summaries for recent scenes | At scene close / compaction | Summarizer |
| E. Current scene | Verbatim actions, rolls, and narration for the current scene | Per action | Event log |
| F. Live state | HP, resources, conditions, initiative, pending checks, away status | Per action | Database only, rendered fresh each call |

Rules:

- **Numbers come only from layer F.** Summaries and ledger entries never store HP, slots, or counts, so memory cannot contradict mechanics.
- **The ledger is the memory that makes the world feel alive.** Entries are small and entity-keyed, e.g. `npc:garrick → attitude: suspicious; knows: party took the ledger; promised: meet at dawn`. Explicit reveals and stateful story effects update authoritative facts in their original transaction. At scene close the model proposes consolidation through an `update_ledger` tool; the application validates entity references and saves accepted changes as events.
- **Background writes are versioned.** A Chronicler job records its source event range and expected revisions for affected ledger entries. Accept proposals only while those revisions still match; otherwise discard/rebase the affected proposals against newer facts, without replaying previous mutations. A summary may still be saved as historical context for its original range, never as the new current state. Keep unprocessed events in context until accepted summaries cover them. Deduplicate jobs by source range/version and bound retries.
- **Compaction budgets the entire request.** Account for layers A–F, schemas/tools, submitted actions, and provider overhead; reserve output capacity below the selected model's limit. Start with a proposed total input ceiling of 30k tokens or the provider's smaller safe limit. Select relevant bible/ledger entries, compact old scenes and chapters, and permit a checkpoint summary of the older portion of a long current scene. Preserve recent verbatim events, pending decisions, dependency stages, and facts needed for unresolved actions. Store summaries with source ranges and visibility. If indispensable content cannot fit, pause with a recoverable diagnostic rather than truncate rules or pending work. Output reserve and budgets are configured per call type and measured in both languages.
- **Retrieval starts entity-keyed, not embedding-based.** When the current scene or submitted actions mention a known entity, include its ledger entry and the summaries tagged with it. This is deterministic and debuggable. Embedding recall (reusing `EmbeddingsClient`) is a later addition for fuzzy callbacks.
- **Campaign memory is separate from chat memory.** Do not store campaign facts in the chat memory engine, and never feed campaign channels into ambient chat, personal memory extraction, or channel-summary ingestion. Reuse transport and summarization patterns (`channel-message-summarization.ts`), not stores.

### Secrets and visibility

Only the Planner and authorized private Chronicler work receive unrevealed adventure material. The Narrator receives a public-only projection: public style instructions, revealed entity descriptions, public ledger/summaries/events, and committed public outcomes/current values. It never receives raw secret bible sections, private organizer notes, or unrevealed Planner reasoning. Revealing a fact is an explicit committed event before it can enter narration.

Journal, recap, hero cards, suggestions, and image prompts use the same audience-aware projection. A summary derived from mixed public/private input remains private; generate public summaries from public-only inputs instead of attempting to remove spoilers from a private summary afterward. Player-private context may be used only in responses to that authorized player. Tests inspect model request payloads as well as public outputs; exact-match leak scans are supplementary and cannot detect every paraphrase or model inference.

### DM call pipeline

The DM is a fixed pipeline of narrow, structured calls, not an open-ended agent loop. This follows the repository's existing pattern of single-purpose provider interfaces with their own JSON schema (`ConversationConsolidator`, `MemoryConflictClassifier`), works with every configured provider's structured-output mode, keeps latency predictable, and makes each call scriptable in tests.

| Call | When | Input | Output | On critical path |
| --- | --- | --- | --- | --- |
| **Planner** | Round close, combat NPC decision, clarification | Layers A–F, submitted actions, legal options | Structured proposal (below) | Yes |
| **Narrator** | After mechanics commit | Public-only context projection, committed public results/current values, spotlight hints | Narration text in campaign language, optional suggested actions | Yes |
| **Chronicler** | Scene close, compaction, long-scene checkpoint | Audience-scoped source events, ledger snapshot, source range/revisions | Visibility-scoped summary and conditional ledger proposals | No (background) |
| **Translator** | Setup only | Adventure outline | Translated bible version | No |

Planner output, per submitted action:

- Interpretation of the player's intent, in one line.
- Resolution: `automatic` / `check` / `impossible` / `clarify` / `conflict`, with a short reason.
- For checks: ability or skill ID, DC tier, advantage/disadvantage with a reason from an enumerated list, group/help handling.
- Proposed effects from an enumerated vocabulary: move to zone, reveal clue ID, change NPC attitude, grant item from the bible, advance/reset clock, start encounter ID, apply engine damage/healing/condition, transition scene.
- Effects are keyed by outcome (success / failure / partial) so the engine applies them after the roll without another model call.
- Action IDs, prerequisite outcomes, preconditions, and resource reservations define dependency stages (§5). Independent outcomes need no extra planning call; blocked or changed dependencies may require clarification/replanning.

Plus, per round: scene status (`continue` / `close` / `transition:<id or improvised>`), clock changes, and which quiet players to spotlight.

The engine validates the proposal: unknown IDs, disallowed effects, off-ladder DCs, or effects a hero could not cause are rejected. On a schema or validation failure, retry once with the errors; if that fails, post a neutral "the DM considers…" holding line, keep the submissions, and raise an organizer notice. Never apply part of an invalid proposal.

The Narrator cannot change state. It receives the public projection and must describe committed results faithfully; numerical slots are rendered from committed values rather than accepted as model-authored numbers. An ordinary independent exploration round uses two model calls plus rolls; staged dependencies or clarification can require additional calls. Cheaper models can serve the Chronicler and Translator.

### Checks and difficulty

- **Roll only when the outcome is uncertain and failure is interesting.** Otherwise the planner resolves `automatic` or `impossible` and explains why. This keeps pace and makes rolls feel meaningful.
- **Improvised ability-check DCs come from a fixed ladder:** 5 very easy, 10 easy, 15 medium, 20 hard, 25 very hard, 30 nearly impossible. When the Planner sets a DC for an ability check it improvised, it picks a tier and a reason, and the engine rejects other values.
- **All other DCs come from the engine or validated content, never from the Planner.** Spell save DCs use the caster's formula (8 + proficiency bonus + spellcasting modifier, so 13 is normal); monster ability and trap DCs come from their content definitions; concentration saves use max(10, half the damage). The Planner may request such a save but cannot choose its DC.
- Passive scores are used for noticing things without an action. Group checks succeed when at least half succeed. Help grants advantage.
- The DC is fixed before the roll and revealed after it, together with the modifiers that applied.

### Scenes and chapters

The adventure bible defines chapters, each containing scene nodes with a goal, entry description, entities, possible exits, and optional clocks. A scene closes when the planner reports `close` or `transition` and an exit condition is met, or when the organizer closes it. Closing a scene triggers the Chronicler, an optional image job, retirement of the scene's action panel, and a new round.

Players can leave the outline. The planner can then propose an improvised scene built from bible entities; it is saved as a new node marked improvised, so later scenes and summaries can refer to it. Improvised encounters may only use monsters from the bible roster within the chapter's difficulty budget.

### NPCs and monsters in combat

For each NPC turn the engine enumerates legal actions (attacks, listed abilities, movement between zones, disengage/flee). Each monster has a tactic profile in the bible (e.g. `brute`, `skirmisher`, `coward: flee below 30% HP`). Ordinary monsters act from their tactic profile with no model call. Named or "smart" NPCs may ask the planner to choose among the legal actions, with a reason; an invalid or slow choice falls back to the tactic profile.

Encounters are authored with a difficulty rating for the expected party. Monsters focus-firing an unconscious hero or other brutal tactics are off by default and can be enabled as a house-rule option.

### Adventures and images

Original adventure setup persists a concise outline, starting location, key NPCs (with a voice or tic each), initial situation, and secrets. Track what has become established and what remains a possible future development. Preserve player agency when players depart from the outline.

Scene illustrations use only revealed visual information plus approved character references. Save prompts, assets, source scene revision, and visibility. Reuse images while the scene remains visually unchanged. Generate asynchronously with concurrency, size, timeout, and campaign budget limits. Text continues if generation fails. Late images attach to their original scene, not whichever scene is current.

Besides scene art, the gateway produces two reusable asset kinds: **hero portraits** (preset art, player upload, or one generation at creation; never regenerated by state changes) and a **monster art library** keyed by monster ID and style, generated once and reused across encounters and campaigns. Both are optional; text play never waits for them. Display rules are in the [panel specification](dnd-panel-spec.md#display-system).

The existing self-image tool is restricted to the bot's configured persona (`selfReferenceImageAsset`). Add a dedicated scene-image gateway/tool; reuse compatible provider transport, asset storage, and image limits where appropriate.

### Cost and latency budget

Rough call volume for a Live session: 20–30 exploration rounds per hour at two critical-path calls each, plus combat flourishes, NPC decisions for named foes, and background Chronicler calls — on the order of 60–100 model calls per hour. Layers A–B form a stable cached prefix, so most input tokens should be cache hits. The harness measures the real numbers per provider.

Track tokens and latency per campaign. Proposed targets for the harness: p50 resolution under 8 s and p95 under 20 s in Live pacing; a per-campaign token budget configurable by the organizer, with a warning before it is exhausted. Round batching and prompt caching are the main levers.

## 7. Language support

- **Launch languages: `en` and `zh-TW`**, matching the existing `Language` type in `src/application/i18n/language.ts`. `ja` is deferred.
- **One narration language per campaign**, defaulting to the guild language. Narration, ledger, summaries, recaps, and journal are all written in that language. Memory is stored in the campaign language, not translated through English.
- **Players may type in any language.** Input is understood as-is; output stays in the campaign language.
- **Mechanical terms come from a glossary, not the model.** The engine uses stable IDs (`ability:dex`, `condition:prone`, `spell:magic-missile`); each locale maps IDs to display names. The glossary is part of layer A so narration uses the same terms as the UI.
- **There is no official Traditional Chinese 5E.** Chinese-speaking players rely on community translations (5etools 中文, 純美蘋果園, 灰機 Wiki), and the out-of-print official translation was Simplified. Terminology is not uniform; for example, Wisdom circulates as both 睿知 and 感知. Therefore:
  - Author our own `zh-TW` glossary for the implemented subset, choosing the community-standard name where one clearly exists (5etools 中文 / 純美蘋果園 are the de facto references).
  - Translate content ourselves from the SRD (CC-BY-4.0, with attribution and a note that it is translated). Do not import community translation data: those sites include non-SRD material and translators' own work.
  - Show the English abbreviation next to core terms in the UI (敏捷 DEX, 倒地 Prone) so players who learned different names still recognize them.
  - Let the organizer override display terms per campaign (e.g. 睿知 vs 感知). Overrides are presentation-only and also feed the glossary in layer A.
  - The model's Chinese D&D vocabulary comes mostly from Simplified-script community sources, which strengthens the Simplified-drift risk below.

#### Community terminology survey (2026-09-26)

Two 5etools 中文 mirrors were compared:

- **5etools.wayneh.tw**: Traditional script with Taiwan usage; **2014 content only** (PHB/DMG).
- **5e.kiwee.top**: Simplified script with mainland usage; 2014 **and 2024** content. Each entry states whether it is in SRD 5.1 or SRD 5.2.1, which makes it a useful index for checking catalog entries.

A third reference: **Baldur's Gate 3** (柏德之門3). Prefer its **verified official Traditional Chinese** term when it conflicts with community terminology, unless that term would misrepresent the SRD 5.1 mechanic. Record exceptions explicitly and keep the English label visible where useful. A translated guide, fan correction, or Simplified-to-Traditional conversion does not establish the official game string. BG3 vocabulary never changes the underlying SRD mechanic.

The surveyed Traditional-script reference covers 2014 content, which supports the selected SRD 5.1 baseline. This survey does not establish what all Taiwanese players know or whether other Traditional Chinese translations of 2024 material exist.

The two sites differ well beyond script conversion. Starting glossary for milestone 0 and later catalog terms follows. **Guide** means secondary wording only; **unverified** means no reliable official string has been established. Existing project defaults remain usable while official comparison is pending. Evidence links and the verification procedure are in [BG3 reference notes](dnd-bg3-reference-notes.md).

| English | wayneh.tw (繁, 2014) | kiwee.top (简, 2014/2024) | BG3 `zh-TW` evidence | Project `zh-TW` default |
| --- | --- | --- | --- | --- |
| Fighter | 戰士 | 战士 | Guide: 戰士 [B1] | 戰士 |
| Rogue | 盜賊 | 游荡者 | Guide: 遊蕩者 [B1]; official unverified | 盜賊 (provisional; review class/subclass ambiguity) |
| Cleric | 牧師 | 牧师 | Unverified | 牧師 |
| Paladin | 聖騎士 | 圣武士 | Guide: 聖武士 [B2] | 聖騎士 (provisional) |
| Warlock | 契術師 | 魔契师 | Guide: 邪術師 [B2] | 契術師 (provisional) |
| Poisoned | 中毒 | 中毒 | Unverified | 中毒 |
| Prone | 伏地 | 倒地 | Guide: 倒伏 [B3]; official unverified | **倒地** (explicit project choice) |
| Frightened | 恐懼 | 恐慌 | Unverified | 恐懼 |
| Grappled | 被擒 | 受擒 | Unverified; do not invent a BG3 equivalent | 被擒 |
| Incapacitated | 無力 | 失能 | Guide: 失能 [B3]; official unverified | **失能** (project choice; SRD meaning governs) |
| Unconscious | 昏迷 | 昏迷 | Unverified | 昏迷 |
| Proficiency bonus | 熟練加值 | 熟练项加值 | Guide: 熟練項加值 [B2] | 熟練加值 (provisional) |
| Bonus action | 附贈動作 | 附赠动作 | Guide: 附贈動作 [B3] | 附贈動作 |
| Hit dice | 生命骰 | 生命值骰 | Unverified | 生命骰 |
| Spell slot / cantrip | 法術位 / 戲法 | 法术位 / 戏法 | Guide: 法術位 / 戲法 [B4]; official unverified | 法術位 / 戲法 |
| Cure Wounds | 治療傷勢 | 疗伤术 | Unverified; do not substitute Healing Word | 治療傷勢 |
| Jack of All Trades | 全能高手 | 万事通 | Guide: 萬事通 [B5] | 全能高手 (provisional) |

In SRD 5.1, Incapacitated prevents actions and reactions; the bonus-action rules also prevent bonus actions when actions are unavailable. The condition alone does not prohibit movement, but other concurrent conditions may. UI help must describe these effects rather than interpreting 失能 as weakness or automatic immobility. See the [2014 conditions](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/appendix-a-conditions) and [combat rules](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/combat).

Still to collect: the remaining abilities (Wisdom in particular: 感知 vs 睿知), skills, the milestone 0 spells and monsters, and rest/death-save terms. Each glossary entry records its source. Use these sites for term names only, never as content.
- **Proper nouns are locked.** Once an NPC, place, or item is named, its canonical spelling lives in the ledger and is included whenever the entity is in context, so the model does not re-transliterate names.
- **Rolls, cards, buttons, and system messages are templates**, rendered through `src/application/i18n/messages/*`, not generated by the LLM.
- **Adventures are translated once.** The starter adventure is authored in both languages; an organizer-supplied outline is translated at setup and saved as a separate bible version.
- **Traditional, not Simplified.** Models drift into Simplified characters or mainland vocabulary when writing Chinese. Layer A instructs Traditional Chinese with Taiwan usage, the glossary pins terms, and the harness flags Simplified-only characters in `zh-TW` output.
- **Test per language.** Harness playthroughs run in both languages. Narration length limits are defined per language (characters for `zh-TW`, words for `en`), and token costs are tracked separately.

## 8. Making it fun

Fun is a release gate with concrete levers and measurements.

| Fun factor | Design lever | Harness measurement |
| --- | --- | --- |
| Responsiveness | Immediate acknowledgement, visible "DM is thinking", round batching | p50/p95 resolution latency |
| Punchy narration | Cap about 80–150 words (`en`) or equivalent characters (`zh-TW`); end on a hook or question | Length distribution |
| Agency | "Yes, and / yes, but"; failure moves the story forward instead of blocking it | Share of actions with a state or story change |
| The world remembers | NPCs call back earlier deeds from the ledger | Scenes referencing ledger entries |
| Spotlight | Every present player acts each round; DM addresses quiet players by name | Distribution of actions and narration mentions per player |
| Tension | Scene goals and visible clocks ("Guards alerted 2/4") | Scenes ending with no stakes |
| Dice drama | Player clicks Roll; a "?" die, then the number is revealed; DC revealed after the roll; tiered moments (natural 20/1, crits, clutch saves, near misses, killing blows) with their own presentation and narration; "Dice of the night" recap ([panel spec: Dice moments](dnd-panel-spec.md#dice-moments)) | Share of rolls tagged with a moment; playtest rating of roll excitement |
| Consistency | Numbers from the database only; locked names | Contradictions against ledger/state |
| NPC personality | Each NPC has a voice or tic in the bible | Playtest rating |
| Safety | Lines and veils from setup are in layer A | Boundary violations |

Playtests use a 1–5 rubric: fun, clarity, fairness, "felt heard", and pacing. Each milestone records rubric results alongside its correctness exit criteria; a milestone that passes tests but fails the fun bar is not done.

## 9. Saved data and consistency

Every record is scoped to bot instance, guild, and campaign as appropriate. Proposed entities:

| Entity | Essential contents |
| --- | --- |
| Campaign | Organizer, channels, language, pacing settings, away policy, lifecycle, current mode/scene, state revision, rules revision |
| Rules profile | Baseline, selected house-rule options, source references, capability version |
| Member | Discord user, role, join/readiness state, active character, away status, proxy grant |
| Character | Draft/accepted version, owner, build choices, current resources, inventory, visibility |
| Scene/adventure | Bible version and language, visible description, DM notes, entities, discoveries, transitions |
| Round/encounter | Participants, submissions, deadlines, order, turn budget, reactions, conditions |
| Action/check/roll | Submission identity, actor, expected revision, status, saved inputs/results |
| Ledger entry | Entity ID, canonical name, facts, visibility, source events |
| Summary | Scene/chapter, text, source event range, language |
| Campaign event | Ordered changes, causation, actor, rules revision, correction links |
| Panel reference | Logical card identity, channel/message IDs, rendered revision |
| Delivery/image job | Stable job key, status, retries, resulting message/asset identity |
| Timer | Kind, target, deadline, remaining duration when paused |
| Usage | Tokens and latency per call, image spend |

Campaigns require transactional storage: SQLite for local deployments and PostgreSQL for database deployments, with Drizzle migrations for both. Unlike some existing local features, campaigns must not use JSON file stores. Maintain current state plus an append-only event history. Do not introduce a general event-sourcing framework as a prerequisite.

The bot runs as a single process. Serialize campaign operations in-process with `KeyedSerialQueue` keyed by campaign, and enforce a `state_revision` check (optimistic concurrency) and uniqueness constraints in the database to handle restarts and retries. Multi-process scaling is out of scope; revisit if deployment changes. Perform slow model/image calls outside database transactions and verify the expected revision before accepting results.

Save gameplay outcomes before publishing their effects. Queue Discord delivery durably so a sending failure never causes another roll or another resource spend. Discord delivery has an uncertainty window if sending succeeds but saving the returned message ID fails: use recoverable event identifiers and reconciliation to locate existing output before retrying. Do not promise absolute exactly-once Discord delivery.

Timers are stored as deadlines with remaining-duration and completion metadata. The worker processes due timers through the same serialized transaction path as player actions. Startup first enters recovery pause for active timed campaigns; resume follows §5 and never fires an unattended cascade of deadlines.

Corrections create explicit events. A simple latest-action correction may be reversible; earlier corrections require a checkpoint or validated dependent-state repair. Never blindly subtract an old event when later actions depend on it. Retained public history should receive a correction notice.

## 10. Persistent card repair

Create one campaign panel reconciliation service for setup, startup, deletion events, updates, and organizer repair.

For each desired logical card:

1. Resolve its saved message reference and check the message exists.
2. Update an existing message from current campaign data, or create a replacement.
3. Save the replacement identity and rendered revision.
4. Restore intended pins where permissions permit.
5. Reject controls from obsolete messages and point users to current controls.

Serialize reconciliation per campaign and coalesce bursts of refresh requests. Include recoverable card identifiers to handle creation followed by a persistence failure. Handle individual and bulk message deletion, plus missed deletion while offline.

Missing cards never trigger character recreation, rules changes, or campaign restart. Stop automatic recreation when the campaign is intentionally archived or its display is disabled. If a channel is deleted or permissions are removed, report the issue and let the organizer bind a replacement channel; avoid repeated failing sends or uncontrolled channel recreation.

Deleting and recreating a message cannot preserve its old chronological position. Refresh the pinned Party dashboard's hero links after repair so replacement cards remain discoverable; My Hero on the Adventure panel remains a direct access path. Preserve the saved Table Talk thread identity independently of the dashboard message so repairing the dashboard does not duplicate discussion. Thread lifecycle and recovery follow the panel specification.

## 11. Integration with this repository

Preserve the current dependency direction: Discord adapters → application services → domain rules and gateway interfaces → persistence/provider adapters.

Proposed locations and responsibilities:

- `src/domain/campaign/`: mechanics, house-rule options, dice/check resolution, character validation, encounter and round transitions, autopilot, glossary IDs.
- `src/application/campaign/`: setup, lobby, DM orchestration, context assembly and compaction, ledger, action resolution, timers, card reconciliation, checkpoints and recovery.
- `src/application/i18n/`: campaign UI strings and glossaries for `en` and `zh-TW`.
- `src/infrastructure/discord/commands/campaign/`: command entry points and interaction presentation; keep campaign mechanics out of handlers.
- `src/infrastructure/persistence/`: SQLite/PostgreSQL campaign repositories and transactional operations.
- Existing provider infrastructure (`chat-provider.ts`, Gemini/OpenAI providers): add narrow interfaces `CampaignPlanner`, `CampaignNarrator`, `CampaignChronicler`, `AdventureTranslator`, and `SceneImageGenerator`, each with its own prompt and JSON schema, implemented per provider like the existing standalone calls. They must not inherit chat persona, memory, or reply-history behavior. Model choice is configurable per call so cheaper models can serve background calls.
- Existing settings registry: campaign feature flag, limits, image policy, token budget, and organizer permissions.
- Bootstrap: register commands, buttons, selects, modals, deletion handling, timer worker, startup recovery, and shutdown.
- Harness: a script under `src/scripts/` that runs a campaign headlessly with scripted or LLM-simulated players and reports the §8 measurements.

Reuse patterns from `ControlChannelService`, `PanelRefreshCoordinator`, `KeyedSerialQueue`, the access policy layer, and persistence factory. Reuse is conditional on campaign semantics; the music panel's state keys and ordinary chat's delivery-before-state-commit sequence are not suitable campaign defaults.

Suggested command surface: `/campaign create`, `/campaign status`, `/campaign hero`, `/campaign pause`, `/campaign resume`, `/campaign repair`, and organizer-only correction/archive controls. Keep common play on buttons rather than requiring players to learn commands.

Persist engine capability and house-rule option versions. An engine upgrade must keep existing campaign behavior compatible or require an explicit migration; never reinterpret a saved campaign silently.

## 12. Delivery milestones and exit criteria

| Milestone | Deliverable | Exit criterion |
| --- | --- | --- |
| 0. Headless DM harness | Mechanics for the curated subset in TypeScript, three preset heroes, starter adventure in `en` and `zh-TW`, glossary, round resolution, **minimal headless combat** (initiative, action budgets, zones and engagement, the attack sequence, damage and healing, spell slots, concentration, the catalog's conditions, death saves, opportunity attacks, monster tactic profiles), context layers A–F with basic ledger, scripted and simulated players | Scripted playthroughs in both languages meet latency, length, and spotlight targets; internal playtest rubric passes; cost per session is known |
| 1. Discord play slice | Lobby with presets, baseline public/private panels from the panel specification, round-based exploration and checks, pacing presets with timers, away mode (background), SQLite/PostgreSQL state, pause/resume | A real group plays a one-hour Live session in each language; a restart preserves a pending roll and pauses timers for explicit recovery |
| 2. Discord combat | Discord combat controls on top of the milestone 0 engine: encounter reveal, turn view, target menus, reaction prompts, turn timers, autopilot, proxy play, pre-declared reactions, and broader reaction support | Party completes the starter encounter without duplicate rolls, unauthorized actions, or lost resources, including with an away player |
| 3. Reliability hardening | Complete card reconciliation, durable delivery queue, permission checks, recovery paths | Acceptance scenarios for recovery and permissions pass; authorization, idempotency, and saved state already exist in earlier milestones |
| 4. Creation, house rules, and art | Adventure upload and the Adventure Author (convert and generate within the ruleset catalog, validated), guided builder, house-rule option cards, scene images with budgets | Selected options change actual mechanics; image failures leave text play working |
| 5. Multi-session continuity | Budget-driven compaction, chapter summaries, entity-keyed retrieval, recaps, public journal, play-by-post pacing pilot | A three-session campaign keeps established facts and names consistent; secrets stay private |
| 6. Release verification | Database parity, documentation, pilot playtest | Acceptance scenarios pass; pilot issues affecting play are resolved; fun rubric meets the agreed bar |
| Later | LLM rules importer, `ja`, embedding recall | Separate plans |

No calendar estimate is committed before milestone 0 fixes content scope.

### Milestone 0 content proposal

To confirm before authoring; chosen to exercise each core mechanic once, including concentration (required by the Life Domain's Bless), without summons or reach weapons.

| Area | Proposal |
| --- | --- |
| Heroes | Level-1 Fighter (Fighting Style, Second Wind), Rogue (Sneak Attack, Expertise, Thieves' Cant; Cunning Action arrives at level 2), Cleric (Life Domain: heavy armor proficiency, Disciple of Life, and the always-prepared domain spells Bless and Cure Wounds) |
| Spells | Cantrips: Sacred Flame, Thaumaturgy (narrative effects only). Level 1: Bless, Cure Wounds, Healing Word, Guiding Bolt. Concentration is therefore in milestone 0 (one concentration effect per caster; Constitution save at DC max(10, half damage) on taking damage; ends on incapacitation, death, or casting another concentration spell). Guidance stays out to keep the list small. Verify every entry against SRD 5.1 |
| Conditions | Prone, Frightened, Poisoned, Unconscious, plus death saves |
| Resources | HP, hit dice, spell slots, Second Wind uses, short and long rest |
| Monsters | Goblin-type skirmisher, wolf-type brute, one named leader with a flee threshold |
| Adventure | Three scenes, 60–90 minutes: a social scene (information from a wary NPC), an exploration scene with a skill challenge and a clock, and one combat encounter. Includes one secret and one optional peaceful resolution |
| Languages | Bible, glossary, and preset heroes authored in `en` and `zh-TW` |

### Harness

A script under `src/scripts/` runs a campaign end to end without Discord, using the real engine and pipeline. Use in-memory SQLite for fast isolated tests and file-backed SQLite for process-restart/recovery tests.

- **Players:** scripted action lists for deterministic regression runs, and LLM-simulated player personas for exploratory runs: cautious, chaotic, quiet, rules-lawyer, off-topic, and prompt-injection attacker.
- **Modes:** fixed seeds for dice; recorded model responses for replay; live provider runs for measurement.
- **Report:** latency p50/p95 per call, tokens and cache hit rate, narration length distribution, spotlight distribution, planner validation failures, contradictions between narration and state, secret-leak scan of public outputs, `zh-TW` Simplified-character scan, and the full transcript for human rating with the §8 rubric.
- **Restart checks:** run the harness in a child process against one temporary file-backed database; kill and restart at controlled failure points and randomized points, then verify saved rolls, stage completion, and recovery-paused timers. Retain the database across child lifetimes and clean it after the test. Run equivalent PostgreSQL recovery checks before release.

## 13. Acceptance scenarios

Automated tests cover consequential mechanics, authorization, and recovery. Use scripted model responses for repeatable integration tests, the harness for fun and cost measurements, and a manual Discord pilot for usability and real provider behavior.

1. Two users compete for the final lobby seat: exactly one succeeds.
2. Repeated Join and reopening an expired private view preserve one saved draft.
3. Only the organizer starts; start fails with an invalid/unready registered hero.
4. Rules option changes invalidate affected readiness; unsupported character options cannot be selected.
5. Another player cannot read private notes or spend someone else's resources through shared controls.
6. A popup submitted after the round or scene changes receives a useful private conflict response.
7. Repeated Roll/action interactions and provider retries do not reroll or double-spend.
8. Reaction handling allows eligible out-of-turn play and rejects other out-of-turn actions.
9. A crash after a saved roll or committed result resumes from the same result.
10. Discord delivery failure retains committed state and produces recoverable delivery work.
11. Deleted/bulk-deleted cards are recreated from current data, including after offline deletion.
12. Missing permissions/channel removal produce a recoverable organizer issue; archived campaigns stay archived.
13. Two simultaneous actions on one campaign are serialized; a stale revision is rejected, not overwritten.
14. A round closes correctly when all present players submit, when its timer expires, and when the organizer closes it; deadlines survive restart and pause.
15. Missed timers apply the away policy; repeated misses mark the player away; I'm back rejoins at the next round/turn with a catch-up recap.
16. Autopilot never spends limited resources, speaks, or makes story choices; away heroes follow the configured death rule.
17. A proxy can act only within the owner's grant and only while the owner is away.
18. Player action text that claims items, stats, or authority does not change state or override instructions.
19. Narration, ledger, and recaps stay in the campaign language; glossary terms and canonical names are used consistently across a multi-session run.
20. Numbers in narration always match database state; compaction never stores HP/resource values in summaries.
21. Secret adventure material is excluded from public cards, journals, recaps, and image prompts.
22. Image timeout and budget exhaustion leave text play functional; late images attach correctly.
23. Separate campaigns and reusable characters never share live state or private context; campaign content never reaches chat memory.
24. Pausing/resuming a combat or reaction window preserves eligibility and remaining timer durations.
25. A malformed or invalid Planner proposal is retried once, then held without applying any part of it; submissions are kept.
26. Regenerate narration never rerolls dice or changes state; the Narrator cannot introduce state changes.
27. The Safety button is anonymous to other players and steers the next narration.
28. Off-ladder DCs, unknown clue/item/encounter IDs, and effects outside the hero's capability are rejected.
29. Ordinary monster turns need no model call; a slow or invalid named-NPC choice falls back to its tactic profile.
30. `zh-TW` output contains no Simplified-only characters in the harness corpus.
31. A complete pilot runs lobby → character creation → scene → check → combat → recap → restart/resume in each launch language.
32. Narrator and public-summary request payloads exclude unrevealed secrets and private notes, including indirect context from private summaries.
33. Unlock-then-enter dependencies, competing use of one item, and failed prerequisites cannot create impossible outcomes or double-spend; restart between stages preserves committed outcomes.
34. Each timeout type reaches its defined terminal/waiting state; an all-away party creates no empty-round loop, and recovery never simulates unattended rounds.
35. A delayed Chronicler cannot overwrite newer facts or visibility; pending source events remain available until accepted compaction covers them.
36. A long single scene and large adventure/ledger remain within the total prompt budget without dropping unresolved actions or leaking private summary material.
37. Restart tests preserve a file-backed database across processes and verify SQLite/PostgreSQL recovery behavior.
38. Panel layouts and state transitions pass the companion [panel acceptance scenarios](dnd-panel-spec.md#acceptance-scenarios) in both launch languages and on mobile.
39. An attack that triggers Shield waits at the reaction window; the final hit is decided after the reaction, damage is rolled only on a hit, and a restart at any stage resumes without rerolling.
40. Leaving engagement without Disengage triggers an opportunity attack before the mover leaves; Disengage, forced movement, and an attacker without its reaction do not.
41. The target menu and Planner validation agree with the positioning contract on reach, range, cover, and blocked line of sight.
42. Improvised check DCs outside the ladder are rejected; spell save DCs (e.g. 13), monster DCs, and concentration DCs come from formulas or content and are never set by the Planner.
43. A protected away hero at 0 HP is not targeted, is unaffected by area effects, makes no death saves, and cannot die; protection ends on return with normal rules from then on; a player cannot go away while their hero is dying.
44. Bless requires and holds concentration; damage prompts a concentration save at DC max(10, half damage); casting another concentration spell or becoming incapacitated ends it.

When implementation changes land, run targeted tests plus the repository's required type, lint, migration, and test checks. This documentation-only planning change does not require application tests.

## 14. Remaining product choices

These are proposed defaults to revisit, not blockers to the plan:

- ~~SRD 5.1 versus 5.2.1~~ **Decided 2026-09-26: SRD 5.1 (2014).** It aligns with the surveyed Traditional-script reference and BG3's underlying edition; BG3 deviations remain explicit house rules. A 5.2.1 baseline is deferred.
- Confirm the BG3-style preset's rules against the game before shipping it.
- Select the exact starter character, spell, condition, and monster catalog during milestone 0.
- Tune pacing preset timers, the compaction budget, and latency targets from harness and pilot data.
- Decide the initial house-rule option list and its defaults.
- Pick the `zh-TW` term for each glossary entry where community usage splits, and decide which terms show an English abbreviation.
- Set image and token budgets based on the configured providers.

The next implementation task is milestone 0: the headless DM harness. Do not start with Discord infrastructure, a universal rules importer, or a full SRD database.

## References

- [Official D&D System Reference Documents](https://www.dndbeyond.com/srd): baseline source and version selection; retain required source attribution with bundled content.
- [UpToGo: D&D 5E 中文社群資源與規則整合指南](https://uptogo.com.tw/%E9%81%8A%E6%88%B2/%E6%A1%8C%E9%81%8A/dnd-%E4%B8%AD%E6%96%87%EF%BC%9F/) (2026-04-24): overview of the Chinese 5E landscape — no official Traditional Chinese edition, community translation sites. A secondary source; verify rules details against the SRD.
- [5etools 中文 (wayneh.tw)](https://5etools.wayneh.tw/) and [5etools 中文 (kiwee.top)](https://5e.kiwee.top/): community translation mirrors used for the §7 terminology survey only; unofficial, not a content source.
- [Discord interaction overview](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/overview.mdx): user-triggered commands, components, and modals.
- [Discord interaction responses](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx): acknowledgement and interaction-token constraints; private views are not durable storage.
- [Discord pin guide](https://support.discord.com/hc/en-us/articles/221421867-Pin-Messages-FAQ): pins and their navigation behavior.
- [Discord message API](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx): message lifecycle and deletion permissions.
- Repository references: `docs/architecture.md`, `docs/system-flows.md`, `src/application/control-panel/control-channel-service.ts`, `src/application/chat/chat-provider.ts`, `src/application/chat/channel-message-summarization.ts`, `src/application/i18n/language.ts`, `src/domain/games/dice.ts`, and `src/infrastructure/persistence/persistence-factory.ts`.
