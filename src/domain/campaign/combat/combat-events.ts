import type { EffectInstance } from "../effects/effect-instance.js";
import type { Combatant } from "./combat-state.js";
import type { Instant, RollId } from "../core/ids.js";
import type { D20TestRoll } from "../dice/d20-test.js";
import type { RollResult } from "../dice/roll-spec.js";
import type { RollMoments } from "../dice/roll-moments.js";
import type { ContentId } from "../rules/content-id.js";
import type { Trait } from "../rules/traits.js";
import type {
  AttackOption,
  CombatantCondition,
  CombatantId,
  Concentration,
  EncounterOutcome,
  EncounterState,
  PendingCombatRoll,
  PendingReaction,
  PendingSmite,
  PendingEffectRoll,
  PendingMove,
  ResolutionState,
  WildShapeForm,
  ZoneId,
} from "./combat-state.js";

// What a trigger's roll did: damage dealt, or whether the save ended the effect.
export type TriggerOutcome = { readonly kind: "damage"; readonly amount: number } | { readonly kind: "save"; readonly ended: boolean; readonly dc: number };

// Why lasting effects ended.
export type EffectEnd = "expired" | "concentration" | "usedUp" | "stoodUp" | "saved" | "cured";

// What an action spends when it is declared.
export interface ActionCost {
  readonly action: boolean;
  readonly bonusAction: boolean;
  readonly reaction: boolean;
  readonly spellSlot: number | null;
  readonly featureUse: ContentId<"feature"> | null;
  // How many of them; 1 when absent.
  readonly featureUseAmount?: number;
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
      // Feet of movement for the turn when speed bonuses (Longstrider, Fly) raise it above the creature's speed.
      readonly movement?: number;
    }
  | { readonly kind: "stoodUp"; readonly combatantId: CombatantId; readonly feet: number }
  | { readonly kind: "combatantMoved"; readonly combatantId: CombatantId; readonly zoneId: ZoneId; readonly feet: number }
  | { readonly kind: "combatantEngaged"; readonly combatantId: CombatantId; readonly targetId: CombatantId; readonly feet: number }
  | { readonly kind: "combatantWithdrew"; readonly combatantId: CombatantId; readonly feet: number }
  | { readonly kind: "moveInterrupted"; readonly move: PendingMove }
  | { readonly kind: "moveCleared" }
  // A move waits for the front provoker (moveInterrupted's own PendingMove
  // names who) to say whether they take the opportunity attack it offers.
  | { readonly kind: "opportunityAttackOffered"; readonly combatantId: CombatantId; readonly closesAt: Instant | null }
  // They took it (an ordinary "opportunity" attack follows), or declined
  // (held the reaction, and the next provoker in line is asked or auto-resolved).
  | { readonly kind: "opportunityAttackAnswered"; readonly combatantId: CombatantId; readonly took: boolean }
  | { readonly kind: "actionTaken"; readonly combatantId: CombatantId; readonly action: "dash" | "dodge" | "disengage" | "giveItem" | "useItem"; readonly bonus: boolean }
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
      // The temporary hit points left after this change, when it touched them.
      readonly tempHp?: number;
      readonly condition: CombatantCondition;
      readonly deathSaves: { readonly successes: number; readonly failures: number };
      readonly cause: "damage" | "massiveDamage" | "damageAtZero" | "healing" | "protectedWhileAway";
    }
  // A lasting effect (a condition, a spell that outlasts its casting) lands on a creature.
  | { readonly kind: "effectApplied"; readonly combatantId: CombatantId; readonly effect: EffectInstance }
  // A hit waits for the target's reaction; the roll is kept, the outcome is not final yet.
  | { readonly kind: "reactionOffered"; readonly resolutionId: string; readonly reaction: PendingReaction }
  // A spell was countered (Counterspell): it does nothing, and the rolls it was waiting on are dropped.
  | { readonly kind: "spellCountered"; readonly resolutionId: string }
  // The target cast a reaction spell (spellId, at slotLevel) or declined (both null).
  | { readonly kind: "reactionAnswered"; readonly resolutionId: string; readonly targetId: CombatantId; readonly spellId: ContentId<"spell"> | null; readonly slotLevel: number | null }
  // A landed weapon hit waits for the attacker's Divine Smite answer; the check already settled.
  | { readonly kind: "smiteOffered"; readonly resolutionId: string; readonly smite: PendingSmite }
  // The attacker (not the hit's target) spent this slot on bonus damage, or skipped it (null).
  | { readonly kind: "smiteAnswered"; readonly resolutionId: string; readonly combatantId: CombatantId; readonly slotLevel: number | null }
  // Effect triggers begin at a creature's turn boundary; each asks for its roll in turn.
  | { readonly kind: "triggersBegan"; readonly creatureId: CombatantId; readonly boundary: "start" | "end" }
  | { readonly kind: "triggerRollRequested"; readonly holderId: CombatantId; readonly effectId: string; readonly index: number; readonly rollId: RollId; readonly pending: PendingCombatRoll; readonly sequence: number }
  | { readonly kind: "triggerRolled"; readonly rollId: RollId; readonly holderId: CombatantId; readonly effectId: string; readonly result: RollResult; readonly outcome: TriggerOutcome }
  | { readonly kind: "triggersFinished" }
  // Effects end: their clock ran out, their concentration broke, an attack used them up, or the holder stood up.
  | { readonly kind: "effectsRemoved"; readonly combatantId: CombatantId; readonly effectIds: readonly string[]; readonly reason: EffectEnd }
  | { readonly kind: "sneakAttackUsed"; readonly combatantId: CombatantId }
  // Exhaustion changed to this level (0-6), clamped by the caller. Level 6 kills.
  | { readonly kind: "exhaustionChanged"; readonly combatantId: CombatantId; readonly level: number }
  // A monster's Regeneration was blocked (or is free again), or one Legendary Resistance was spent.
  // Action Surge: the combatant has its action (and the attacks of it) again.
  | { readonly kind: "actionGranted"; readonly combatantId: CombatantId; readonly attacks?: number }
  | { readonly kind: "movementGranted"; readonly combatantId: CombatantId; readonly feet: number }
  | { readonly kind: "slotGained"; readonly combatantId: CombatantId; readonly level: number }
  | { readonly kind: "slotConverted"; readonly combatantId: CombatantId; readonly level: number }
  | { readonly kind: "lightingChanged"; readonly zoneId: ZoneId; readonly lighting: "bright" | "dim" | "dark" }
  | { readonly kind: "monsterStateChanged"; readonly combatantId: CombatantId; readonly regenBlocked?: boolean; readonly legendaryResistanceSpent?: boolean; readonly legendarySpent?: number; readonly legendaryTurn?: number; readonly relentlessSpent?: boolean; readonly indomitableSpent?: boolean; readonly relentlessRageSpent?: boolean; readonly innateSpent?: ContentId<"spell">; readonly featureSpent?: ContentId<"feature"> }
  // A check's roll was thrown away and made again (Halfling Lucky, Indomitable); the new roll takes its place.
  | { readonly kind: "checkRerolled"; readonly resolutionId: string; readonly oldRollId: RollId; readonly rollId: RollId; readonly reason: "lucky" | "indomitable" }
  // Uncanny Dodge halved an attack's damage; spends the reaction it uses.
  | { readonly kind: "uncannyDodgeUsed"; readonly combatantId: CombatantId }
  // Wild Shape: transforming into (or reverting from) a beast's stat block.
  // original: the hero's own stats to restore later, stashed on transforming;
  // null on reverting, since there is then nothing left to stash.
  | {
      readonly kind: "wildShapeChanged";
      readonly combatantId: CombatantId;
      readonly attacks: readonly AttackOption[];
      readonly armorClass: number;
      readonly speed: number;
      readonly traits: readonly Trait[];
      readonly maxHp: number;
      readonly hp: number;
      readonly original: WildShapeForm | null;
      // The feature whose use taking the form spends.
      readonly spendsUseOf?: ContentId<"feature">;
      // The resolution of the concentration spell that holds the form (Polymorph); it reverts when that ends.
      readonly boundTo?: string;
    }
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
  // A conjured creature joins the fight on its summoner's side, right after the summoner in the turn order.
  | { readonly kind: "combatantSummoned"; readonly combatant: Combatant; readonly summonerId: CombatantId }
  | { readonly kind: "turnEnded"; readonly combatantId: CombatantId }
  | { readonly kind: "turnDeferred"; readonly turnIndex: number; readonly round: number }
  // A hero's gear changed mid-fight (a hand-over): armor class, attacks, and traits follow it.
  | {
      readonly kind: "gearChanged";
      readonly combatantId: CombatantId;
      readonly armorClass: number;
      readonly attacks: readonly AttackOption[];
      readonly traits: readonly Trait[];
    }
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
  "opportunityAttackOffered",
  "opportunityAttackAnswered",
  "actionTaken",
  "resolutionDeclared",
  "checkRolled",
  "checkRerolled",
  "effectRollsRequested",
  "effectRolled",
  "combatantHpChanged",
  "effectApplied",
  "effectsRemoved",
  "reactionOffered",
  "spellCountered",
  "reactionAnswered",
  "smiteOffered",
  "smiteAnswered",
  "triggersBegan",
  "triggerRollRequested",
  "triggerRolled",
  "triggersFinished",
  "sneakAttackUsed",
  "exhaustionChanged",
  "monsterStateChanged",
  "actionGranted",
  "movementGranted",
  "slotGained",
  "slotConverted",
  "lightingChanged",
  "uncannyDodgeUsed",
  "wildShapeChanged",
  "concentrationStarted",
  "concentrationEnded",
  "concentrationSaveRequested",
  "concentrationSaveRolled",
  "resolutionFinished",
  "deathSaveRequested",
  "deathSaveRolled",
  "combatantFled",
  "combatantSummoned",
  "turnEnded",
  "turnDeferred",
  "gearChanged",
  "encounterEnded",
  "combatNarrationRecorded",
];
