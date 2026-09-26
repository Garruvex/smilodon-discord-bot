import type { Instant, RollId } from "../core/ids.js";
import type { D20TestRoll } from "../dice/d20-test.js";
import type { ExpressionRoll } from "../dice/roll.js";
import type { RollMoments } from "../dice/roll-moments.js";
import type { AttackState, CombatantCondition, CombatantId, EncounterOutcome, EncounterState, ZoneId } from "./combat-state.js";

// Combat events. Each carries the values it results in (HP after damage,
// death-save tallies), so evolve() applies them without recomputing rules.
export type CombatEvent =
  | { readonly kind: "encounterStarted"; readonly encounter: EncounterState }
  | { readonly kind: "initiativeRolled"; readonly combatantId: CombatantId; readonly rollId: RollId; readonly roll: D20TestRoll }
  | { readonly kind: "turnOrderSet"; readonly order: readonly CombatantId[] }
  | {
      readonly kind: "turnStarted";
      readonly combatantId: CombatantId;
      readonly turnIndex: number;
      readonly round: number;
      readonly turnNumber: number;
      readonly endsAt: Instant | null;
    }
  | { readonly kind: "combatantMoved"; readonly combatantId: CombatantId; readonly zoneId: ZoneId; readonly feet: number }
  | { readonly kind: "combatantEngaged"; readonly combatantId: CombatantId; readonly targetId: CombatantId; readonly feet: number }
  | { readonly kind: "combatantWithdrew"; readonly combatantId: CombatantId; readonly feet: number }
  | { readonly kind: "actionTaken"; readonly combatantId: CombatantId; readonly action: "dash" | "dodge" }
  | { readonly kind: "attackDeclared"; readonly attack: AttackState }
  | {
      readonly kind: "attackRolled";
      readonly attackId: string;
      readonly roll: D20TestRoll;
      readonly hit: boolean;
      readonly critical: boolean;
      readonly moments: RollMoments;
    }
  | { readonly kind: "damageRollRequested"; readonly attackId: string; readonly rollId: RollId }
  | { readonly kind: "damageRolled"; readonly attackId: string; readonly roll: ExpressionRoll }
  | {
      readonly kind: "combatantHpChanged";
      readonly combatantId: CombatantId;
      // Negative for damage.
      readonly change: number;
      readonly hp: number;
      readonly condition: CombatantCondition;
      readonly deathSaves: { readonly successes: number; readonly failures: number };
      readonly cause: "damage" | "massiveDamage" | "damageAtZero";
    }
  | { readonly kind: "attackFinished"; readonly attackId: string }
  | { readonly kind: "deathSaveRequested"; readonly combatantId: CombatantId; readonly rollId: RollId }
  | {
      readonly kind: "deathSaveRolled";
      readonly combatantId: CombatantId;
      readonly rollId: RollId;
      readonly roll: D20TestRoll;
      readonly moments: RollMoments;
      readonly hp: number;
      readonly condition: CombatantCondition;
      readonly deathSaves: { readonly successes: number; readonly failures: number };
    }
  | { readonly kind: "combatantFled"; readonly combatantId: CombatantId }
  | { readonly kind: "turnEnded"; readonly combatantId: CombatantId }
  | { readonly kind: "turnDeferred"; readonly turnIndex: number; readonly round: number }
  | { readonly kind: "encounterEnded"; readonly outcome: EncounterOutcome };

export type CombatEventKind = CombatEvent["kind"];
