import type { CharacterId, Instant, RollId } from "../core/ids.js";
import type { D20TestSpec } from "../dice/d20-test.js";
import type { DiceExpression } from "../dice/dice-expression.js";
import type { CreatureTrait, MonsterTactic, WeaponRange } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { DamageType } from "../rules/effects.js";

export type CombatantId = string;
export type ZoneId = string;
export type Side = "party" | "foes";

// One attack a combatant can make, already resolved to numbers. Heroes'
// options come from their abilities, proficiency, and weapons; monsters'
// from their stat block. The engine never needs to know which.
export interface AttackOption {
  readonly weapon: ContentId<"item">;
  readonly toHit: number;
  readonly damage: DiceExpression;
  readonly damageType: DamageType;
  readonly range: WeaponRange;
}

export type CombatantSource =
  | { readonly kind: "hero"; readonly characterId: CharacterId }
  | { readonly kind: "monster"; readonly monsterId: ContentId<"monster">; readonly npcId: string | null };

// active: can act. unconscious: at 0 HP, making death saves (heroes).
// stable: at 0 HP, no longer making death saves. dead / fled: out of the fight.
export type CombatantCondition = "active" | "unconscious" | "stable" | "dead" | "fled";

// Every creature in a fight has this one shape (code structure: heroes and
// monsters share one system with different stats).
export interface Combatant {
  readonly id: CombatantId;
  readonly side: Side;
  readonly source: CombatantSource;
  // "A", "B" for repeated monster types; null for heroes and unique foes.
  readonly letter: string | null;
  readonly armorClass: number;
  readonly maxHp: number;
  readonly hp: number;
  readonly speed: number;
  readonly initiativeModifier: number;
  readonly attacks: readonly AttackOption[];
  readonly traits: readonly CreatureTrait[];
  // How the engine plays this combatant when no player does.
  readonly tactic: MonsterTactic | null;
  // Flee at the start of its turn when HP falls below this share of max.
  readonly fleeBelowHpFraction: number | null;
  readonly zoneId: ZoneId;
  readonly initiative: number | null;
  readonly budget: TurnBudget;
  // Dodge: attacks against it have disadvantage until its next turn.
  readonly dodging: boolean;
  readonly condition: CombatantCondition;
  readonly deathSaves: { readonly successes: number; readonly failures: number };
}

export interface TurnBudget {
  readonly action: boolean;
  readonly bonusAction: boolean;
  readonly reaction: boolean;
  readonly movement: number;
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

// An attack is a persisted sequence (panel spec: Attack sequence): each stage
// is saved, so a restart resumes where it stopped and never rerolls.
export interface AttackState {
  readonly id: string;
  readonly attackerId: CombatantId;
  readonly targetId: CombatantId;
  readonly option: AttackOption;
  readonly spec: D20TestSpec;
  readonly stage: "attackRoll" | "damageRoll";
  readonly attackRollId: RollId;
  readonly damageRollId: RollId | null;
  readonly critical: boolean;
}

export type PendingCombatRoll =
  | { readonly purpose: "initiative"; readonly combatantId: CombatantId; readonly spec: D20TestSpec }
  | { readonly purpose: "attack"; readonly attackId: string }
  | { readonly purpose: "damage"; readonly attackId: string }
  | { readonly purpose: "deathSave"; readonly combatantId: CombatantId };

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
  // Unordered pairs of creatures within 5 feet of each other.
  readonly engagements: readonly (readonly [CombatantId, CombatantId])[];
  readonly attack: AttackState | null;
  readonly pendingRolls: Readonly<Record<RollId, PendingCombatRoll>>;
  // Counter for deterministic roll and attack IDs.
  readonly sequence: number;
  readonly outcome: EncounterOutcome | null;
  // A turn that was due while nobody was present; continue starts it.
  readonly deferredTurn: { readonly turnIndex: number; readonly round: number } | null;
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
