import type { DialogueCommand } from "../commands/campaign-command.js";
import { checkModifier, isSkill, type CheckTest } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import { resolveD20Test, rollMatchesSpec } from "../dice/d20-test.js";
import { classifyRollMoments } from "../dice/roll-moments.js";
import { resolveRollMode } from "../dice/roll.js";
import type { RollResult } from "../dice/roll-spec.js";
import { dcLadder } from "../rules/difficulty.js";
import { naturalRollsOnChecks } from "../rules/house-rules.js";
import { isFallen, type DialogueRecord, type PendingPress } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Talking to an NPC outside combat. askNpc is a free question, always
// answered — the Narrator is only ever given what the adventure authored as
// that NPC's public line (adventure-bible.ts's BibleNpc.publicDescription),
// never asked to invent lore. pressNpc goes after the NPC's authored secret,
// and that is a real Insight, Persuasion, Deception, or Intimidation check
// against a fixed DC: dice decide whether it gives anything up, the same
// "dice decide, the model only narrates" rule engine/shop.ts's haggling
// already follows for prices.
export function handleDialogueCommand(decision: Decision, command: DialogueCommand): Rejection | null {
  switch (command.kind) {
    case "askNpc":
      return askNpc(decision, command.characterId, command.npcId, command.question);
    case "pressNpc":
      return pressNpc(decision, command);
    case "recordDialogueNarration":
      return recordDialogueNarration(decision, command.dialogueId, command.text);
  }
}

// The skills SRD 5.1 actually offers for reading or wearing down a reluctant NPC.
const pressSkills = ["persuasion", "deception", "intimidation", "insight"] as const;
export const maxQuestionLength = 1000;

function mayTalk(decision: Decision, characterId: CharacterId, npcId: DialogueRecord["npcId"]): Rejection | null {
  const { state, ctx } = decision;
  if (state.npcsDown?.includes(npcId) === true) return { code: "npcDown" };
  if (ctx.actor.kind !== "user" || state.characters[characterId]?.ownerUserId !== ctx.actor.userId) return { code: "notYourCharacter" };
  if (isFallen(state, characterId)) return { code: "heroFallen" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  return null;
}

function askNpc(decision: Decision, characterId: CharacterId, npcId: DialogueRecord["npcId"], question: string): Rejection | null {
  const refusal = mayTalk(decision, characterId, npcId);
  if (refusal !== null) return refusal;
  if (Object.values(decision.state.dialogues).some((dialogue) => dialogue.characterId === characterId) || decision.state.pressPending?.[characterId] !== undefined) return { code: "dialoguePending" };
  const trimmed = question.trim();
  if (trimmed.length === 0) return { code: "emptyAction" };
  if (trimmed.length > maxQuestionLength) return { code: "actionTooLong", maxLength: maxQuestionLength };
  const dialogue: DialogueRecord = {
    id: `dialogue:${decision.state.dialogueCount + 1}`,
    characterId,
    npcId,
    kind: "ask",
    question: trimmed,
    check: null,
  };
  settleDialogue(decision, dialogue);
  return null;
}

function pressNpc(decision: Decision, command: Extract<DialogueCommand, { kind: "pressNpc" }>): Rejection | null {
  const { characterId, npcId, skill } = command;
  const refusal = mayTalk(decision, characterId, npcId);
  if (refusal !== null) return refusal;
  const { state } = decision;
  if (!isSkill(skill) || !(pressSkills as readonly string[]).includes(skill)) return { code: "invalidPressSkill" };
  if (state.pressPending?.[characterId] !== undefined) return { code: "pressAlreadyPending" };
  if (state.npcSecretsRevealed?.[npcId] === true) return { code: "secretAlreadyRevealed" };
  if (Object.values(state.dialogues).some((dialogue) => dialogue.characterId === characterId)) return { code: "dialoguePending" };
  const sheet = state.characters[characterId];
  if (sheet === undefined) return { code: "notYourCharacter" };

  const test: CheckTest = { kind: "skill", skill };
  // A secret is guarded harder than a shop's price: the SRD hard DC, not haggling's medium one.
  const dc = dcLadder.hard;
  // The same mechanical disadvantage every ability check carries at
  // Exhaustion 1+ (round-plan.ts and engine/shop.ts's haggle apply it too).
  const exhaustionPenalty = (state.heroStatus[characterId]?.exhaustion ?? 0) >= 1 ? 1 : 0;
  const press: PendingPress = {
    characterId,
    npcId,
    test,
    dc,
    spec: { mode: resolveRollMode(0, exhaustionPenalty), modifier: checkModifier(sheet, test), bonusDice: [] },
    rollId: `press:${characterId}:${state.dialogueCount + 1}`,
  };
  decision.emit({ kind: "pressStarted", press });
  decision.request({ kind: "roll", rollId: press.rollId, spec: { kind: "d20Test", spec: press.spec } });
  return null;
}

// The roll worker saved a result for a pending press (decide.ts's recordRoll
// dispatcher tries this after round-plan checks and a pending haggle). A
// success gives the party the NPC's authored secret for good; a failure
// gives up nothing, and the hero may try again later (no cooldown modeled).
export function recordPressRoll(decision: Decision, press: PendingPress, result: RollResult): Rejection | null {
  if (result.kind !== "d20Test" || !rollMatchesSpec(result.roll, press.spec)) return { code: "rollMismatch" };
  const { ctx, state } = decision;
  const naturalRule = ctx.rules.houseRules.option(naturalRollsOnChecks);
  const outcome = resolveD20Test("abilityCheck", result.roll.d20.natural, result.roll.total, press.dc, naturalRule);
  const moments = classifyRollMoments({ kind: "abilityCheck", roll: result.roll, target: press.dc, naturalRule });
  const dialogue: DialogueRecord = {
    id: `dialogue:${state.dialogueCount + 1}`,
    characterId: press.characterId,
    npcId: press.npcId,
    kind: "press",
    question: null,
    check: { test: press.test, dc: press.dc, total: result.roll.total, success: outcome.success, moments },
  };
  settleDialogue(decision, dialogue, outcome.success);
  return null;
}

// Records a settled conversation and queues the Narrator's line.
// `revealSecret`: only true for a press that just succeeded.
function settleDialogue(decision: Decision, dialogue: DialogueRecord, revealSecret = false): void {
  decision.emit({ kind: "dialogueSettled", dialogue, revealSecret });
  decision.request({ kind: "narrateDialogue", dialogueId: dialogue.id });
}

function recordDialogueNarration(decision: Decision, dialogueId: string, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "emptyNarration" };
  if (state.dialogues[dialogueId] === undefined) return { code: "staleNarration" };
  decision.emit({ kind: "dialogueNarrated", dialogueId, text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "dialogueNarrated", dialogueId } });
  return null;
}
