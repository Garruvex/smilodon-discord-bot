# D&D campaign: code structure

Status: planning draft, 2026-09-26. Companion to the [DM bot plan](dnd-dm-bot-plan.md) and [panel specification](dnd-panel-spec.md). Describes intended module boundaries, interfaces, and registration; nothing here is implemented yet. Code blocks are interface sketches, not final signatures.

## 1. Goals

- **A pure, deterministic rules engine.** Given the same state, command, rules profile, and dice values, it always produces the same result. No I/O, no clock, no randomness inside the domain.
- **Content is registered, validated, and sealed at startup.** A broken reference, missing translation, or unsupported mechanic fails the build or the boot, never a player's turn.
- **One write path.** Every state change, whether from a button, a timer, an LLM result, or an organizer correction, goes through the same command pipeline, queue, and transaction.
- **Replaceable edges.** Discord, the database, LLM providers, image generation, clock, and randomness are ports with adapters, so the headless harness runs the real engine and pipeline with test adapters.
- **Follow existing repository patterns** (dependency direction, `ComponentRegistry`, `AccessPolicyService`, `KeyedSerialQueue`, per-provider narrow LLM interfaces, persistence factory) rather than introducing a framework.

## 2. Layers and directories

Dependency direction is unchanged: Discord adapters → application → domain → (ports implemented by) infrastructure.

```text
src/domain/campaign/
  core/            ids, Result type, revision, errors, pure utilities
  dice/            dice expressions, RollRequest/RollResult, no RNG
  rules/           registry types, ruleset profile, house-rule option definitions
  content/         ruleset folders (srd-5.1/, later srd-5.2.1/) and shared builders; see §4.1.1
  character/       character model, derived stats, build validation
  state/           CampaignState aggregate, scene/round/encounter/timer state
  commands/        command union (player, system, organizer)
  events/          event union and evolve()
  engine/          decide() per command family, effect application, legality, autopilot
  projection/      public/private read models (hero card, action panel, journal)
  ledger/          ledger entry model, visibility, validation

src/application/campaign/
  campaign-command-bus.ts      the single write path
  unit-of-work.ts              transactional port
  ports/                       repositories, stores, gateways, LLM and image ports, clock, random
  dm/                          planner/narrator/chronicler orchestration, context assembly, compaction
  workers/                     outbox, timer, DM job, image job workers
  panels/                      panel reconciliation service, render-request coalescing
  setup/ lobby/ recovery/      setup flow, lobby, startup recovery
  harness/                     headless runner used by src/scripts

src/infrastructure/discord/campaign/
  campaign-component-handler.ts   one ComponentHandler registered with the existing registry
  routes/                         route table: act, speak, roll, target, more, organizer, …
  custom-id.ts                    custom ID codec
  renderers/                      Components V2 builders per panel kind
  discord-campaign-gateway.ts     send/edit/delete, webhooks, pins, permission checks
  commands/                       /campaign subcommands

src/infrastructure/persistence/campaign/
  sqlite-*.ts  postgres-*.ts      repository and store adapters, one unit of work per backend

src/infrastructure/chat/          existing providers gain CampaignPlanner/Narrator/Chronicler implementations
src/application/i18n/campaign/    UI strings and glossaries (en, zh-TW)
src/scripts/campaign-harness.ts   CLI entry for the headless harness
```

`src/domain/campaign` imports nothing from `application` or `infrastructure`, and nothing from `discord.js`, database, or provider libraries. An ESLint `no-restricted-imports` rule enforces this.

## 3. The engine: decide and evolve

State changes follow a decide/evolve split. This gives the "current state plus append-only events" model from the plan without an event-sourcing framework.

```ts
// Pure. Validates a command against state and rules; returns events or a typed rejection.
function decide(state: CampaignState, command: CampaignCommand, ctx: EngineContext): DecideResult;

// Pure. Applies one event to state. Never validates, never fails.
function evolve(state: CampaignState, event: CampaignEvent): CampaignState;

interface EngineContext {
  rules: SealedRuleset;          // content + selected house-rule options
  now: Instant;                  // supplied by the application from the Clock port
  rolls: RollLookup;             // already-saved roll results available to this decision
}

type DecideResult =
  | { kind: "accepted"; events: CampaignEvent[]; requests: EngineRequest[] }
  | { kind: "rejected"; reason: Rejection };       // typed, localizable, shown privately

// Things the engine needs the application to do, expressed as data.
type EngineRequest =
  | { kind: "roll"; rollId: RollId; request: RollRequest }   // application rolls, saves, re-enters
  | { kind: "plan"; round: RoundRef }                         // ask Planner
  | { kind: "narrate"; source: NarrationSource }
  | { kind: "startTimer"; timer: TimerSpec }
  | { kind: "cancelTimer"; timerId: TimerId }
  | { kind: "refreshPanels"; panels: PanelRef[] }
  | { kind: "deliver"; delivery: DeliverySpec };            // result lines, reveals, speak lines
```

Rules:

- `CampaignCommand` and `CampaignEvent` are **discriminated unions**. `decide` and `evolve` use exhaustive `switch` with a `never` check, so adding a command or event type without handling it is a compile error.
- **Randomness never enters the domain.** When resolution needs dice, `decide` emits a `roll` request with a stable `RollId`. The application rolls with the `RandomSource` port, records a `RollRecorded` event, and re-runs the continuation command, which reads the saved result from `ctx.rolls`. Retries find the saved roll and never reroll.
- **Time never enters the domain implicitly.** `now` is an input, which keeps timers and deadlines testable.
- Every event carries `campaignId`, `sequence`, `causationId` (command or event that caused it), `actor`, and `rulesRevision`.
- `evolve` is also used to rebuild state in tests and the harness from an event list, which is how golden scenario tests work.

## 4. Registration engines

There are four registries, each with a different purpose. Mixing them is the main thing to avoid.

| Registry | Registers | Keyed by | Sealed | Lives in |
| --- | --- | --- | --- | --- |
| Content registry | Classes, features, spells, conditions, monsters, items, actions | Content ID | At startup, per ruleset version | domain |
| House-rule option registry | Option definitions with enumerated values | Option ID | At startup | domain |
| Campaign route table | Discord interaction routes | Route key | At startup | infrastructure |
| Panel renderer registry | Renderers per panel kind | Panel kind | At startup | infrastructure |

What is deliberately **not** a runtime registry: effect kinds, command types, event types, and LLM call types. These are closed unions checked by the compiler. A string-keyed plugin map for effects would move errors from compile time to play time.

### 4.1 Content registry

Content is authored as typed TypeScript definition objects. Mechanics are code, so they are type-checked and unit-tested alongside the engine. Display text is not in the definition; it comes from the glossary by content ID.

```ts
interface ContentDefinition<K extends ContentKind> {
  readonly id: ContentId<K>;              // "spell:cure-wounds", stable forever
  readonly kind: K;
  readonly source: SourceRef;             // "SRD 5.1 p. 230"
  readonly requires: readonly Capability[]; // engine capabilities this entry depends on
}

interface ActionDefinition extends ContentDefinition<"action"> {
  readonly cost: ActionCost;              // action / bonus / reaction / movement / resource
  readonly targeting: TargetingSpec;      // self, one creature, n creatures, area; ally/enemy; range in zones
  legal(actor: ActorView, state: CampaignStateView, rules: SealedRuleset): Legality;
  plan(input: ActionInput, state: CampaignStateView, rules: SealedRuleset): ResolutionPlan;
}

// A plan is data: which rolls to request, and which effects apply per outcome.
interface ResolutionPlan {
  readonly checks: readonly CheckSpec[];  // attack roll, saving throw, ability check
  readonly onOutcome: Readonly<Record<Outcome, readonly Effect[]>>;
}

type Effect =                              // closed union, applied by the engine
  | { kind: "damage"; target: TargetRef; dice: DiceExpr; type: DamageType }
  | { kind: "heal"; target: TargetRef; dice: DiceExpr }
  | { kind: "applyCondition"; target: TargetRef; condition: ContentId<"condition">; duration: Duration }
  | { kind: "spendResource"; owner: ActorRef; resource: ResourceId; amount: number }
  | { kind: "moveZone"; target: TargetRef; to: ZoneId }
  /* … */;
```

Classes, features, spells, and items **grant** actions and passive modifiers by referencing IDs, for example a Cleric feature granting `action:cast-spell` with a spell list, and a spell definition supplying its own `plan`. The same `ActionDefinition` interface drives:

- the private turn view (legal actions and targets come from `legal` and `targeting`);
- the Planner's legal-options list and validation of its proposals;
- autopilot, which picks from the same legal set;
- the preview (the plan is computed before anything is rolled or spent).

Build and seal:

```ts
const srd51 = new ContentRegistryBuilder("srd-5.1", "2026.1")
  .add(srd51Conditions)
  .add(srd51Classes)
  .add(srd51Spells)
  .add(srd51Monsters)
  .build({ capabilities: engineCapabilities, glossaries: [enGlossary, zhTwGlossary] });
// build() validates everything below, then returns an immutable SealedContent.
```

`build()` fails with a list of all problems at once when:

- two entries share an ID, or an ID does not match its kind prefix;
- a referenced ID does not exist or has the wrong kind;
- an entry requires a capability the engine does not implement (for example `concentration` before it exists);
- a glossary is missing a display name for any entry in either launch language;
- a class or preset offers an option whose entries are not all present.

A unit test builds every shipped ruleset, so these failures show up in CI. Startup builds them again and refuses to boot on error, matching how guild profiles are validated today.

### 4.1.1 Where rules live

"Rules" split three ways, and each has one home:

| Kind | Example | Home |
| --- | --- | --- |
| Core mechanics | Attack rolls, advantage, death saves, concentration | Shared engine code in `domain/campaign/engine/`, written once |
| Content | Fighter, Cure Wounds, Goblin, Prone, Longsword | One definition object each, in a ruleset folder |
| Rule variants | Grapple as contest (2014) or save (2024); potion as action or bonus action | Each variant implemented once in the engine; a ruleset's `core-rules.ts` selects defaults and house rules override them |

A ruleset is a folder, not a file:

```text
src/domain/campaign/content/
  shared/                  builders reused by any ruleset (weaponAttack(), spellAttack(), …)
  srd-5.1/
    index.ts               defineRuleset({ id, version, coreRules, content })
    core-rules.ts          engine variants used by the 2014 rules
    actions.ts             Attack, Dash, Dodge, Disengage, Help, Hide
    conditions.ts
    classes/fighter.ts  classes/rogue.ts  classes/cleric.ts
    spells/cantrips.ts  spells/level-1.ts
    items/weapons.ts  items/armor.ts
    monsters/goblin.ts  monsters/wolf.ts
  srd-5.2.1/               later; its own folder and core-rules.ts
src/domain/campaign/rules/
  house-rules.ts           option definitions
  presets/bg3-style.ts     named bundle of option values
src/application/i18n/campaign/glossary/
  en/srd-5.1.ts  zh-TW/srd-5.1.ts   display names keyed by content ID
```

Editions and house rules use the same mechanism: a ruleset picks default variants, and house-rule options override specific ones. A later ruleset may reuse an unchanged entry only by explicitly importing it from another ruleset's folder; nothing is shared implicitly. Campaigns pin their ruleset ID and version, so adding `srd-5.2.1` never changes a running `srd-5.1` campaign.

### 4.2 House-rule options and ruleset profiles

```ts
interface HouseRuleOption<V extends string> {
  readonly id: OptionId;                  // "potion-drinking"
  readonly values: readonly V[];          // ["action", "bonus-action"]
  readonly defaultValue: V;
  readonly requires: readonly Capability[];
}

interface RulesetProfile {                // saved per campaign, immutable per revision
  readonly baseline: { id: "srd-5.1"; version: string };
  readonly options: Readonly<Record<OptionId, string>>;
  readonly presets: readonly PresetId[];  // e.g. "bg3-style", expanded into options when saved
}

// What the engine reads: content plus typed option accessors.
interface SealedRuleset {
  readonly content: SealedContent;
  option<V extends string>(option: HouseRuleOption<V>): V;
}
```

Engine code reads options through typed accessors (`rules.option(potionDrinking) === "bonus-action"`), never by string lookup. Presets such as BG3-style are named bundles of option values; the saved profile stores the expanded values, so changing a preset later never changes an existing campaign.

### 4.3 Campaign route table (Discord interactions)

The campaign registers **one** `ComponentHandler` with the existing `ComponentRegistry`, using prefix `cmp`. Inside it, a campaign route table dispatches by route key. This keeps campaign routing out of the global registry and gives every campaign interaction the same authorization and session handling.

```text
customId = "cmp:<route>:<ref>"      e.g. "cmp:act:7Qf3k"
```

- `<route>` is a registered route key (`act`, `speak`, `pass`, `roll`, `target`, `turn`, `react`, `more`, `org`, `hero`, …). An unknown route gets a private "these controls are outdated" response.
- `<ref>` is an opaque, short **view reference** to a saved row holding campaign ID, panel generation or view session, actor binding, and context such as the round or check. It never contains secrets or game data. This avoids Discord's 100-character custom ID limit and makes stale-control detection a lookup, not string parsing.

```ts
interface CampaignRoute {
  readonly key: RouteKey;
  readonly scope: "sharedPanel" | "privateView" | "modal";
  readonly audience: "member" | "activeActor" | "owner" | "organizer";
  handle(ctx: CampaignInteractionContext): Promise<void>;
}
```

The campaign component handler, for every interaction:

1. Decodes the custom ID and loads the view reference; rejects unknown or expired references.
2. For shared panels, checks the panel generation is current; stale controls get a private pointer to the current panel.
3. Resolves membership and the route's audience (organizer, owner, active actor or authorized proxy) from saved campaign state, on top of the existing module-level `AccessPolicyService` check.
4. Acknowledges within Discord's deadline: returns a modal directly, or defers privately.
5. Translates the interaction into a `CampaignCommand` (or a read-only view render) and calls the command bus. Routes never mutate state themselves.

A new `CommandModule.Campaign` value gates the whole feature through the existing access policy and guild feature flags. Denial and failure copy is localized through the hook in §12.

### 4.4 Panel renderer registry

```ts
interface PanelRenderer<P extends PanelKind> {
  readonly kind: P;                       // "campaign-control" | "hero" | "action-control" | "encounter-reveal" | …
  render(projection: ProjectionOf<P>, text: CampaignTexts): V2Payload;
  budget(payload: V2Payload): BudgetCheck;   // components, characters, images vs Discord limits
}
```

Renderers are pure: projection in, Components V2 payload out. Projections come from `domain/campaign/projection` and are already audience-filtered (public or a specific player), so a renderer cannot leak what it never receives. The reconciliation service asks the registry for the renderer of each desired logical card. Renderer tests snapshot payloads and assert the budget for the worst-case fixtures (six heroes, long `zh-TW` names).

## 5. The single write path

```ts
interface CampaignCommandBus {
  execute(command: CampaignCommand, meta: CommandMeta): Promise<CommandOutcome>;
}

interface CommandMeta {
  readonly commandId: CommandId;          // idempotency key (interaction ID, timer ID, job ID)
  readonly actor: ActorIdentity;          // Discord user, system timer, DM job, organizer
  readonly expectedRevision?: Revision;   // required for LLM/job results and stale-sensitive actions
}
```

`execute` does, in order:

1. Enqueue on `KeyedSerialQueue` keyed by campaign ID, so one campaign processes one command at a time in-process.
2. Return the saved outcome if `commandId` was already processed (retries, double clicks, redelivered jobs).
3. Load the campaign state from its tables (§11) and the ruleset; build `EngineContext` from the `Clock` and saved rolls.
4. Call `decide`. A rejection returns immediately with a typed reason for a private reply.
5. In **one transaction** through the `UnitOfWork` port: compare-and-set `campaigns.state_revision`, write the changed entity rows, append events, record the processed `commandId`, and write all engine requests to the **outbox** and timer tables.
6. Commit, then wake the relevant workers.

Nothing slow happens inside the transaction. A lost compare-and-set (another process or a recovery path moved the revision) reloads and re-decides once, or returns a conflict for commands that carry an `expectedRevision`.

### Workers

| Worker | Consumes | Does | Re-enters as |
| --- | --- | --- | --- |
| Roll worker | `roll` requests | Rolls with `RandomSource`, saves result | `RecordRoll` command |
| DM job worker | `plan`, `narrate`, chronicle requests | Assembles context, calls provider, validates schema | `ApplyPlan`, `RecordNarration`, `ApplyLedgerProposal` with `expectedRevision` |
| Delivery worker | `deliver`, `refreshPanels` | Renders and sends/edits via the Discord gateway; coalesces refreshes | `RecordDelivery` (message IDs) |
| Timer worker | Due timers | Fires each timer once | `TimerExpired` |
| Image worker | Image jobs | Generates or reuses assets within budget | `RecordAsset` |

Every worker reads from durable tables, marks work complete idempotently, and bounds retries. Workers start after startup recovery puts active timed campaigns into `recovery_paused` (plan §5).

## 6. Ports

All live in `src/application/campaign/ports/`. Infrastructure implements them; the harness supplies test versions.

| Port | Responsibility | Adapters |
| --- | --- | --- |
| `UnitOfWork` | Transaction wrapping the repositories below | SQLite, PostgreSQL, in-memory |
| `CampaignRepository` | Assemble `CampaignState` from tables; save changed rows with revision CAS | SQLite, PostgreSQL, in-memory |
| `EventLog` | Append and read events by range | SQLite, PostgreSQL |
| `Outbox` / `TimerStore` / `ProcessedCommands` | Durable work, deadlines, idempotency | SQLite, PostgreSQL |
| `ViewReferenceStore` | Custom ID references and private view sessions | SQLite, PostgreSQL |
| `PanelStore` | Logical card ↔ Discord message identity and generation | SQLite, PostgreSQL |
| `CampaignDiscordGateway` | Send, edit, delete, webhooks, pins, permission checks | discord.js, recording fake |
| `CampaignPlanner` / `CampaignNarrator` / `CampaignChronicler` / `AdventureTranslator` | Structured LLM calls | OpenAI Responses, OpenAI-compatible, Gemini, scripted fake |
| `SceneImageGenerator` | Scene art, portraits, monster art | Provider adapters, placeholder fake |
| `AssetStore` | Portrait and art storage | Existing guild asset store |
| `RandomSource` | Integers for dice | `crypto.randomInt`, seeded PRNG for tests |
| `Clock` | Current time | System clock, controllable fake |

`src/domain/games/dice.ts` keeps serving the existing `/roll` feature. Campaign dice live in `domain/campaign/dice`, with randomness only through `RandomSource`.

## 7. Content and data formats

| Content | Format | Why |
| --- | --- | --- |
| Rules content (classes, spells, monsters, conditions) | TypeScript definitions | Mechanics are code; compile-time types and unit tests |
| Glossaries and UI strings | TypeScript i18n modules keyed by content ID | Matches existing `src/application/i18n/messages/*`; missing keys fail the content build |
| Starter adventures | YAML validated with zod (both already dependencies) | Authored content, not code; same shape an organizer outline will use later |
| Organizer outlines and house-rule text | Validated data in the database | User-supplied; never code |

Adventure data references content IDs (`monster:goblin`) and declares its own entities (`npc:garrick`, `clue:ledger`, `scene:watchtower`). Loading an adventure validates it against the sealed ruleset, so an adventure cannot reference a monster or item the ruleset lacks.

## 8. Versioning

- A campaign saves its ruleset baseline ID and version, expanded option values, adventure version, and engine capability version.
- Content definitions are immutable within a ruleset version. Fixing a rules bug means a new ruleset version; existing campaigns keep theirs until an explicit migration.
- Event payloads and `rules_data` columns carry a schema version. Old events and rows are upcast when read, so `evolve` and the engine only handle the current shape. Table shape changes go through normal Drizzle migrations for both backends.
- LLM prompts and JSON schemas carry a version recorded with each call, so harness results and bug reports are comparable.

## 9. Testing structure

| Level | What | How |
| --- | --- | --- |
| Domain unit | `decide`/`evolve`, legality, effects, derived stats | Pure functions, no mocks |
| Content build | Every shipped ruleset and glossary builds cleanly | `ContentRegistryBuilder.build()` in a test |
| Golden scenarios | Command sequences → expected events and state | Fixed dice via saved rolls; replay with `evolve` |
| Application | Command bus, idempotency, CAS conflicts, outbox, timers, recovery | In-memory `UnitOfWork`, fake clock and random |
| Persistence | SQLite and PostgreSQL adapters behave identically | Shared contract test suite run against both |
| Renderers | Payload snapshots and Discord budget limits | Worst-case projection fixtures, both languages |
| Routes | Authorization, stale controls, audience checks | Fake interactions against the route table |
| Harness | Fun, cost, latency, leaks, language | Scripted and simulated players (plan §12) |

## 10. Build order for milestone 0

1. `core`, `dice`, and the `RandomSource`/`Clock` ports.
2. Content registry types, builder, validation, and the glossary contract.
3. The milestone 0 SRD 5.1 content: three heroes, spells, four conditions, three monsters.
4. `CampaignState`, commands, events, `decide`/`evolve` for exploration rounds and checks, then combat.
5. In-memory `UnitOfWork`, command bus, outbox, timer, and roll workers.
6. Planner/Narrator ports with scripted fakes; context assembly and ledger.
7. The harness CLI; then real provider adapters for measurement.
8. SQLite adapters and the restart tests.

Discord routes, renderers, and PostgreSQL come in milestone 1, on top of interfaces the harness has already exercised.

## 11. Storage layout and tenancy

**Decided: shared campaign tables scoped by guild, not a schema per server.**

The PostgreSQL deployment already isolates each bot instance in its own schema (`search_path` in `src/infrastructure/database/database.ts`), and every existing feature stores per-guild data in shared tables keyed by `guild_id`. A schema per guild was considered and rejected:

- Drizzle migrations target a fixed schema; applying them to N guild schemas needs custom tooling and leaves servers on mixed versions when one fails.
- Outbox, timer, and delivery workers need "all due work" across guilds; shared tables make that one indexed query.
- Local SQLite mode has no schemas, so it would need a database file per guild and diverge from PostgreSQL.
- Instance schemas multiplied by guild schemas grow without bound.

Isolation is provided instead by:

- `guild_id` and `campaign_id` on every campaign row, part of every primary key or unique index where applicable.
- Repository methods that always take both IDs. There is no lookup by campaign ID alone, so no code path can read across guilds. A contract test asserts that a campaign from guild A is invisible through guild B.
- A campaign data purger that deletes one campaign, or all of a guild's campaigns, in one transaction, following `MemberDataPurger`. Member purge also removes that member's campaign-private data (drafts, private notes, proxy grants) while keeping public history attributed to a deleted-member placeholder.
- Table names prefixed `campaign_` inside the existing instance schema.

### Dedicated tables

**Decided: dedicated relational tables per entity, with typed columns for stable and queried fields and a versioned JSON column (`rules_data`) only for rules-specific detail.** Typed columns give readable SQL for debugging and admin tools, database constraints, targeted updates, and simple purges. The JSON column holds details that change shape as rules content grows (build choices, feature uses, effect parameters) and that nothing queries into; it carries a `rules_data_version` and is validated with zod on load.

The engine still receives one in-memory `CampaignState`. `CampaignRepository` assembles it from these tables and, on save, writes only changed rows. Each entity row has its own `revision`; the repository compares loaded and new state per entity and updates rows whose content changed. The single concurrency point is the compare-and-set on `campaigns.state_revision`, so entity rows never need their own conflict handling.

**Game state**

| Table | Key typed columns | JSON | Notes |
| --- | --- | --- | --- |
| `campaigns` | `guild_id`, `id`, `organizer_id`, `name`, `language`, `lifecycle`, `mode`, `current_scene_id`, `state_revision`, `ruleset_id`, `ruleset_version`, `adventure_id`, `adventure_version`, channel/thread IDs | `house_rules` (expanded option values), `pacing`, `away_policy` | One row per campaign; the revision CAS point |
| `campaign_members` | `campaign_id`, `user_id`, `role`, `status` (creating/ready/withdrawn), `availability` (present/away), `joined_at`, `consecutive_misses` | – | Unique `(campaign_id, user_id)`; seat-limit check in the same transaction |
| `campaign_characters` | `campaign_id`, `id`, `owner_user_id`, `name`, `class_id`, `level`, `hp_current`, `hp_max`, `hp_temp`, `ac`, `status` (draft/ready/active/inactive), `portrait_asset_id`, `zone_id`, `accepted_revision` | `rules_data` (abilities, proficiencies, build choices, feature uses, spell slots) | Unique active hero per `(campaign_id, owner_user_id)`; drafts and accepted heroes share the table, distinguished by `status` |
| `campaign_character_items` | `character_id`, `id`, `item_id`, `quantity`, `equipped`, `attuned` | `rules_data` | Inventory |
| `campaign_conditions` | `campaign_id`, `target_ref`, `condition_id`, `source_ref`, `applied_at`, `expires_at_turn`, `expires_on_event` | `rules_data` | One table for heroes and monsters |
| `campaign_proxy_grants` | `campaign_id`, `character_id`, `proxy_user_id`, `allow_resources`, `granted_at`, `revoked_at` | – | Rechecked on every submit |
| `campaign_scenes` | `campaign_id`, `id`, `bible_node_id`, `status`, `improvised`, `opened_at`, `closed_at` | `clocks` | |
| `campaign_rounds` | `campaign_id`, `id`, `scene_id`, `number`, `status` (collecting/planning/rolling/resolved), `closes_at`, `roster_frozen_at` | – | |
| `campaign_submissions` | `round_id`, `member_user_id`, `character_id`, `kind` (action/pass/missed), `text`, `revision`, `status` | `plan` (validated Planner proposal slice) | Unique `(round_id, character_id)`; player wording preserved |
| `campaign_encounters` | `campaign_id`, `id`, `scene_id`, `status`, `round_number`, `turn_index` | – | |
| `campaign_combatants` | `encounter_id`, `id`, `kind` (hero/monster/npc), `character_id` or `monster_id`, `letter`, `name`, `initiative`, `hp_current`, `hp_max`, `zone_id`, `budget_action`, `budget_bonus`, `budget_reaction`, `movement_left` | `rules_data` (tactic state) | Heroes link to their character row; monsters live only here |
| `campaign_checks` | `campaign_id`, `id`, `actor_ref`, `purpose`, `ability_id`, `skill_id`, `dc`, `advantage`, `visibility`, `status`, `deadline`, `stage` | `modifiers`, `outcome_effects` | Pending and resolved checks |
| `campaign_rolls` | `campaign_id`, `roll_id`, `check_id`, `dice` (e.g. `1d20`), `results`, `modifier_total`, `total`, `timed_out`, `rolled_at` | – | Written once; unique `roll_id` |

**Memory and content**

| Table | Key typed columns | Notes |
| --- | --- | --- |
| `campaign_ledger` | `campaign_id`, `entity_id`, `canonical_name`, `visibility`, `revision`, `source_event_from/to` | Layer C; `facts` as text in the campaign language |
| `campaign_summaries` | `campaign_id`, `id`, `level` (scene/chapter), `visibility`, `language`, `source_event_from/to` | Layer D |
| `campaign_assets` | `guild_id`, `id`, `kind` (portrait/monster/scene), `content_key` (e.g. `monster:goblin@style`), `asset_path`, `visibility` | Monster art is reusable across campaigns in the guild via `content_key` |

**Infrastructure**

| Table | Purpose |
| --- | --- |
| `campaign_events` | Append-only events by `(campaign_id, sequence)`; payload JSON with schema version |
| `campaign_processed_commands` | Idempotency keys and saved outcomes |
| `campaign_outbox` | Pending rolls, DM jobs, deliveries, refreshes; indexed by status and due time |
| `campaign_timers` | Deadlines, state (pending/fired/cancelled), remaining duration when paused |
| `campaign_view_refs` | Custom ID references and private view sessions, with expiry |
| `campaign_panels` | Logical card ↔ message identity and generation |

**Rules for the schema**

- Every table has `guild_id` (directly or via `campaign_id` with a foreign key to `campaigns`) and every query filters by it.
- Columns that the engine must keep consistent (HP bounds, budget ≥ 0, `quantity` ≥ 0) also get `CHECK` constraints, as a second line of defense behind the engine.
- Content references (`class_id`, `item_id`, `condition_id`, `monster_id`) are content ID strings, not foreign keys: content lives in code, not in the database. Loading validates them against the campaign's sealed ruleset version.
- Both Drizzle schemas (PostgreSQL `schema.ts` and SQLite) are maintained together, with a shared contract test suite proving identical behavior.

**Server defaults.** A guild can store default campaign settings: preferred preset and house-rule options, pacing, away policy, language, and glossary overrides. Setup pre-fills from them; each campaign saves its own expanded copy, so changing a default never alters a running campaign. These live in the settings registry, not in campaign tables.

## 12. Localized denial messages

The generic `ComponentDispatcher` replies to denied access and failures with fixed English text. The campaign needs these in the campaign language, and ideally every handler would follow the guild language.

Extend `ComponentHandler` with one optional hook:

```ts
export interface ComponentHandler {
  /* existing members unchanged */

  // Optional. Text for a denied or failed interaction, in the handler's own
  // language context. The dispatcher falls back to its generic copy when absent
  // or when this throws.
  describeOutcome?(
    interaction: MessageComponentInteraction | ModalSubmitInteraction,
    outcome: { kind: "denied"; reason: AccessDenialReason } | { kind: "failed" },
  ): Promise<string>;
}
```

- The campaign handler implements it by loading the campaign's language from the view reference, falling back to the guild language.
- Campaign-specific denials (not a member, not your turn, not the organizer, stale control) happen inside the campaign handler after the module-level access check passes, and already use campaign texts. The hook covers only the dispatcher's own module-level denial and unexpected failures.
- Separately and optionally, the dispatcher's fallback copy can use the guild's `Texts` for all handlers. That is a small repository-wide improvement, not a campaign dependency.
- Tests: denial and failure replies render in `zh-TW` for a `zh-TW` campaign in an `en` guild; a throwing hook falls back to the generic copy.

## 13. Open questions

- ~~Snapshot granularity~~ Resolved in §11: dedicated tables with typed columns plus versioned `rules_data` JSON.
- ~~YAML or JSON for adventures~~ Resolved: YAML validated with zod. Both `yaml` and `zod` are already dependencies, used for guild profiles.
- ~~Localized denials~~ Resolved in §12.
