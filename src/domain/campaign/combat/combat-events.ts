import type { Instant, RollId } from "../core/ids.js";
import type { D20TestRoll } from "../dice/d20-test.js";
import type { RollResult } from "../dice/roll-spec.js";
import type { RollMoments } from "../dice/roll-moments.js";
import type { ContentId } from "../rules/content-id.js";
import type {
  ActiveEffect,
  CombatantCondition,
  CombatantId,
  Concentration,
  EncounterOutcome,
  EncounterState,
  PendingCombatRoll,
  PendingEffectRoll,
  PendingMove,
  ResolutionState,
  ZoneId,
} from "./combat-state.js";

// What an action spends when it is declared.
export interface ActionCost {
  readonly action: boolean;
  readonly bonusAction: boolean;
  readonly reaction: boolean;
  readonly spellSlot: number | null;
  readonly featureUse: ContentId<"feature"> | null;
}

// Combat events. Each carries the values it results in (HP after damage,
// death-save tallies, the next ID sequence), so evolve() applies them
// without recomputing rules.
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
  | { readonly kind: "stoodUp"; readonly combatantId: CombatantId; readonly feet: number }
  | { readonly kind: "combatantMoved"; readonly combatantId: CombatantId; readonly zoneId: ZoneId; readonly feet: number }
  | { readonly kind: "combatantEngaged"; readonly combatantId: CombatantId; readonly targetId: CombatantId; readonly feet: number }
  | { readonly kind: "combatantWithdrew"; readonly combatantId: CombatantId; readonly feet: number }
  | { readonly kind: "moveInterrupted"; readonly move: PendingMove }
  | { readonly kind: "moveCleared" }
  | { readonly kind: "actionTaken"; readonly combatantId: CombatantId; readonly action: "dash" | "dodge" | "disengage"; readonly bonus: boolean }
  | {
      readonly kind: "resolutionDeclared";
      readonly resolution: ResolutionState;
      readonly cost: ActionCost;
      readonly pendingRolls: Readonly<Record<RollId, PendingCombatRoll>>;
      readonly sequence: number;
    }
  | {
      readonly kind: "checkRolled";
      readonly resolutionId: string;
      readonly rollId: RollId;
      readonly targetId: CombatantId;
      readonly roll: D20TestRoll;
      readonly landed: boolean;
      readonly critical: boolean;
      readonly moments: RollMoments;
    }
  | {
      readonly kind: "effectRollsRequested";
      readonly resolutionId: string;
      readonly rolls: Readonly<Record<RollId, PendingEffectRoll>>;
      readonly sequence: number;
    }
  | { readonly kind: "effectRolled"; readonly resolutionId: string; readonly rollId: RollId; readonly effectKey: string; readonly result: RollResult; readonly value: number }
  | {
      readonly kind: "combatantHpChanged";
      readonly combatantId: CombatantId;
      // Negative for damage, positive for healing.
      readonly change: number;
      readonly hp: number;
      readonly condition: CombatantCondition;
      readonly deathSaves: { readonly successes: number; readonly failures: number };
      readonly cause: "damage" | "massiveDamage" | "damageAtZero" | "healing" | "protectedWhileAway";
    }
  | { readonly kind: "conditionAdded"; readonly combatantId: CombatantId; readonly condition: ContentId<"condition"> }
  | { readonly kind: "effectAdded"; readonly combatantId: CombatantId; readonly effect: ActiveEffect }
  | { readonly kind: "effectsRemoved"; readonly combatantId: CombatantId; readonly effectIds: readonly string[] }
  | { readonly kind: "sneakAttackUsed"; readonly combatantId: CombatantId }
  | { readonly kind: "concentrationStarted"; readonly combatantId: CombatantId; readonly concentration: Concentration }
  | { readonly kind: "concentrationEnded"; readonly combatantId: CombatantId; readonly reason: "newSpell" | "failedSave" | "downed" | "expired" }
  | {
      readonly kind: "concentrationSaveRequested";
      readonly combatantId: CombatantId;
      readonly rollId: RollId;
      readonly pending: PendingCombatRoll;
      readonly sequence: number;
    }
  | {
      readonly kind: "concentrationSaveRolled";
      readonly combatantId: CombatantId;
      readonly rollId: RollId;
      readonly roll: D20TestRoll;
      readonly dc: number;
      readonly kept: boolean;
    }
  | { readonly kind: "resolutionFinished"; readonly resolutionId: string }
  | {
      readonly kind: "deathSaveRequested";
      readonly combatantId: CombatantId;
      readonly rollId: RollId;
      readonly pending: PendingCombatRoll;
      readonly sequence: number;
    }
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
  | { readonly kind: "encounterEnded"; readonly outcome: EncounterOutcome }
  // final: the fight has ended and this is its closing narration.
  | { readonly kind: "combatNarrationRecorded"; readonly round: number; readonly text: string; readonly final: boolean };

export type CombatEventKind = CombatEvent["kind"];

export const combatEventKinds: readonly CombatEventKind[] = [
  "encounterStarted",
  "initiativeRolled",
  "turnOrderSet",
  "turnStarted",
  "stoodUp",
  "combatantMoved",
  "combatantEngaged",
  "combatantWithdrew",
  "moveInterrupted",
  "moveCleared",
  "actionTaken",
  "resolutionDeclared",
  "checkRolled",
  "effectRollsRequested",
  "effectRolled",
  "combatantHpChanged",
  "conditionAdded",
  "effectAdded",
  "effectsRemoved",
  "sneakAttackUsed",
  "concentrationStarted",
  "concentrationEnded",
  "concentrationSaveRequested",
  "concentrationSaveRolled",
  "resolutionFinished",
  "deathSaveRequested",
  "deathSaveRolled",
  "combatantFled",
  "turnEnded",
  "turnDeferred",
  "encounterEnded",
  "combatNarrationRecorded",
];
