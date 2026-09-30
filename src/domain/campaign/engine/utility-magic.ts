import type { UtilityMagicCommand } from "../commands/campaign-command.js";
import { spellbookOf } from "../character/spell-access.js";
import type { CharacterId } from "../core/ids.js";
import type { UtilityCastRecord } from "../state/campaign-state.js";
import { summonCompanionRitual } from "./companion-magic.js";
import { mayCastOutsideCombat } from "./outside-combat.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Casting a spell outside a fight: a ritual (or a free cantrip), never a
// slotted spell timed against a fight's action economy. No roll, no
// mechanical Effect — a utility spell's `plan` (content-definitions.ts) is a
// narrative no-op; this file only checks the hero actually knows it and may
// cast it free, then hands the result to the Narrator, grounded in the same
// scene and ledger context every other narration gets (never a new fact the
// engine invents).
export function handleUtilityMagicCommand(decision: Decision, command: UtilityMagicCommand): Rejection | null {
  switch (command.kind) {
    case "castRitualSpell":
      return castRitualSpell(decision, command.characterId, command.spellId);
    case "recordUtilityCastNarration":
      return recordUtilityCastNarration(decision, command.castId, command.text);
  }
}

function castRitualSpell(decision: Decision, characterId: CharacterId, spellId: UtilityCastRecord["spellId"]): Rejection | null {
  const refusal = mayCastOutsideCombat(decision, characterId);
  if (refusal !== null) return refusal;
  // A ritual that calls a creature keeps it for the next fight; the rest is only told.
  const companion = summonCompanionRitual(decision, characterId, spellId);
  if (companion !== undefined) return companion;
  const { state, ctx } = decision;
  const spell = ctx.rules.content.find(spellId);
  const sheet = state.characters[characterId];
  // Same code combat casting uses for "not a real spell" and "not known" —
  // turn-rules.ts's spellSlotProblem doesn't split them either.
  if (spell?.kind !== "spell" || sheet === undefined || !spellbookOf(sheet, ctx.rules.content).includes(spellId)) return { code: "unknownSpell" };
  if (spell.level !== 0 && spell.ritual !== true) return { code: "notARitualSpell" };

  const cast: UtilityCastRecord = { id: `cast:${state.utilityCastCount + 1}`, characterId, spellId };
  decision.emit({ kind: "utilitySpellCast", cast });
  decision.request({ kind: "narrateUtilityCast", castId: cast.id });
  return null;
}

function recordUtilityCastNarration(decision: Decision, castId: string, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "emptyNarration" };
  if (state.utilityCasts[castId] === undefined) return { code: "staleNarration" };
  decision.emit({ kind: "utilityCastNarrated", castId, text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "utilityCastNarrated", castId } });
  return null;
}
