import type { CheckId, Instant, RollId, TimerId } from "../core/ids.js";
import type { RollSpec } from "../dice/roll-spec.js";

// Work the engine needs the application to do, expressed as data and saved
// to the outbox in the same transaction as the events.
// What a picture is of at the moment it is asked for, kept with the request: a slow job paints that moment even if the party has moved on,
// changed gear or lost a member since. Times and gear come from the story's own state, never from the job's clock.
export interface PictureSnapshot {
  readonly sceneId: string | null;
  readonly world?: { readonly day: number; readonly time: string; readonly weather?: string };
  readonly heroes: readonly { readonly id: string; readonly level: number; readonly equipment: readonly string[] }[];
}

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
  | { readonly kind: "chronicle"; readonly throughRound: number; readonly privateOnly?: boolean }
  // Validate a public scene note in the background; it does not delay narration or the next round.
  | { readonly kind: "judgeSceneNotes"; readonly roundNumber: number; readonly sceneId: string }
  // Compact a scene's public notes after their stored text crosses the size threshold.
  | { readonly kind: "compactSceneNotes"; readonly sceneId: string; readonly throughRound: number }
  // A combat round's flourish, or (final) the fight's closing narration.
  | { readonly kind: "narrateCombat"; readonly encounterId: string; readonly round: number; readonly final: boolean }
  // A settled trade's NPC reaction (engine/shop.ts).
  | { readonly kind: "narrateTrade"; readonly tradeId: string }
  // A settled conversation's NPC reply (engine/dialogue.ts).
  | { readonly kind: "narrateDialogue"; readonly dialogueId: string }
  // A ritual spell cast outside combat, waiting on what it reveals or does (engine/utility-magic.ts).
  | { readonly kind: "narrateUtilityCast"; readonly castId: string }
  // A settled travel or environmental hazard, waiting on the toll it took (engine/travel.ts).
  | { readonly kind: "narrateHazard"; readonly hazardId: string }
  // A picture for a scene the party just entered; made in the background and never awaited.
  | { readonly kind: "sceneImage"; readonly sceneId: string; readonly roundNumber: number; readonly snapshot?: PictureSnapshot }
  // The place and foes as a fight starts; separate from the scene's arrival picture.
  | { readonly kind: "encounterImage"; readonly encounterId: string; readonly monsters: readonly { readonly monsterId: string; readonly npcId: string | null }[]; readonly snapshot: PictureSnapshot }
  // A portrait of a monster the party meets for the first time (or of the named NPC it plays); made once and reused.
  | { readonly kind: "monsterImage"; readonly monsterId: string; readonly npcId: string | null }
  // A picture of what just happened, from a round's already-told narration (the organizer asked for it).
  // `auto`: the engine noticed a dramatic roll; closely spaced pictures are skipped.
  | { readonly kind: "momentImage"; readonly roundNumber: number; readonly auto?: boolean; readonly snapshot?: PictureSnapshot }
  // A portrait of a hero who joined the party.
  | { readonly kind: "heroImage"; readonly characterId: string }
  // Paint a picture again (the organizer did not like it).
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
  | { readonly kind: "combatSmite"; readonly timerId: TimerId; readonly dueAt: Instant; readonly encounterId: string; readonly resolutionId: string }
  // A move waits for a provoker to say whether they take the opportunity
  // attack it offers; combatantId is the provoker asked.
  | { readonly kind: "opportunityAttack"; readonly timerId: TimerId; readonly dueAt: Instant; readonly encounterId: string; readonly combatantId: string };

export type DeliverySpec =
  // The accepted intent, before the planner or dice decide its outcome.
  | { readonly kind: "actionIntent"; readonly roundNumber: number; readonly characterId: string; readonly revision: number }
  // Halfway through a long wait: whoever is still being waited for is nudged.
  | { readonly kind: "timerReminder"; readonly target: ReminderTarget }
  // The "?" die appears (panel spec: Dice moments).
  | { readonly kind: "rollStarted"; readonly checkId: CheckId }
  // The round is waiting on dice: whoever must roll is tagged once (the panel only shows them).
  | { readonly kind: "rollsCalled"; readonly roundNumber: number }
  // The staged reveal lands on the saved result.
  | { readonly kind: "rollResult"; readonly checkId: CheckId }
  // Everyone passed or missed: a template waiting status, no model call.
  | { readonly kind: "quietRound"; readonly roundNumber: number }
  | { readonly kind: "waitingForPlayers" }
  // Play was paused on purpose; the organizer resumes it.
  | { readonly kind: "campaignPaused"; readonly reason: "organizer" | "recovery" | "safety" }
  // A hero's in-character line, posted as they said it.
  | { readonly kind: "speech"; readonly characterId: string; readonly text: string }
  // A destination is waiting for the table's vote.
  | { readonly kind: "sceneMoveProposed"; readonly sceneId: string; readonly roundNumber: number }
  // The party entered a new scene after a resolved round; tell the table its public description.
  | { readonly kind: "sceneArrival"; readonly sceneId: string; readonly roundNumber: number }
  | { readonly kind: "narration"; readonly roundNumber: number; readonly regenerated?: boolean }
  | { readonly kind: "opening" }
  | { readonly kind: "heroArrival"; readonly characterId: string }
  // "The DM considers…": the round is held after the Planner failed.
  | { readonly kind: "dmHolding"; readonly roundNumber: number }
  | { readonly kind: "organizerNotice"; readonly notice: "plannerFailed"; readonly roundNumber: number }
  // Combat: template result lines and the combat card, no model call.
  | { readonly kind: "encounterStarted"; readonly encounterId: string }
  | { readonly kind: "combatTurn"; readonly encounterId: string; readonly combatantId: string }
  | { readonly kind: "attackRolled"; readonly encounterId: string; readonly attackId: string }
  // A hit waits for its target to answer with a reaction.
  | { readonly kind: "reactionOffered"; readonly encounterId: string; readonly attackId: string }
  // A landed hit waits for its attacker to answer the smite window.
  | { readonly kind: "smiteOffered"; readonly encounterId: string; readonly attackId: string }
  // A move waits for a provoker to say whether they take the opportunity attack.
  | { readonly kind: "opportunityAttackOffered"; readonly encounterId: string; readonly combatantId: string }
  | { readonly kind: "attackResolved"; readonly encounterId: string; readonly attackId: string }
  | { readonly kind: "deathSave"; readonly encounterId: string; readonly combatantId: string }
  // A turn action with no attack of its own: the table sees one template line.
  | { readonly kind: "combatBeat"; readonly encounterId: string; readonly combatantId: string; readonly beat: "dodge" | "dash" | "disengage" | "useItem" | "fled" | "reaction" | "counterspell" }
  // A combatant used tactical movement to reach a battlefield zone.
  | { readonly kind: "combatMove"; readonly encounterId: string; readonly combatantId: string; readonly zoneName: string }
  | { readonly kind: "encounterEnded"; readonly encounterId: string }
  // A line an authored trigger shows the table mid-fight (a new foe steps out of the mist).
  | { readonly kind: "fightNotice"; readonly encounterId: string; readonly text: string }
  // A line the story shows the table (an authored notice, once).
  | { readonly kind: "storyNotice"; readonly text: string }
  // A clue the party has just found: the adventure's own words for it.
  | { readonly kind: "clueFound"; readonly text: string }
  // An away player's seat was freed by the organizer; the hero's name, when there was one.
  | { readonly kind: "seatFreed"; readonly name: string | null }
  // Gold and items an authored reward gave the party (the loot event tells what).
  | { readonly kind: "rewardFound"; readonly rewardId: string }
  // A story object joined the party's belongings.
  | { readonly kind: "keepsakeGained"; readonly keepsakeId: string }
  // A hero paid for what the story sold.
  | { readonly kind: "paymentMade"; readonly characterId: string; readonly amount: number }
  | { readonly kind: "combatNarration"; readonly encounterId: string; readonly round: number }
  // A trade offer waits for the other hero's owner.
  | { readonly kind: "itemOffered"; readonly offerId: string }
  // A shop trade's NPC reaction is ready.
  | { readonly kind: "tradeNarrated"; readonly tradeId: string }
  // A conversation's NPC reply is ready.
  | { readonly kind: "dialogueNarrated"; readonly dialogueId: string }
  // A ritual spell's outside-combat effect is ready.
  | { readonly kind: "utilityCastNarrated"; readonly castId: string }
  // A hazard's Narrator line is ready.
  | { readonly kind: "hazardNarrated"; readonly hazardId: string }
  // A healing spell cast outside combat has landed; the presenter tells it from the saved event.
  | { readonly kind: "healingSettled"; readonly healingId: string }
  // Damage between fights has landed (a fall, drowning); the presenter tells it from the saved event.
  | { readonly kind: "environmentalDamage"; readonly damageId: string };
