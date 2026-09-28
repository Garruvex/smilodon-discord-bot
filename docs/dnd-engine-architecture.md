# Game engine architecture (review draft)

Status: **proposal, for review. Nothing here is built.** It comes from a review of the code as of the milestone 6 branch. Decisions the owner still has to make are collected in [Open decisions](#open-decisions).

## 1. Goal

The bot is two things that meet at one narrow boundary:

- **The game engine.** Pure rules for SRD 5.1 (2014): characters, inventory, magic, effects, combat, exploration. No Discord, no model calls, no clock, no randomness of its own. It is given a state and a command and returns events and requests.
- **The Discord UX.** Cards, buttons, menus and text. It shows what the engine says and sends commands. It contains **no rules**.

A third thin layer already exists between them (command bus, store, workers, the DM model adapters). It only moves commands and events around. It never decides a rule.

The engine must not care what an adventure needs. An adventure is data that names content (`monster:goblin`, `spell:bless`, `item:longsword`). If the content exists and every mechanic it uses is a supported capability, the adventure plays. A genuinely new mechanic is new engine code plus tests, then content may refer to it.

## 2. What the review found

What is already right:

- Adventures are pure data; content definitions are separate from engine code; a capability check refuses content the engine cannot run.
- One `Combatant` shape serves heroes and monsters.
- Every action goes through one persisted resolution (`ResolutionState`: checks, effect rolls, application, concentration saves). Dice are saved before the engine sees them.
- Target lists come from one shared function (`legal-targets.ts`), used by the menu and the engine.

What is weak (status after steps 1 to 6: every row below is addressed except that the Discord side of reactions and effect triggers is not built; see Progress):

| Finding | Evidence | Consequence |
| --- | --- | --- |
| No real system boundaries | One `CampaignState`, one `CampaignCommand` union, one `Decision` that every module writes through. Modules reach into each other. | Nothing stops combat code from editing inventory, or the reverse. |
| Combat is a catch-all | `combat-flow.ts` is 799 lines: initiative, turn flow, moving, opportunity attacks, death saves, spells, features, gear, timers, autopilot. `resolution.ts` is 541 lines and holds damage, healing, concentration and attack modes. | Hard to change one thing without reading all of it. |
| Magic is not a system | Spell casting lives in `combat-flow.castSpell` and `resolution`; slots live in `combatant-profile` and `rest`. | Nothing outside a fight can cast; spell rules have no owner. |
| Conditions are labels | `Combatant.conditions` is a list of IDs with no source, clock or stacking. The engine acts on only `prone` and a "crippling" list. Frightened, poisoned and incapacitated exist as names. | Duration and consequences are lost; each new condition means new scattered `if`s. |
| Two lifetimes for effects | `ActiveEffect` (bonus die, Guiding Bolt) has an expiry and a concentration link; conditions have neither. Expiry is coded per effect in `expireEffects`. | Bless, poison and Hold Person would each need their own code. |
| Legality is written twice | Target lists are shared, but the action, bonus action and movement checks are in `application/.../turn-view.ts` (menu) and in `combat-flow.ts` (engine). | The menu and the engine agree because tests pin them, not because they share code. |
| Some derived values are stored | `armorClass`, `attacks`, `saves` are saved on `Combatant`. | They can go stale when gear or effects change. |
| No reaction window | A resolution goes from checks straight to effects. | Shield and the reaction scenarios (8, 39) cannot be built. |
| Events have no version | `EventEnvelope` records `rulesRevision` only. | A changed event shape cannot be told apart from an old one. |

## 3. Systems and boundaries

Each system owns four things: **state** (its slice), **events** (it alone emits them), **queries** (pure reads other systems may call) and **commands** (how the outside asks it to act). Systems talk only through queries and events.

Dependencies point downward only. A system may use anything below it and nothing above or beside it, except through a published query.

```
Table            members, presence, proxies, pause, reminders, DM hooks (story text in, never rules)
Exploration      rounds, skill checks, clocks, scenes, clues, story effects
Combat           encounter, initiative, turns, movement, reactions, action resolution, monster and autopilot tactics
Magic            spell slots, spells known, casting legality, concentration
Inventory        holdings, gear worn, stash, offers, gold, potions
Effects          conditions and lasting effects with source, clock, triggers, stacking
Character        sheet, build, derived stats, rest and resources
Content          definitions (items, spells, features, monsters, conditions), capabilities, house rules, SRD 5.1 data
Core             ids, dice, random source, roll results
```

Where today's code goes:

| System | Today's files |
| --- | --- |
| Core | `core/*`, `dice/*` |
| Content | `rules/*`, `content/srd-5.1/*`, `adventure/adventure-bible.ts` (data only) |
| Character | `character/*`, `engine/rest.ts`, derivation half of `combat/combatant-profile.ts` |
| Inventory | `engine/inventory.ts`, `engine/potions.ts` (in-fight item use, `engine/combat/combat-gear.ts`, stays with Combat) |
| Effects | `ActiveEffect` and `conditions` in `combat-state.ts`, `evolve-combat.ts`, `expireEffects` and `applyEffect` |
| Magic | `castSpell` in `combat-flow.ts`, concentration in `resolution.ts`, slots in `combatant-profile.ts` |
| Combat | `combat/*` (state, positioning, tactics, legal targets), `engine/combat/combat-flow.ts`, `resolution.ts`, `combat-retry.ts` |
| Exploration | `engine/rounds.ts`, `checks.ts`, `round-plan.ts`, `ledger/*` |
| Table | `lobby/*`, `engine/members.ts`, `pause.ts`, `reminders.ts`, `speech.ts`, `dm.ts` |

**Rule enforced by tooling:** an import-boundary lint (for example `eslint-plugin-boundaries` or `dependency-cruiser`) fails the build when a system imports upward or sideways. Without it the boundaries erode.

## 4. Rule queries: one place for "may I, how much, against what"

Menus and the engine both ask the same pure functions. Nothing calls a stat field directly for a rule.

| Query | Answers |
| --- | --- |
| `canAct(c)`, `canReact(c)` | Blocked by incapacitated, unconscious, etc. |
| `speed(c)` | Base speed after effects (restrained gives 0, difficult terrain halves) |
| `armorClass(c)` | Base, worn armor and shield, Shield spell, effects |
| `attackMode(attacker, target, kind)` | Advantage, disadvantage or normal, with the reasons |
| `saveMode(c, ability)` and `checkMode(c, skill)` | The same for saves and checks |
| `attackBonus(c, option)` and `saveDc(c)` | Modifiers from ability, proficiency, effects |
| `turnOptions(encounter, c)` | **Everything the actor may do now**: attacks with legal targets, spells with slots and targets, features, items, moves, plus the reason each unavailable choice is unavailable |

`turnOptions` is the important one. The Discord menu renders it, and the engine validates every command against it: a command is legal exactly when it is in the options. The two can then never disagree, and the menu can say why something is greyed out.

**Derived values are computed on demand**, not stored. Only real state is saved: hit points, resources left, position, effects, the turn budget. With at most about ten combatants and ten effects each, computing costs nothing.

## 5. Effects model

A condition or lasting effect is one record on the combatant (or, for an outlasting curse, on hero status):

```
EffectInstance {
  id
  definition          -> content ID (condition:poisoned, spell:bless, ...)
  sourceId            who caused it
  targetId            whom it affects
  modifiers           what it does, from a fixed vocabulary (see below)
  clock               { follows: "source" | "target", boundary: "start" | "end", untilRound, untilTurn } | null
  triggers            [{ at: "start" | "end", follows, do: damage | saveToEnd | expire }]
  dependsOn           concentration ID | another effect | null
  stacking            "replace" | "extend" | "coexist" | "ignore"
}
```

- **Modifiers use a fixed vocabulary**, for example: `blocksActions`, `blocksReactions`, `speedSet`, `speedMultiplier`, `attackMode(against|by, melee|ranged, advantage|disadvantage)`, `saveMode`, `acBonus`, `bonusDie`. The queries in section 4 fold over them, so no query mentions a condition by name.
- **Implied conditions** expand through the `includes` field content already has (unconscious includes incapacitated and prone).
- **A global clock.** Expiry is compared to the encounter's `round` and `turnNumber` (absolute, not decremented each turn), so it survives a pause and is cheap.
- **Timing patterns** the SRD needs, all expressible as clock plus triggers: end of the caster's next turn (Guiding Bolt), start of the target's turn (poison damage), end of each of the target's turns with a save (Hold Person), concentration (Bless), start of its own next turn (Dodge).
- **Turn boundary phases.** At the start of a turn the engine collects triggers due for the creature whose turn it is, runs them in the order the effects were applied (dice go through saved rolls, like an attack's damage), then fills the turn budget from the computed values. At the end it runs end-of-turn triggers and expiries. After each trigger the queries are re-read, because damage can down a hero or a save can remove the thing blocking them.
- **When concentration ends,** every effect that depends on it is removed together.
- **A truly new behavior** (something the vocabulary cannot say) is a named engine capability, implemented and tested, and content refers to it. We do not use scripting, because content must remain checkable before it becomes playable.

The turn budget (action, bonus action, reaction, movement) stays a per-turn resource. Effects do not overwrite it. `canAct` and `speed` decide what may be spent, at the moment of the choice.

## 6. Action resolution

Keep the persisted, stepwise resolution the code already has, and add what it lacks.

- **One plan for every action.** A weapon attack, a spell, a feature, an item and a monster's breath weapon each produce a plan with cost, targeting, checks and effects. They share validation, resource accounting, dice handling and effect application (already true for most).
- **Stages, each saved:** declare, checks, **reaction window (new)**, effects, concentration saves, effect expiry and triggers. Restarting resumes at the saved stage without rerolling or respending.
- **Reaction window.** After the attack roll and before the outcome, each eligible creature (per `canReact`) may be offered its reaction (Shield now, later opportunity attack choices and spells such as Hellish Rebuke). The window closes when everyone answers, declines or the timer runs out (auto-decline). This is what makes scenarios 8 and 39 possible.
- **Flow to prove first:** attack, then reaction (Shield), then damage, then concentration save, then effect expiry, all with a restart in the middle of each step.

Decision to make (see below): whether combat action dice should resolve in one step instead of through pending rolls and a worker. One step would remove most of the stage machinery; the staged dice reveal and the reaction window are the reasons it exists today.

## 7. Persistence and recovery

- **The saved state is the source of truth,** written with a revision check after every command. Events are the history and feed the journal, recaps and picture prompts. Production never replays the whole log.
- **Recovery is per command, not per turn.** Restoring to the start of the turn and letting the player redo it would be an undo button: a bad roll could be dodged by a restart. It would also leave Discord messages that contradict the new outcome. Dice are saved when rolled for this reason. The existing `fightCheckpoint` stays for the organizer's "Retry the fight".
- **Add an event schema version** to `EventEnvelope`, and a state migration step when a system's state shape changes (the effects change alters state). Old events remain readable history and are upcast on read if ever needed.
- **Event kinds for effects:** `effectApplied`, `effectRemoved`, `effectExpired`, `effectTriggered`. Computed values need no events.

## 8. Content versus engine

Two levels of extension:

1. **New content, existing mechanics** (another weapon, a monster with a supported attack and a poison effect): add a validated definition. No engine change. The LLM may draft these; the validator checks every capability exists before the content becomes playable (already how adventures are checked).
2. **A new mechanic:** implement it in the owning system, test it, add the capability, then content may reference it.

Adventures reference content by ID only and never contain rules.

A second ruleset (not 5e) is out of scope. We build SRD 5.1 well first and extract shared pieces when a second system gives concrete requirements.

## 9. The Discord UX contract

- The UX reads **views** built from engine queries (`turnOptions`, character and encounter summaries) and sends **commands**. It never computes a rule, checks legality itself or edits state.
- Buttons carry no authority; every command is checked against saved state (already true).
- Text catalogs and cards are the UX's own. Adding a spell or monster needs a glossary name, not new UX.
- Anything the UX needs to know about "why not" comes from the query's reason, not from a second copy of the rule.

## 10. Migration plan

Each step keeps the existing tests green, adds cases from the audit's missing list, and is releasable on its own. Nothing goes to the table between steps unless the owner says so.

1. **Fence and freeze.** Add the import-boundary lint (warning first), and a golden test that plays a fixed multi-round fight and records events and final state, so refactors can be checked for identical behavior.
2. **`turnOptions` and the shared queries.** Move the menu's legality into the domain, and have the engine validate against it. Menu and engine share one function. Add `canAct`, `speed`, `attackMode` and `armorClass` as queries over current data first.
3. **Effects as instances.** Add `EffectInstance`, the clock and triggers, and the turn-boundary phases. Move prone, the crippling check, Bless and Guiding Bolt onto it. Give restrained, poisoned, frightened and incapacitated their real consequences. State migration for existing campaigns; event schema version added.
4. **Reaction stage and Shield.** Add the reaction window to resolution and build Shield. Run the flow in section 6 with restarts.
5. **Extract Magic.** Move casting, slots and concentration out of combat into their own system; allow casting outside a fight where the rules allow.
6. **Split Combat and Inventory.** Separate turn flow, movement, resolution and tactics; move `combat-gear.ts` into Inventory. Turn the boundary lint to an error.
7. **Only then** the rules-depth track (leveling, terrain, shops, more conditions and monsters), which now means adding content and small capabilities.

The Discord work already done is not touched, apart from the menu reading `turnOptions` in step 2.

## Decisions

Settled by the owner:

1. **Staged dice stay,** with a reaction stage added (section 6).
2. **Event versioning now:** `EventEnvelope` gets a schema version (migration step 3).
3. **No live campaigns exist,** so no state migration is needed until the whole engine work is done. The state shape may change freely; existing tests and the golden fights are the safety net.
4. **The boundary check is a ratchet, not an error, until step 6:** violations that exist are listed in `tests/architecture/boundary-baseline.json` and may only shrink; new ones fail the test.
5. **Conditions with real consequences, in order:** incapacitated, prone, frightened, poisoned, unconscious, then grappled, restrained and blinded.

## Progress

| Step | State |
| --- | --- |
| 1. Fence and freeze | Done. `tests/architecture/` holds the system map and the boundary ratchet (11 violations and 54 shared-path imports recorded). `tests/domain/campaign/golden-fights.test.ts` records five fights (three autopilot seeds, a scripted victory, a scripted Bless with broken concentration) under `tests/domain/campaign/golden/`. |
| 2. Shared turn rules | Done. `combat/turn-rules.ts` holds one problem function per choice (attack, spell, feature, move, engage, withdraw, potion, shield, and the action cost), the query wrappers `canAct`, `canReact`, `speedOf` and `armorClassOf`, and `turnOptions`. The engine refuses a command with the same problem the menu greys a choice out with, and the Discord turn view is built from `turnOptions`. `tests/domain/campaign/turn-options.test.ts` tries every possible command in seven situations and requires the engine to accept exactly those the options list (a deliberate break of `canWithdraw` fails it). The combat rejection codes now belong to Combat (`TurnProblem`). `combat-gear.ts` is counted as Combat, since it handles in-fight items; the boundary baseline went from 11 to 9 violations. Not moved yet: `attackMode` (in `resolution.ts`), which moves with the effects work. |
| 3. Effects as instances | Done. Conditions and lasting effects are one `EffectInstance` (source, conditions it stands for, modifiers, clock, triggers, concentration, stacking) on the combatant; `Combatant.conditions` and `ActiveEffect` are gone. Conditions are content that lists modifiers from a fixed vocabulary (`rules/modifiers.ts`); the queries in `effects/effect-queries.ts` (`canAct`, `canReact`, `speedOf`, `attackBias`, `saveBias`, `autoFailsSave`, `hitsAreCritical`, `bonusDiceFor`, `effectsDueAt`, `triggersDueAt`) are the only readers. Bless, Guiding Bolt, prone, poisoned and frightened moved onto it, and the five golden fights are unchanged apart from event names (`conditionAdded` and `effectAdded` became `effectApplied`; event schema version 2, stamped on every envelope since step 3a). Real consequences now exist for incapacitated (loses its turn), prone, frightened, poisoned, unconscious (advantage against it, auto-failed Strength and Dexterity saves, close hits critical), and the new grappled, restrained and blinded. Turn-boundary phases run effects' clocks and triggers (damage, saving throw to end); each trigger's dice are a saved roll and the turn resumes when the last is done. No shipped content uses triggers yet, so they are covered by synthetic-effect tests. Known gaps: trigger results are not yet in the Narrator's beats or the Discord lines; the shared-path import ceiling went from 54 to 56 for `effect-triggers.ts`, which follows its siblings' pattern and goes in step 6. |
| 4. Reaction stage and Shield | Done in the engine. When an attack roll hits a hero whose player is at the table and who could cast a reaction spell that turns the hit into a miss, the hit waits: the roll is kept in `ResolutionState.reaction`, a timer (the turn length) is started, and the target answers with `combatReact` (cast or decline) or the timer or an away player declines. The hit is then settled again against the armor class the answer produced (`armorClassOf` adds `acBonus` effects); Shield is +5 until the start of the caster's next turn, spends the reaction and a slot, and shows as a template line. A natural 20, a hit no reaction could stop, an away player, a spent reaction and no prepared reaction spell all skip the window. The window survives a save and reload, holds while play is paused and gets a fresh timer on continue. Content: `spell:shield` (level 1, reaction, `reaction: acBonusUntilNextTurn`) and a `reactions` capability. Not done: the Discord side. Nothing prompts the player yet (no button, no ping), so until it does the timer declines and no starter hero has the spell. Also not done: Magic Missile's negation and other reaction kinds (opportunity attack choices, Hellish Rebuke). The shared-path import ceiling is 58 (`effect-triggers.ts`, `reactions.ts`). |
| 5. Magic | Done for what exists. `magic/spell-rules.ts` holds the spell rules that need no fight: slots (`slotUnavailable`, `castableSlotLevels`, `lowestSlot`), `spellMaxTargets`, `spellTargetProblem` (relation and reach, from plain facts so it needs no combat types), and `concentrationDc`. Combat's turn rules, target lists, reactions and resolution call it. Behavior is unchanged (all fights and golden files identical). Not done: casting outside a fight (healing between fights), which needs its own saved-roll flow; concentration's bookkeeping (`endConcentration`, the save request) still lives in `resolution.ts` because it acts on the encounter, and moves with the step 6 split. |
| 6. Split and enforce | Done. (a) Every upward or sideways import between systems is gone and the boundary test now fails on any new one (no baseline list): hero status and the worn-gear rule moved down to Character and Inventory, acting for an owner moved to Character, `reminders.ts` counts as kernel plumbing, and Inventory and round-plan take Combat's rules as parameters (`InventoryHooks`, `EncounterCheck`) that `decide.ts` supplies, instead of importing them. The closing combat narration opens the next round from `decide.ts`. (b) `combat-flow.ts` (828 lines) is now the command dispatch and shared checks (227 lines), with `encounter-start`, `turn-flow`, `movement`, `combat-actions` and `death-saves` beside it; `resolution.ts` (598) keeps declaring and settling an action, with `damage` (hit points and concentration) and `attack-rules` split out. Behavior is unchanged: the golden fights and all tests are identical. (c) The shared write path (state, events, commands, `Decision`, `Rejection`) stays as the one deliberate shared vocabulary; what is counted is which of its modules each system depends on (29 pairs), and that ceiling may only go down. In-fight item handling (`combat-gear.ts`) stays with Combat, and Inventory reaches it only through the hooks. |
| 7. Rules depth | In progress. (a) The builder catalog is the full SRD 5.1 roster (fighter, rogue, cleric, barbarian, bard, druid, monk, paladin, ranger, sorcerer, warlock, wizard), level 1 only: same `ClassTemplate` shape the original three used, six new items, six new spells, and eleven new features. Lay on Hands is mechanical (Second Wind's self-heal shape); the rest are narrative-only, same treatment as Thieves' Cant, so no new engine mechanic was needed per feature. Barbarian and Monk get an armor kit rather than Unarmored Defense (a per-class base-AC formula, not built). A few spells are simplified where the SRD mechanic needs an effect kind the engine doesn't have (Magic Missile hits one target, Eldritch Blast is one bolt, Vicious Mockery drops its secondary effect, Witch Bolt doesn't re-trigger). (b) `character/leveling.ts` adds XP and levels on top, as pure numbers rather than new content: the SRD 1-20 XP table, proficiency bonus, HP gain (the same fixed-average rule as Second Wind and potions), spell slots (full/half/Pact Magic tables through level 20), and an Ability Score Improvement at 4/8/12/16/19 (put on the class's leading abilities, since there is no player-facing choice for it yet). A victory's XP splits evenly among the party still standing (`experienceAwarded`) and levels a hero up automatically when it crosses a threshold (`characterLeveledUp`, one event per level). Monsters carry an `xp` field now. (c) Leveling grants narrative-only features at levels 2 and 3 (a `levelFeatures` table per class, same narrative treatment as the roster), and Paladin/Ranger are seeded a starting spell list the moment they first gain slots at level 2 (their level-1 template has none to carry over). (d) Extra Attack (level 5, Fighter/Barbarian/Paladin/Ranger/Monk) is the first mechanical level 2+ feature: `TurnBudget.attacksLeft` (1, or 2 with the new `extraAttack` trait) is what the Attack action spends now, one per weapon attack, with the action itself spent only on the last; `attackProblem` checks it instead of the action budget directly, so the menu and the engine still can't disagree. (e) Sneak Attack's die count now scales with the rogue's level (the `sneakAttack` trait is a marker; `sneakDice` computes 1d6 at level 1, +1d6 every two levels, from the attacker's own level, instead of a value fixed on the level-1 feature). (f) Cunning Action (level 2, Rogue) makes Dash or Disengage free as a bonus action when one is available (never Dodge, matching the SRD); `turnOptions` gained `canDashOrDisengage`, separate from Dodge's `canTakeAction`, so the menu can't disagree with the engine here either. (g) Divine Smite (level 2, Paladin): `combatAttack` takes an optional `smiteSlot`; `smiteProblem` checks the new `divineSmite` trait, that the weapon is melee, and that the slot exists; `planFor` adds the bonus radiant damage (2d8 plus 1d8 per slot level above 1st, capped at 5d8) to the weapon attack's plan. Simplified and documented: the slot is spent when the attack is declared, not only once the hit is confirmed — the SRD lets a paladin decide after seeing the roll, sparing the slot on a miss; doing that properly needs a pause-and-decide stage like the reaction window Shield uses, sized for its own step. (h) The `extraAttack` trait now carries a count (2 for the shared level-5 feature; a Fighter's own `feature:extra-attack-2`/`-3` at 11 and 20 raise it to 3 and 4, the highest of any granted trait winning). Not done: terrain, shops, reaction kinds beyond Shield, casting outside a fight, the rest of the mechanical level 2+ features (Wild Shape, Uncanny Dodge, subclass choices) and levels this doesn't reach, and the Discord side of any of this (reactions, effect triggers, leveling, the ASI choice, a smite prompt). |
| 8. Content catalog | In progress. Grows the SRD 5.1 content — conditions, spells, monsters — that engine steps 3-7 already have the machinery for, so each addition is pure data plus a glossary entry, no new `Modifier`/`Effect`/`Trait` kind. (a) Conditions: Paralyzed, Stunned, Invisible, each built entirely from the existing modifier vocabulary (`speedZero`, `attacksAgainst`, `autoFailSaves`, `critsAgainst`, `ownAttacks`) — Charmed, Deafened, Exhaustion, and Petrified stay out of scope, since each needs a vocabulary the engine doesn't have yet (targeting a specific creature, hearing-based checks, a multi-level stacking condition, and damage resistance/immunity, respectively). (b) Cantrips: Ray of Frost, Chill Touch, same attack-roll-damage shape as Fire Bolt/Eldritch Blast (each drops a non-damage rider the engine can't express, documented per spell). Level 1: Command, simplified to only its "Halt" effect (one round of Incapacitated on a failed Wisdom save); the other three one-word effects (Flee, Grovel, Approach) are dropped. (c) Monsters: kobold, giant rat, zombie, orc, skeleton, reusing existing weapons plus one new natural weapon (`item:slam`, for the zombie); each documents the SRD traits it doesn't model yet (Undead Fortitude, Aggressive, bludgeoning vulnerability, poison immunity). Not done at the time: damage resistance/immunity, Charmed, area-of-effect spells, half-damage-on-save spells, and the deeper SRD monster/spell lists past this batch. |
| 9. Basic-status engine support | Done. Two closed vocabulary additions the step 8 gap analysis called out as real engine work, not missing data. (a) Damage resistance/immunity/vulnerability: three `Trait` kinds (`damageResistance`/`damageImmunity`/`damageVulnerability`, each a `DamageType` list) and a pure `damageMultiplier()` (rules/traits.ts), read by `applyDamage` (now takes an optional `DamageType`) at both its call sites — a resolved `damage` effect and a lasting-effect trigger (poison, burning). Resistance halves and floors; immunity zeroes; vulnerability doubles; resistance and vulnerability to the same type cancel out per the SRD, and immunity wins over either. Skeleton and Zombie now carry the traits their SRD stat blocks call for instead of a "not modeled" comment. (b) Charmed: a new `Modifier` kind, `cannotTargetSource`. Unlike every other modifier, "the holder is Charmed" says nothing about who by — that only means something read against the one effect that granted it — so `effect-queries.ts`'s new `forbiddenAttackTargets()` reads it directly off `holder.effects` (whose `sourceId` is the charmer) rather than through `modifiersOf()`'s flattened, source-blind list, and both places document why. `legal-targets.ts`'s `weaponTargetProblem`/`spellTargetProblem` now take `content` and consult it, so a charmed hero's `turnOptions` and the engine still agree on which target is off the table. Simplified: only the "can't attack/target the charmer" half of Charmed is modeled (the charmer's advantage on social checks is narrative, and a beneficial spell at the charmer is blocked the same as a harmful one, since the engine has no notion of a spell's targeting being harmful). Not done: Exhaustion (a multi-level stacking condition; the effect/condition system here is single-instance per source), condition immunity (Skeleton/Zombie's poisoned/exhaustion immunities), and area-of-effect or half-damage-on-save spells. |
| 10. Review pass: seven bugs fixed | Done. A model-driven review of the combat engine and content registry (not this doc's own author) found seven real bugs, all fixed the same session, each with a regression test that fails on the old behavior. Combat/turn-flow: (a) a turn timer firing mid-resolution (an attack, reaction, or opening move's opportunity attacks) returned an accepted no-op and dropped the timeout outright, since the worker that delivered it had already consumed it — `turnTimerExpired` now re-arms a fresh timer a few seconds out instead of giving up, so an unattended turn stuck mid-resolution can't stall combat forever. (b) Extra Attack let the action be spent twice: it stayed marked available until the *last* swing, so a hero could attack once and then also Dodge on the same turn — `declareWeaponAttack` now spends the action on the first swing like any other action, and `turnOptions` gates the remaining swings on `attacksLeft` (unchanged) rather than the action budget, so the menu and the engine stay in agreement. (c) Automated movement (`continuePlan`, used for monster turns and the away policy) checked raw movement points, bypassing `speedOf()`'s handling of speedZero conditions (grappled, restrained, paralyzed, stunned) — it now calls the same `moveProblem`/`engageProblem` a player's own commands are checked against. Registry/gear: (d) a spare shield or armor doubled its AC bonus, since `heroTraits` checked `isWorn` per inventory entry rather than per distinct item ID — now deduplicated first. (e) `ArmorDefinition`'s `stealthDisadvantage` and `strengthRequirement` were declared and set on content but had no reader anywhere; both are now enforced (`engine/gear.ts`'s `armorSpeedPenalty`/`hasStealthDisadvantage`), the first wired into `heroCombatant`'s speed, the second forced into a Stealth check's roll mode in `round-plan.ts` independent of whether the Planner notices to cite it. (f) Registry validation confirmed a monster attack's weapon reference resolved to *an item*, not specifically a weapon — a monster naming a shield in an attack passed validation and silently lost that attack. (g) A spell's level had no bounds check, so an out-of-range level (e.g. 10) made `castableSlotLevels` sample zero plans, meaning a broken `plan()` at that level was never even called during validation; `checkDefinition` now rejects out-of-range levels directly. |
| 11. Condition immunity | Done. Closes the gap step 9 left: Zombie/Skeleton were immune to poison *damage* but not the poisoned condition itself. A new `conditionImmunity` trait (a `ContentId<"condition">` list) and pure `isImmuneToCondition()` (rules/traits.ts, same shape as `damageMultiplier`), read by `resolution.ts`'s `applyEffect` at both places a condition gets applied (`applyCondition` and `conditionUnlessSave`'s save-rider) — an immune creature never receives the effect, and its save roll is skipped entirely in `proceedToEffects` the same way an auto-failing save already is. Zombie and Skeleton now carry it for `condition:poisoned`. |
| 12. Exhaustion | Done. The one condition flagged as needing a genuinely different shape: a 6-level stacking meter (unlike every other condition here, which is on or off) with different effects per level. A new Effect kind (`exhaustion`, signed amount) and a dedicated `Combatant.exhaustion` field (0-6) rather than a condition with modifiers, since a condition's modifiers are fixed but this changes with level. Carried on `HeroStatus` between fights the way HP and resources already are (seeded at encounter start, written back at encounter end). `effect-queries.ts` synthesizes level 3+ (attack/save disadvantage) and level 5+ (speed 0) into the existing modifier vocabulary the way a Dodge stance already does; `speedOf` separately halves speed at level 2+, which `speedZero` can't express. `round-plan.ts` forces disadvantage on every ability check at level 1+, mechanical and independent of the Planner citing it. Level 6 kills; a long rest removes one level. Not done: any in-combat source that actually inflicts it — no SRD spell or monster in the catalog causes Exhaustion, and the engine has no travel/environment system (its usual real-world source) — this step is infrastructure a future one can hang content off of. |
| 13. Uncanny Dodge and Wild Shape | Done. The last two mechanical level 2+ features named repeatedly as out of scope. (a) Uncanny Dodge (Rogue 5): a new `uncannyDodge` trait, applied automatically — unlike Shield, it has no cost or downside to weigh, so there's no real choice to offer as a reaction prompt, only whether it's available. `resolution.ts`'s `applyEffect` halves a landing `damage` effect when the recipient has the trait, the reaction is free, and the plan's check is an attack roll (not a saving throw); a new `uncannyDodgeUsed` event spends the reaction. Rogue's level 5 slot in `leveling.ts` had no entry at all before this. (b) Wild Shape (Druid 2): the biggest lift, since it swaps a hero's whole stat block for a beast's rather than reading a passive trait, so it is its own engine file (`engine/combat/wild-shape.ts`) rather than the Trait system. `Combatant` gained `wildShapeOriginal` (a new `WildShapeForm` type: attacks/armorClass/speed/traits/maxHp/hp), stashed on transforming and restored on reverting. A new command (`combatWildShape`, a monster ID present to transform, absent to revert) and event (`wildShapeChanged`) carry the already-resolved numbers — the same pattern `gearChanged` already used, keeping `evolve` pure while content lookups happen on the decide side. `turn-rules.ts`'s new `wildShapeProblem` is the one place legality is decided; `turnOptions` gained `wildShapeForms`/`canRevertShape` from it, and `spellProblem`/the spell list both refuse casting while shaped. Simplified, documented in `wild-shape.ts`'s own header: only the Wolf is ever offered (monsters carry no challenge rating yet to check a Druid's level against a wider cap); no per-rest use limit; other class features are left untouched rather than reconciled against the new form; and damage that would take the beast form below 0 HP simply reverts at 0 rather than the SRD's carry-the-excess-over rule (the same liberty "protected while away" already takes for a downed hero). |
