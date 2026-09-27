# D&D engine audit

Reviewed 2026-09-27. Scope: domain rules, content registration, character derivation, combat resolution, positioning, and the exploration command boundary. This is a foundation audit, not certification of every SRD rule. Other work was changing the workspace during the review; those edits were preserved.

## Assessment

Keep the current deterministic decide/evolve architecture, saved roll identities, command transactions, and shared resolution plans. The engine is a reusable starter subset, but it cannot yet guarantee that registered content's declared behavior is executed correctly. Adding an adventure using existing validated content is feasible; supporting an arbitrary 2014 5e adventure requires more mechanics and more precise validation.

## Confirmed findings

### 1. High: condition labels do not consistently enforce their rules

`combat/combat-state.ts` defines `isActive` using the separate life-state field alone. `engine/combat/combat-flow.ts` uses that helper to authorize actions. Adding `condition:incapacitated` through a normal `conditionAdded` event does not prevent Dodge: a focused test reproduced acceptance.

`ConditionDefinition.includes` is validated as references but is not expanded by runtime condition checks. Consequently applying the Unconscious content entry is not equivalent to the engine's separate downed state. Concentration removal is implemented for HP reaching zero, but not for becoming incapacitated through a condition.

Fix: a shared condition evaluation layer used by action eligibility, reactions, movement, attacks, saves, concentration, and menus. Keep life state and applied conditions coherent. Verify incapacitation, implied conditions, and concentration termination through the same effect application path.

References: [condition helpers](../src/domain/campaign/combat/combat-state.ts), [condition application](../src/domain/campaign/engine/combat/resolution.ts), [2014 conditions](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/appendix-a-conditions), [concentration](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/spellcasting).

### 2. High: effect duration is accepted and then discarded for conditions

The `applyCondition` effect declares a duration, but `applyEffect` emits only the condition ID. `conditionAdded` stores a deduplicated ID list with no source, duration, or concentration link. Ending concentration removes bonus-die effects only. A new timed or concentration-dependent condition spell can register successfully yet cannot expire correctly. Encounter construction also starts with empty conditions/effects/concentration, so lasting effects have no general continuity across encounters.

Fix: saved effect instances with source, target, stacking policy, expiration boundary, and optional concentration link. Expire/remove each instance independently and retain applicable effects outside combat. Make unsupported duration combinations fail validation until implemented.

References: [effect contract](../src/domain/campaign/rules/effects.ts), [effect resolution](../src/domain/campaign/engine/combat/resolution.ts), [combat state updates](../src/domain/campaign/combat/evolve-combat.ts), [encounter construction](../src/domain/campaign/combat/combatant-profile.ts).

### 3. High: bonus-action spell restrictions are missing

`castSpell` checks slots and action/bonus-action availability independently. A focused test cast Healing Word followed by Bless on the same turn; both were accepted. The 2014 baseline restricts another spell that turn to a cantrip with a casting time of one action after a bonus-action spell.

Fix: track spells cast this turn and validate the restriction in both orders, shared by menus and resolution. Test Healing Word plus Bless in either order, and the legal Healing Word plus Sacred Flame combination.

References: [castSpell](../src/domain/campaign/engine/combat/combat-flow.ts), [2014 bonus-action casting](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/spellcasting).

### 4. High for content expansion: capability validation admits unusable definitions

`CastingTime` includes reaction, but the capability set has no reaction-casting capability and `requiredCapabilities` does not check casting time. A focused test changed a valid spell definition to reaction casting; registry construction still succeeded. `castSpell` then rejects reaction spells as unknown. Broad labels such as `conditions` similarly cannot distinguish supported durations and condition behavior.

Fix: derive precise requirements from definitions, including trigger timing, duration behavior, targeting shape, and damage treatment. Validate parameter bounds and supported combinations. The importer and startup registry should use the same supported-mechanics report. Content that requires an absent mechanic must be rejected with a specific explanation.

References: [capability set](../src/domain/campaign/rules/capabilities.ts), [requirement inference](../src/domain/campaign/rules/content-definitions.ts), [registry](../src/domain/campaign/rules/content-registry.ts).

### 5. Medium: heavy armor applies a negative Dexterity modifier

`armorClassFrom` uses `Math.min(dexterityModifier, 0)` for heavy armor. A focused test using base AC 16 and Dexterity modifier -1 returned 15. Heavy armor should ignore Dexterity. This is reachable through the customizable builder.

Fix: represent the armor Dexterity contribution explicitly, rather than treating heavy armor as a capped bonus. In the same subsystem, audit currently unenforced armor strength/stealth fields and the assumption that every carried weapon is proficient; those assumptions prevent accurate arbitrary builds.

References: [armor and weapon derivation](../src/domain/campaign/combat/combatant-profile.ts), [2014 equipment](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/equipment).

## Limits that need design work, rather than more adventure text

| Area | Current foundation | Needed for broader adventures |
| --- | --- | --- |
| Damage | Typed damage in definitions, direct HP reduction in resolution | Resistance, immunity, vulnerability, temporary HP, and shared damage rolls with per-target adjustments. `onAvoid` currently rolls a separate expression; it cannot express half of the same saved damage roll. Critical dice are selected with an action-wide `anyCritical`, which also needs per-target handling before multi-target attack spells are supported. |
| Actions and reactions | Weapon attacks, targeted spells, self-only feature actions, automatic opportunity attacks | Persisted trigger windows; monster save-based abilities, recharge, multiattack, and targeted features using the shared resolution system. |
| Positioning | Zone graph, walking distances, hostile engagement | Visibility and cover separate from walking distance; area shapes, flight, terrain, forced movement, and explicit range/reach capabilities. |
| Characters | Three class templates; builder derives level 1 | Validated level progression, proficiency/equipment rules, prepared choices, and class progression data. The registry has class/action ID kinds but no corresponding class/action definition in its content union. |
| Exploration | Ability checks plus a small union of story effects | Typed spell/feature use outside combat, resource costs, hazards with saves/damage, authored fixed DCs, and dependent actions. Combat-only casting cannot faithfully resolve an exploration request to spend a spell slot. |
| Imported content | Uploaded adventures reference the shipped catalog; spell/feature definitions contain TypeScript `plan()` functions | A constrained serializable definition format compiled into supported plans. Imported files/LLM output must never supply executable functions. |

These are scope limits, not a demand to implement every 5e rule before play. An adventure's requirements should determine which extensions come next, and its compatibility report should make exclusions visible.

## Recommended work order

1. Correct the reproduced rule violations and replace broad capability claims with explicit supported behavior. Add permanent regression tests as part of those fixes.
2. Build one effect lifecycle covering conditions, duration, concentration, and transitions between combat and exploration. Gate unsupported effects in the meantime.
3. Extend shared actions with interrupt/reaction checkpoints, damage modifiers, and per-target outcomes. Test with small authored examples before adding many spells or monsters.
4. Add validated progression through levels 1–3 and the positioning mechanics required by the chosen first full adventure.
5. Define serializable content packs and an adventure requirements manifest. Prove that a new supported creature/spell/hazard can be added through data and localization alone, while unsupported content fails with a precise report.

Avoid a wholesale engine rewrite. Refactor the narrow contracts above while retaining replayable events and authoritative state. Keep SRD 5.1 (2014) behavior and explicit house-rule deviations distinguishable.

## Verification

Ran `npm test -- tests/domain/campaign` with four temporary audit probes. Existing tests: **224 passed**. The four probes all failed their expected-correctness assertions, reproducing findings 1, 3, 4, and 5. The temporary test file was removed after recording results; no production implementation was changed by this audit. Finding 2 and the expansion limits are based on inspected code paths. No live Discord/model or database validation was performed for this engine-only review.
