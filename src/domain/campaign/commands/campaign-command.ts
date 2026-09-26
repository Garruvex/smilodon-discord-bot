import type { SceneId } from "../adventure/adventure-bible.js";
import type { CharacterSheet, CheckTest } from "../character/character-sheet.js";
import type { CharacterId, CheckId, RollId, UserId } from "../core/ids.js";
import type { RollResult } from "../dice/roll-spec.js";
import type { LedgerVisibility } from "../ledger/ledger.js";
import type { ContentId } from "../rules/content-id.js";
import type { DcTier, RollModeReason } from "../rules/difficulty.js";

// Who issued a command. Users are checked against saved campaign state
// (membership, ownership, organizer); the system covers timers and workers.
export type Actor = { readonly kind: "user"; readonly userId: UserId } | { readonly kind: "system" };

// Closed union: decide() handles every kind with an exhaustive switch.
export type CampaignCommand =
  // Opens the next round: by the system after narration, or by a present
  // member after a quiet round.
  | { readonly kind: "openRound" }
  | { readonly kind: "submitAction"; readonly characterId: CharacterId; readonly text: string }
  | { readonly kind: "pass"; readonly characterId: CharacterId }
  | { readonly kind: "closeRound" }
  | { readonly kind: "roundTimerExpired"; readonly roundNumber: number }
  | { readonly kind: "applyRoundPlan"; readonly proposal: RoundPlanProposal }
  | { readonly kind: "requestRoll"; readonly checkId: CheckId }
  | { readonly kind: "rollTimerExpired"; readonly checkId: CheckId }
  | { readonly kind: "recordRoll"; readonly rollId: RollId; readonly result: RollResult }
  | { readonly kind: "markAway"; readonly userId: UserId }
  | { readonly kind: "markReturned"; readonly userId: UserId }
  // Resumes a campaign that was waiting for players.
  | { readonly kind: "continue" }
  // The Planner could not produce a valid proposal after its retry.
  | { readonly kind: "reportPlannerFailure"; readonly roundNumber: number; readonly problems: readonly string[] }
  // The organizer asks the Planner to try the held round again.
  | { readonly kind: "retryPlan" }
  | { readonly kind: "recordNarration"; readonly roundNumber: number; readonly text: string }
  // The Narrator's flourish for a combat round, or the fight's closing line.
  | { readonly kind: "recordCombatNarration"; readonly encounterId: string; readonly round: number; readonly text: string }
  | RecordLedgerFactCommand
  // Organizer, outside combat. Short: limited features recharge. Long: HP,
  // spell slots, and every feature recharge.
  | { readonly kind: "takeRest"; readonly rest: "short" | "long" }
  | InventoryCommand
  // Organizer, after a lost fight: play it again from its start, with fresh dice.
  | { readonly kind: "retryEncounter" }
  // A player's new hero: their first, or one to replace a fallen hero.
  | { readonly kind: "joinHero"; readonly sheet: CharacterSheet }
  | CombatCommand;

// Items move between heroes outside combat. The owner of the giving hero
// offers, the owner of the receiving hero answers; the stash is shared.
export type InventoryCommand =
  | {
      readonly kind: "offerItem";
      readonly fromCharacterId: CharacterId;
      readonly toCharacterId: CharacterId;
      readonly give: ContentId<"item">;
      // Null: a gift. Otherwise the item asked for in return.
      readonly want: ContentId<"item"> | null;
    }
  | { readonly kind: "respondToOffer"; readonly offerId: string; readonly accept: boolean }
  | { readonly kind: "cancelOffer"; readonly offerId: string }
  | { readonly kind: "stashItem"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  // The hero's owner, or the organizer, takes an item out of the stash for a hero.
  | { readonly kind: "takeFromStash"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  // Outside combat: the hero drinks a potion they hold.
  | { readonly kind: "useItem"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> };

// Combat. Hero commands name the acting combatant (the hero's character ID)
// so a stale button for another turn is refused rather than misapplied.
export type CombatCommand =
  | { readonly kind: "startEncounter"; readonly spec: EncounterSpec }
  | { readonly kind: "combatMove"; readonly combatantId: string; readonly zoneId: string }
  | { readonly kind: "combatEngage"; readonly combatantId: string; readonly targetId: string }
  | { readonly kind: "combatWithdraw"; readonly combatantId: string }
  | { readonly kind: "combatAttack"; readonly combatantId: string; readonly targetId: string; readonly weapon: ContentId<"item"> }
  | {
      readonly kind: "combatCast";
      readonly combatantId: string;
      readonly spellId: ContentId<"spell">;
      // 0 for cantrips.
      readonly slotLevel: number;
      readonly targetIds: readonly string[];
    }
  | { readonly kind: "combatUseFeature"; readonly combatantId: string; readonly featureId: ContentId<"feature"> }
  | { readonly kind: "combatUseItem"; readonly combatantId: string; readonly itemId: ContentId<"item"> }
  | { readonly kind: "combatDisengage"; readonly combatantId: string }
  | { readonly kind: "combatDash"; readonly combatantId: string }
  | { readonly kind: "combatDodge"; readonly combatantId: string }
  | { readonly kind: "endTurn"; readonly combatantId: string }
  | { readonly kind: "turnTimerExpired"; readonly encounterId: string; readonly turnNumber: number };

export interface EncounterSpec {
  readonly id: string;
  readonly zones: readonly { readonly id: string; readonly name: string }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly feet: number }[];
  readonly partyZoneId: string;
  readonly monsters: readonly EncounterMonster[];
  // Added to the party stash on a victory. Absent: none.
  readonly loot?: readonly ContentId<"item">[];
  readonly gold?: number;
}

export interface EncounterMonster {
  readonly monsterId: ContentId<"monster">;
  readonly zoneId: string;
  // A named NPC this monster plays, e.g. npc:skarn.
  readonly npcId: string | null;
  readonly fleeBelowHpFraction: number | null;
}

export interface RecordLedgerFactCommand {
  readonly kind: "recordLedgerFact";
  readonly entityId: string;
  readonly canonicalName: string;
  readonly fact: string;
  readonly visibility: LedgerVisibility;
}

export type CampaignCommandKind = CampaignCommand["kind"];

// The Planner's structured proposal for a closed round, validated by the
// engine before anything applies. Clarification, conflicts, and
// dependencies join this shape later.
export interface RoundPlanProposal {
  readonly roundNumber: number;
  readonly actions: readonly PlannedAction[];
  // Applied once the round's checks resolve, before narration. Absent: none.
  readonly effects?: readonly PlannedEffect[];
}

// A story effect and when it fires (plan §6: effects keyed by outcome, so no
// second model call is needed after the roll).
export interface PlannedEffect {
  readonly effect: StoryEffect;
  readonly when: EffectCondition;
}

// The application resolves authored IDs (encounters) to their definitions
// before the proposal reaches the engine, which validates the result.
export type StoryEffect =
  | { readonly kind: "transitionScene"; readonly sceneId: SceneId }
  | { readonly kind: "startEncounter"; readonly encounter: EncounterSpec }
  // Ticks a skill-challenge clock. The application resolves the clock's
  // size and the fight it starts when full from the adventure.
  | {
      readonly kind: "advanceClock";
      readonly clockId: string;
      readonly segments: number;
      readonly by: number;
      readonly onFull: EncounterSpec | null;
    }
  | { readonly kind: "revealClue"; readonly clueId: string; readonly text: string };

export type EffectCondition =
  | { readonly kind: "always" }
  // Fires on the outcome of this hero's check this round.
  | { readonly kind: "checkOutcome"; readonly characterId: CharacterId; readonly success: boolean };

export interface PlannedAction {
  readonly characterId: CharacterId;
  readonly resolution: PlannedResolution;
}

export type PlannedResolution =
  | { readonly kind: "automatic"; readonly reason: string }
  | { readonly kind: "impossible"; readonly reason: string }
  | {
      readonly kind: "check";
      readonly test: CheckTest;
      readonly dcTier: DcTier;
      readonly rollModeReasons: readonly RollModeReason[];
    };
