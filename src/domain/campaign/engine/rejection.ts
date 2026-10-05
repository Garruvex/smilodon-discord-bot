import type { TurnProblem } from "../combat/turn-rules.js";

// Why a command was refused. Typed so the Discord layer can show a localized,
// private explanation; never shown as raw text.
export type Rejection =
  | { readonly code: "notMember" }
  | { readonly code: "notOrganizer" }
  | { readonly code: "notYourCharacter" }
  | { readonly code: "memberAway" }
  | { readonly code: "memberNotAway" }
  | { readonly code: "noShortRest" }
  | { readonly code: "resting" }
  | { readonly code: "nothingToRest" }
  | { readonly code: "alreadyRested" }
  | { readonly code: "restVoteOpen" }
  | { readonly code: "noRestVote" }
  | { readonly code: "hitDicePending" }
  | { readonly code: "noHitDice" }
  | { readonly code: "organizerStays" }
  | { readonly code: "systemOnly" }
  | { readonly code: "campaignWaiting" }
  | { readonly code: "campaignPaused" }
  | { readonly code: "campaignNotWaiting" }
  | { readonly code: "nobodyPresent" }
  | { readonly code: "roundAlreadyOpen" }
  | { readonly code: "noOpenRound" }
  | { readonly code: "roundNotCollecting" }
  | { readonly code: "moveDecisionPending" }
  | { readonly code: "notParticipant" }
  | { readonly code: "emptyAction" }
  | { readonly code: "actionTooLong"; readonly maxLength: number }
  | { readonly code: "stalePlan" }
  | { readonly code: "invalidPlan"; readonly problems: readonly string[] }
  | { readonly code: "unknownCheck" }
  | { readonly code: "checkNotPending" }
  | { readonly code: "rollMismatch" }
  | { readonly code: "notPlanning" }
  | { readonly code: "staleNarration" }
  | { readonly code: "notAwaitingReady" }
  | { readonly code: "emptyNarration" }
  | { readonly code: "staleSummary" }
  | { readonly code: "nothingToRetell" }
  | { readonly code: "staleRound" }
  | { readonly code: "nothingToIllustrate" }
  | { readonly code: "nothingToRedo" }
  | { readonly code: "noReaction" }
  | { readonly code: "noPendingMove" }
  | { readonly code: "invalidMove" }
  | { readonly code: "noOpportunityAttack" }
  | { readonly code: "noSmite" }
  | { readonly code: "invalidProxy" }
  | { readonly code: "invalidSummary"; readonly problem: "text" | "numbers" }
  | { readonly code: "invalidLedgerFact"; readonly problem: string }
  | { readonly code: "canonicalNameLocked"; readonly canonicalName: string }
  | { readonly code: "unknownRoll" }
  | { readonly code: "inCombat" }
  | { readonly code: "notInCombat" }
  | { readonly code: "roundInProgress" }
  | { readonly code: "invalidEncounter"; readonly problems: readonly string[] }
  | { readonly code: "notYourTurn" }
  | { readonly code: "attackInProgress" }
  | TurnProblem
  | { readonly code: "cannotLeaveNow" }
  | { readonly code: "unknownOffer" }
  | { readonly code: "invalidOffer" }
  | { readonly code: "tradingOff" }
  | { readonly code: "notRetryable" }
  | { readonly code: "heroFallen" }
  | { readonly code: "invalidHero"; readonly problems: readonly string[] }
  | { readonly code: "heroNotReplaceable" }
  | { readonly code: "unknownClass" }
  | { readonly code: "multiclassRequirementNotMet" }
  | { readonly code: "invalidLevel" }
  | { readonly code: "noLevelToRaise" }
  | { readonly code: "noAsiPending" }
  | { readonly code: "invalidAsiAllocation" }
  | { readonly code: "unknownItem" }
  | { readonly code: "insufficientGold" }
  | { readonly code: "invalidHaggleSkill" }
  | { readonly code: "haggleAlreadyPending" }
  | { readonly code: "invalidPressSkill" }
  | { readonly code: "pressAlreadyPending" }
  | { readonly code: "pressAlreadyAttempted" }
  | { readonly code: "dialoguePending" }
  | { readonly code: "npcDown" }
  | { readonly code: "secretAlreadyRevealed" }
  | { readonly code: "notARitualSpell" }
  | { readonly code: "hazardAlreadyPending" }
  | { readonly code: "notAHealingSpell" }
  | { readonly code: "nothingToHeal" }
  | { readonly code: "healingAlreadyPending" }
  | { readonly code: "invalidHazardDamage" }

export type RejectionCode = Rejection["code"];
