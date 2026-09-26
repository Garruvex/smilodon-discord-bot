// Why a command was refused. Typed so the Discord layer can show a localized,
// private explanation; never shown as raw text.
export type Rejection =
  | { readonly code: "notMember" }
  | { readonly code: "notOrganizer" }
  | { readonly code: "notYourCharacter" }
  | { readonly code: "memberAway" }
  | { readonly code: "systemOnly" }
  | { readonly code: "campaignWaiting" }
  | { readonly code: "campaignNotWaiting" }
  | { readonly code: "nobodyPresent" }
  | { readonly code: "roundAlreadyOpen" }
  | { readonly code: "noOpenRound" }
  | { readonly code: "roundNotCollecting" }
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
  | { readonly code: "emptyNarration" }
  | { readonly code: "invalidLedgerFact"; readonly problem: string }
  | { readonly code: "canonicalNameLocked"; readonly canonicalName: string }
  | { readonly code: "unknownRoll" }
  | { readonly code: "inCombat" }
  | { readonly code: "notInCombat" }
  | { readonly code: "roundInProgress" }
  | { readonly code: "invalidEncounter"; readonly problems: readonly string[] }
  | { readonly code: "notYourTurn" }
  | { readonly code: "attackInProgress" }
  | { readonly code: "noActionLeft" }
  | { readonly code: "notEnoughMovement"; readonly needed: number; readonly left: number }
  | { readonly code: "notAdjacent" }
  | { readonly code: "notEngaged" }
  | { readonly code: "alreadyEngaged" }
  | { readonly code: "outOfRange" }
  | { readonly code: "invalidTarget" }
  | { readonly code: "unknownWeapon" }
  | { readonly code: "unknownSpell" }
  | { readonly code: "noSpellSlot"; readonly slotLevel: number }
  | { readonly code: "invalidTargets"; readonly maxTargets: number }
  | { readonly code: "unknownFeature" }
  | { readonly code: "noUsesLeft" }
  | { readonly code: "cannotLeaveNow" }
  | { readonly code: "unknownOffer" }
  | { readonly code: "invalidOffer" }
  | { readonly code: "itemNotHeld" }
  | { readonly code: "notUsable" }
  | { readonly code: "notRetryable" }
  | { readonly code: "heroFallen" }
  | { readonly code: "invalidHero"; readonly problems: readonly string[] }
  | { readonly code: "heroNotReplaceable" }

export type RejectionCode = Rejection["code"];
