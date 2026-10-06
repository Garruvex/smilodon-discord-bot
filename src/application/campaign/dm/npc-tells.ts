import type { AdventureBible, BibleNpc } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";

// What an NPC gives up when asked (see BibleNpc.tells). The adventure decides, not the model: a tell is given when the question names one of its
// topics, or at once when it lists none. Clues the party already has are not told again. The narrator only voices the fact.
export interface NpcTell {
  readonly clueId: string;
  readonly text: string;
}

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, "");

export function tellsFor(npc: BibleNpc | undefined, question: string | null, state: CampaignState, bible: AdventureBible): readonly NpcTell[] {
  if (npc?.tells === undefined || question === null) return [];
  const asked = norm(question);
  return npc.tells.flatMap((tell) => {
    if (state.clues.some((known) => known.id === tell.clue)) return [];
    const clue = bible.clues.find((candidate) => candidate.id === tell.clue);
    if (clue === undefined) return [];
    const named = tell.topics === undefined || tell.topics.length === 0 || tell.topics.some((topic) => asked.includes(norm(topic)) && norm(topic).length > 0);
    return named ? [{ clueId: clue.id, text: clue.publicText }] : [];
  });
}
