import type { PlannerAction, PlannerProposal, PlannerRequest } from "../ports/dm-ports.js";

// When the planner model keeps failing, the round is not held for the organizer: this plans it without a model, so play goes on.
// It is deliberately plain. Every action is taken at face value with no story effect, except where it clearly matches an authored
// interaction, in which case it is planned as an attempt at that interaction (the engine then rolls the interaction's own check and applies
// its own results). Nothing is invented: the only story the fallback can touch is what the adventure already wrote.

// The words of a phrase for comparing two of them: letters and numbers only, then pairs of neighbouring characters, which suits both
// English and Chinese without a word list.
function pairs(text: string): ReadonlySet<string> {
  const clean = text.toLowerCase().replace(/[（(][^）)]*[）)]/g, " ").replace(/[^\p{L}\p{N}]+/gu, "");
  const out = new Set<string>();
  for (let index = 0; index + 1 < clean.length; index += 1) out.add(clean.slice(index, index + 2));
  return out;
}

// How much of the label the player's words cover (0 to 1): a player's action is usually longer than the label, so the share of the label's
// pairs found in the action is what says they mean it.
function coverage(action: string, label: string): number {
  const wanted = pairs(label);
  if (wanted.size === 0) return 0;
  const said = pairs(action);
  let found = 0;
  for (const pair of wanted) if (said.has(pair)) found += 1;
  return found / wanted.size;
}

const matchThreshold = 0.5;

export function fallbackPlan(request: PlannerRequest): PlannerProposal {
  const taken = new Set<string>();
  const actions: PlannerAction[] = request.actions.map((action) => {
    const scored = (request.story.interactions ?? [])
      .filter((interaction) => interaction.sceneId === request.story.sceneId && !taken.has(interaction.id))
      .map((interaction) => ({ interaction, score: coverage(action.text, interaction.label) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    // A clear winner only: two interactions that fit equally well are a guess, and a guess is not applied.
    if (best !== undefined && best.score >= matchThreshold && (second === undefined || best.score - second.score >= 0.15)) {
      taken.add(best.interaction.id);
      return { characterId: action.characterId, resolution: { kind: "automatic", reason: "Planned without the planner model: this matches an authored interaction." }, interactionId: best.interaction.id };
    }
    return { characterId: action.characterId, resolution: { kind: "automatic", reason: "Planned without the planner model: the action is taken as stated, with no story effect." } };
  });
  return { roundNumber: request.roundNumber, actions, effects: [] };
}
