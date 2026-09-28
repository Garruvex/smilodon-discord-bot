import type { CheckId, Instant, RollId, TimerId } from "../core/ids.js";
import type { RollSpec } from "../dice/roll-spec.js";

// Work the engine needs the application to do, expressed as data and saved
// to the outbox in the same transaction as the events.
export type EngineRequest =
  // Roll this spec once and re-enter with recordRoll; a retry reuses the saved roll.
  | { readonly kind: "roll"; readonly rollId: RollId; readonly spec: RollSpec }
  | { readonly kind: "plan"; readonly roundNumber: number }
  | { readonly kind: "narrate"; readonly roundNumber: number }
  // The adventure's opening scene, told before the first round.
  | { readonly kind: "narrateOpening" }
  // Tell the last narrated round again (the organizer did not like it).
  | { readonly kind: "renarrate"; readonly roundNumber: number }
  // Condense the rounds through this one (background; a scene just closed, or enough rounds piled up).
  | { readonly kind: "chronicle"; readonly throughRound: number }
  // A combat round's flourish, or (final) the fight's closing narration.
  | { readonly kind: "narrateCombat"; readonly encounterId: string; readonly round: number; readonly final: boolean }
  // A settled trade's NPC reaction (engine/shop.ts).
  | { readonly kind: "narrateTrade"; readonly tradeId: string }
  // A settled conversation's NPC reply (engine/dialogue.ts).
  | { readonly kind: "narrateDialogue"; readonly dialogueId: string }
  // A ritual spell cast outside combat, waiting on what it reveals or does (engine/utility-magic.ts).
  | { readonly kind: "narrateUtilityCast"; readonly castId: string }
  // A picture for a scene the party just entered; made in the background and never awaited.
  | { readonly kind: "sceneImage"; readonly sceneId: string; readonly roundNumber: number }
  // A portrait of a monster the party meets for the first time (or of the named NPC it plays); made once and reused.
  | { readonly kind: "monsterImage"; readonly monsterId: string; readonly npcId: string | null }
  // A picture of what just happened, from a round's already-told narration (the organizer asked for it).
  // `auto`: the engine noticed a dramatic roll; the picture is skipped when one was made lately or the budget is running low.
  | { readonly kind: "momentImage"; readonly roundNumber: number; readonly auto?: boolean }
  // A portrait of a hero who joined the party.
  | { readonly kind: "heroImage"; readonly characterId: string }
  // Paint a picture again (the organizer did not like it); spends budget like a new one.
  | { readonly kind: "redoImage"; readonly subject: string }
  | { readonly kind: "startTimer"; readonly timer: TimerSpec }
  | { readonly kind: "cancelTimer"; readonly timerId: TimerId }
  | { readonly kind: "deliver"; readonly delivery: DeliverySpec };

// What a halfway reminder is about, with the deadline it was made for: when the
// deadline has since moved (a pause and resume) the reminder does nothing.
export type ReminderTarget =
  | { readonly kind: "round"; readonly roundNumber: number; readonly closesAt: Instant }
  | { readonly kind: "roll"; readonly checkId: CheckId; readonly deadline: Instant }
  | { readonly kind: "turn"; readonly encounterId: string; readonly turnNumber: number; readonly endsAt: Instant };

export type TimerSpec =
  | { readonly kind: "reminder"; readonly timerId: TimerId; readonly dueAt: Instant; readonly target: ReminderTarget }
  | { readonly kind: "roundWindow"; readonly timerId: TimerId; readonly dueAt: Instant; readonly roundNumber: number }
  | { readonly kind: "roll"; readonly timerId: TimerId; readonly dueAt: Instant; readonly checkId: CheckId }
  | { readonly kind: "combatTurn"; readonly timerId: TimerId; readonly dueAt: Instant; readonly encounterId: string; readonly turnNumber: number }
  | { readonly kind: "combatReaction"; readonly timerId: TimerId; readonly dueAt: Instant; readonly encounterId: string; readonly resolutionId: string }
  // A move waits for a provoker to say whether they take the opportunity
  // attack it offers; combatantId is the provoker asked.
  | { readonly kind: "opportunityAttack"; readonly timerId: TimerId; readonly dueAt: Instant; readonly encounterId: string; readonly combatantId: string };

export type DeliverySpec =
  // Halfway through a long wait: whoever is still being waited for is nudged.
  | { readonly kind: "timerReminder"; readonly target: ReminderTarget }
  // The "?" die appears (panel spec: Dice moments).
  | { readonly kind: "rollStarted"; readonly checkId: CheckId }
  // The staged reveal lands on the saved result.
  | { readonly kind: "rollResult"; readonly checkId: CheckId }
  // Everyone passed or missed: a template waiting status, no model call.
  | { readonly kind: "quietRound"; readonly roundNumber: number }
  | { readonly kind: "waitingForPlayers" }
  // Play was paused on purpose; the organizer resumes it.
  | { readonly kind: "campaignPaused"; readonly reason: "organizer" | "recovery" | "safety" }
  // A hero's in-character line, posted as they said it.
  | { readonly kind: "speech"; readonly characterId: string; readonly text: string }
  | { readonly kind: "narration"; readonly roundNumber: number; readonly regenerated?: boolean }
  | { readonly kind: "opening" }
  // "The DM considers…": the round is held after the Planner failed.
  | { readonly kind: "dmHolding"; readonly roundNumber: number }
  | { readonly kind: "organizerNotice"; readonly notice: "plannerFailed"; readonly roundNumber: number }
  // Combat: template result lines and the combat card, no model call.
  | { readonly kind: "encounterStarted"; readonly encounterId: string }
  | { readonly kind: "combatTurn"; readonly encounterId: string; readonly combatantId: string }
  | { readonly kind: "attackRolled"; readonly encounterId: string; readonly attackId: string }
  // A hit waits for its target to answer with a reaction.
  | { readonly kind: "reactionOffered"; readonly encounterId: string; readonly attackId: string }
  // A move waits for a provoker to say whether they take the opportunity attack.
  | { readonly kind: "opportunityAttackOffered"; readonly encounterId: string; readonly combatantId: string }
  | { readonly kind: "attackResolved"; readonly encounterId: string; readonly attackId: string }
  | { readonly kind: "deathSave"; readonly encounterId: string; readonly combatantId: string }
  // A turn action with no attack of its own: the table sees one template line.
  | { readonly kind: "combatBeat"; readonly encounterId: string; readonly combatantId: string; readonly beat: "dodge" | "dash" | "disengage" | "useItem" | "fled" | "reaction" }
  | { readonly kind: "encounterEnded"; readonly encounterId: string }
  | { readonly kind: "combatNarration"; readonly encounterId: string; readonly round: number }
  // A trade offer waits for the other hero's owner.
  | { readonly kind: "itemOffered"; readonly offerId: string }
  // A shop trade's NPC reaction is ready.
  | { readonly kind: "tradeNarrated"; readonly tradeId: string }
  // A conversation's NPC reply is ready.
  | { readonly kind: "dialogueNarrated"; readonly dialogueId: string }
  // A ritual spell's outside-combat effect is ready.
  | { readonly kind: "utilityCastNarrated"; readonly castId: string };
