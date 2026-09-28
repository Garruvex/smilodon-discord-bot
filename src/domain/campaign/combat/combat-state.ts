import type { EncounterSpec } from "../commands/campaign-command.js";
import type { HeroResources } from "../character/hero-status.js";
import type { EffectInstance } from "../effects/effect-instance.js";
import type { CharacterId, Instant, RollId } from "../core/ids.js";
import type { D20TestRoll, D20TestSpec } from "../dice/d20-test.js";
import type { DiceExpression } from "../dice/dice-expression.js";
import type { RollSpec } from "../dice/roll-spec.js";
import type { MonsterTactic, WeaponRange } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { Ability, DamageType, Effect, ResolutionPlan } from "../rules/effects.js";
import type { Trait } from "../rules/traits.js";
import { mergeSlots, type SpellSlots } from "../magic/spell-rules.js";

export type CombatantId = string;
export type ZoneId = string;
export type Side = "party" | "foes";

// One weapon attack a combatant can make, already resolved to numbers.
// Heroes' options come from abilities, proficiency, weapons, and traits;
// monsters' from their stat block.
export interface AttackOption {
  readonly weapon: ContentId<"item">;
  readonly toHit: number;
  readonly damage: DiceExpression;
  readonly damageType: DamageType;
  readonly range: WeaponRange;
  // Finesse or ranged: eligible for Sneak Attack.
  readonly finesse: boolean;
  readonly onHit: readonly Effect[];
}

export type CombatantSource =
  | { readonly kind: "hero"; readonly characterId: CharacterId }
  | { readonly kind: "monster"; readonly monsterId: ContentId<"monster">; readonly npcId: string | null };

// active: can act. unconscious: at 0 HP, making death saves (heroes).
// stable: at 0 HP, no longer making death saves. dead / fled: out of the fight.
export type CombatantCondition = "active" | "unconscious" | "stable" | "dead" | "fled";

export interface CombatSpellcasting {
  readonly attackBonus: number;
  readonly saveDc: number;
  readonly modifier: number;
  readonly spells: readonly ContentId<"spell">[];
}

// A combatant's spell slots and feature uses left (a hero's own resources).
export type CombatResources = HeroResources;

// Every slot a combatant could cast with right now, ordinary and Pact Magic
// summed together (magic/spell-rules.ts's mergeSlots) — for asking "is a
// slot of this level available at all"; spendSlot below is the one place
// that cares which pool it actually comes from.
export function availableSlots(resources: CombatResources): SpellSlots {
  return mergeSlots(resources.spellSlots, resources.pactSlots ?? {});
}

// Spends one slot of the given level, off the ordinary pool first and only
// falling back to Pact Magic if that level isn't there — a fixed spending
// order, not a player choice, so casting a Warlock/multiclass hero's spell
// needs no new command surface (engine/combat/evolve-combat.ts's two
// spenders, magic/spell-rules.ts's mergeSlots for what's available to spend
// at all).
export function spendSlot(resources: CombatResources, slotLevel: number): CombatResources {
  if ((resources.spellSlots[slotLevel] ?? 0) > 0) {
    return { ...resources, spellSlots: { ...resources.spellSlots, [slotLevel]: (resources.spellSlots[slotLevel] ?? 0) - 1 } };
  }
  const pactSlots = resources.pactSlots ?? {};
  return { ...resources, pactSlots: { ...pactSlots, [slotLevel]: Math.max(0, (pactSlots[slotLevel] ?? 0) - 1) } };
}

export interface Concentration {
  readonly resolutionId: string;
  readonly spellId: ContentId<"spell">;
}

// The hero's own stat block, stashed while Wild Shape borrows a beast's
// (engine/combat/wild-shape.ts). Restored on reverting.
export interface WildShapeForm {
  readonly attacks: readonly AttackOption[];
  readonly armorClass: number;
  readonly speed: number;
  readonly traits: readonly Trait[];
  readonly maxHp: number;
  readonly hp: number;
}

// Every creature in a fight has this one shape (heroes and monsters share one
// system with different stats).
export interface Combatant {
  readonly id: CombatantId;
  readonly side: Side;
  readonly source: CombatantSource;
  // "A", "B" for repeated monster types; null for heroes and unique foes.
  readonly letter: string | null;
  readonly level: number;
  readonly armorClass: number;
  readonly maxHp: number;
  readonly hp: number;
  readonly speed: number;
  readonly initiativeModifier: number;
  readonly saves: Readonly<Record<Ability, number>>;
  readonly attacks: readonly AttackOption[];
  readonly spellcasting: CombatSpellcasting | null;
  readonly features: readonly ContentId<"feature">[];
  readonly resources: CombatResources;
  readonly traits: readonly Trait[];
  // How the engine plays this combatant when no player does.
  readonly tactic: MonsterTactic | null;
  // Flee at the start of its turn when HP falls below this share of max.
  readonly fleeBelowHpFraction: number | null;
  readonly zoneId: ZoneId;
  readonly initiative: number | null;
  readonly budget: TurnBudget;
  // Dodge: attacks against it have disadvantage until its next turn.
  readonly dodging: boolean;
  // Disengage: leaving engagement provokes no opportunity attacks this turn.
  readonly disengaged: boolean;
  readonly sneakAttackUsed: boolean;
  // 0-6, SRD 5.1 Exhaustion (its own tracked stat, not a Modifier-bearing
  // condition: unlike every other one, its effects stack and change per
  // level). effect-queries.ts's speedOf/modifiersOf read it directly.
  readonly exhaustion: number;
  // Non-null while Wild Shaped: the hero's own stat block, to restore on reverting.
  readonly wildShapeOriginal: WildShapeForm | null;
  readonly condition: CombatantCondition;
  // Conditions, spells that outlast their casting, and stances: one record each,
  // with its source, what it does, and when it ends (effects/effect-instance.ts).
  // Being downed is not stored here; the rule queries derive it from `condition`.
  readonly effects: readonly EffectInstance[];
  readonly concentration: Concentration | null;
  readonly deathSaves: { readonly successes: number; readonly failures: number };
}

export interface TurnBudget {
  readonly action: boolean;
  readonly bonusAction: boolean;
  readonly reaction: boolean;
  readonly movement: number;
  // Weapon attacks left in this turn's action: 1, or 2 with Extra Attack.
  // The action itself is spent only once this reaches 0.
  readonly attacksLeft: number;
}

export interface Zone {
  readonly id: ZoneId;
  readonly name: string;
}

export interface ZoneEdge {
  readonly from: ZoneId;
  readonly to: ZoneId;
  readonly feet: number;
}

// Where an action's rules come from.
export type ResolutionSource =
  // smiteSlot: Divine Smite's chosen slot level, when spent on this hit.
  | { readonly kind: "weapon"; readonly option: AttackOption; readonly smiteSlot?: number }
  | { readonly kind: "spell"; readonly spellId: ContentId<"spell">; readonly slotLevel: number }
  | { readonly kind: "feature"; readonly featureId: ContentId<"feature"> };

export interface TargetOutcome {
  readonly landed: boolean;
  readonly critical: boolean;
}

export interface PendingCheck {
  readonly targetId: CombatantId;
  readonly kind: "attack" | "save";
  readonly spec: D20TestSpec;
  // AC for attacks, DC for saves.
  readonly against: number;
}

export interface PendingEffectRoll {
  // "land:0", "avoid:1": which effect of the plan; riders: "rider:<target>:<index>".
  readonly effectKey: string;
  readonly targetId: CombatantId | null;
  readonly spec: RollSpec;
}

// Every action resolves through this one persisted sequence (panel spec:
// Attack sequence): checks, then effect rolls, then application, then any
// concentration saves. Each stage is saved, so a restart resumes where it
// stopped and never rerolls.
// An attack has hit and its target may answer with a reaction (Shield) before the
// hit is final. The dice are already rolled and saved here.
export interface PendingReaction {
  readonly rollId: RollId;
  readonly targetId: CombatantId;
  readonly roll: D20TestRoll;
  // The reaction spells the target can cast now, each at the lowest slot that fits.
  readonly options: readonly { readonly spellId: ContentId<"spell">; readonly slotLevel: number }[];
  // When the window closes (the target then declines); null when play has no timers.
  readonly closesAt: Instant | null;
}

export interface ResolutionState {
  readonly id: string;
  readonly actorId: CombatantId;
  readonly source: ResolutionSource;
  readonly targetIds: readonly CombatantId[];
  readonly plan: ResolutionPlan;
  // opportunity: a reaction during someone else's move.
  readonly purpose: "action" | "opportunity";
  readonly stage: "checks" | "effects" | "concentration";
  readonly checks: Readonly<Record<RollId, PendingCheck>>;
  readonly outcomes: Readonly<Record<CombatantId, TargetOutcome>>;
  readonly effectRolls: Readonly<Record<RollId, PendingEffectRoll>>;
  // Rolled totals by effect key; save riders store 1 (saved) or 0 (failed).
  readonly rolled: Readonly<Record<string, number>>;
  readonly sneakAttack: boolean;
  // Set while a hit waits for the target's answer; the resolution goes no further until then.
  readonly reaction?: PendingReaction | null;
}

// A move that provokes opportunity attacks waits for them, then happens if
// the mover can still move.
export interface PendingMove {
  readonly combatantId: CombatantId;
  readonly kind: "move" | "withdraw";
  readonly zoneId: ZoneId | null;
  readonly feet: number;
  readonly provokers: readonly CombatantId[];
  // The rest of an engine-played turn, resumed after the move.
  readonly thenPlan: TurnPlanRemainder | null;
  // Set while `provokers[0]` is a player-controlled hero deciding whether to
  // take the opportunity attack it could make (movement.ts); an engine-played
  // provoker never waits, so this is absent while one of those is up next.
  readonly offer?: { readonly closesAt: Instant | null } | null;
}

export interface TurnPlanRemainder {
  readonly moves: readonly ZoneId[];
  readonly engage: CombatantId | null;
  readonly attack: { readonly targetId: CombatantId; readonly option: AttackOption } | null;
}

export interface PendingTriggers {
  readonly creatureId: CombatantId;
  readonly boundary: "start" | "end";
  readonly done: readonly string[];
}

export type PendingCombatRoll =
  | { readonly purpose: "initiative"; readonly combatantId: CombatantId; readonly spec: D20TestSpec }
  | { readonly purpose: "check"; readonly resolutionId: string }
  | { readonly purpose: "effect"; readonly resolutionId: string }
  | { readonly purpose: "deathSave"; readonly combatantId: CombatantId; readonly spec: D20TestSpec }
  // A lasting effect's turn-boundary trigger: its damage dice, or its saving throw to end.
  | { readonly purpose: "trigger"; readonly holderId: CombatantId; readonly effectId: string; readonly index: number; readonly spec: RollSpec }
  | { readonly purpose: "concentration"; readonly combatantId: CombatantId; readonly spec: D20TestSpec; readonly dc: number };

export type EncounterOutcome = "victory" | "defeat";

export interface EncounterState {
  readonly id: string;
  // initiative: waiting for initiative rolls. active: taking turns.
  readonly status: "initiative" | "active" | "ended";
  readonly round: number;
  // Increments on every turn start; names turn timers so a stale one is ignored.
  readonly turnNumber: number;
  readonly order: readonly CombatantId[];
  readonly turnIndex: number;
  readonly turnEndsAt: Instant | null;
  readonly combatants: Readonly<Record<CombatantId, Combatant>>;
  readonly zones: readonly Zone[];
  readonly edges: readonly ZoneEdge[];
  // Unordered pairs of hostile creatures within 5 feet of each other.
  readonly engagements: readonly (readonly [CombatantId, CombatantId])[];
  readonly resolution: ResolutionState | null;
  readonly pendingMove: PendingMove | null;
  // Effect triggers at a turn boundary that are still running, one roll at a time:
  // whose turn boundary it is, and which triggers have run ("effectId#index").
  readonly pendingTriggers: PendingTriggers | null;
  readonly pendingRolls: Readonly<Record<RollId, PendingCombatRoll>>;
  // Last number used for deterministic roll and resolution IDs.
  readonly sequence: number;
  readonly outcome: EncounterOutcome | null;
  // A turn that was due while nobody was present; continue starts it.
  readonly deferredTurn: { readonly turnIndex: number; readonly round: number } | null;
  // The last round the Narrator described; later flourishes only.
  readonly narratedRound: number;
  // Found by the party if it wins.
  readonly loot: readonly ContentId<"item">[];
  readonly gold: number;
  // What the fight was started from, so the organizer can retry it.
  readonly spec: EncounterSpec;
}

export function currentCombatant(encounter: EncounterState): Combatant | undefined {
  const id = encounter.order[encounter.turnIndex];
  return id === undefined ? undefined : encounter.combatants[id];
}

// In the fight and able to act.
export function isActive(combatant: Combatant): boolean {
  return combatant.condition === "active";
}

// Still a creature on the battlefield (a downed hero can still be hit).
export function isPresent(combatant: Combatant): boolean {
  return combatant.condition !== "dead" && combatant.condition !== "fled";
}

export function isDowned(combatant: Combatant): boolean {
  return combatant.condition === "unconscious" || combatant.condition === "stable";
}

export function areEngaged(encounter: EncounterState, a: CombatantId, b: CombatantId): boolean {
  return encounter.engagements.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function engagedWith(encounter: EncounterState, id: CombatantId): readonly Combatant[] {
  return encounter.engagements.flatMap(([x, y]) => {
    const other = x === id ? y : y === id ? x : null;
    const combatant = other === null ? undefined : encounter.combatants[other];
    return combatant === undefined ? [] : [combatant];
  });
}
