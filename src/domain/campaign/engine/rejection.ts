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
  | { readonly code: "rollMismatch" };

export type RejectionCode = Rejection["code"];
