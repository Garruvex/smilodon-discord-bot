import { findScene, type AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CheckTest } from "../../../domain/campaign/character/character-sheet.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import type { Combatant, CombatantCondition, EncounterState } from "../../../domain/campaign/combat/combat-state.js";
import { combatantName, encounterRecords, type CombatTargetResult } from "../dm/combat-records.js";

// The story as the Activity shows it: what the table has already read in the Adventure channel, rebuilt from the event log, newest last. Public
// only (the Narrator's tellings, what heroes did and said, the visible results of a fight): nothing from a private summary, the DM's notes or a
// hidden roll can be here, because only these public event kinds are read.
export type StoryEntry =
  // round: the exploration round it was told for (absent for a fight's). clipped: an older telling cut short to keep the snapshot small; the whole text is in the Adventure channel.
  | { readonly id: string; readonly kind: "narration"; readonly text: string; readonly round?: number; readonly clipped?: true }
  | { readonly id: string; readonly kind: "action"; readonly who: string; readonly text: string }
  | { readonly id: string; readonly kind: "speech"; readonly who: string; readonly text: string }
  | { readonly id: string; readonly kind: "clue"; readonly text: string }
  // A spell cast between fights: who cast what, then the Narrator's telling of it (the same two parts the channel posts).
  // A hero speaking with an NPC: the question asked, or the press and its roll, then the Narrator's telling of the answer.
  | { readonly id: string; readonly kind: "talk"; readonly who: string; readonly npc: string; readonly question: string | null; readonly roll: { readonly test: CheckTest; readonly total: number; readonly dc: number; readonly success: boolean } | null; readonly text: string }
  | { readonly id: string; readonly kind: "cast"; readonly who: string; readonly spell: string; readonly text: string }
  // A check the table saw rolled: the total against the DC. A natural 20 or 1 on a check changes nothing by itself, so the result is only total against DC.
  | { readonly id: string; readonly kind: "roll"; readonly who: string; readonly test: CheckTest; readonly total: number; readonly dc: number; readonly success: boolean }
  // A place change, the start of a fight or its end: the client words it.
  | { readonly id: string; readonly kind: "system"; readonly code: "scene" | "combatBegins" | "victory" | "defeat"; readonly text: string | null }
  | { readonly id: string; readonly kind: "combat"; readonly who: string; readonly using: string; readonly source: "weapon" | "spell" | "area" | "item" | "feature"; readonly opportunity: boolean; readonly targets: readonly StoryTarget[] }
  // The turn-by-turn moments of a fight that are not an attack or a spell.
  | { readonly id: string; readonly kind: "maneuver"; readonly who: string; readonly maneuver: "dash" | "dodge" | "disengage" | "giveItem" | "useItem" }
  | { readonly id: string; readonly kind: "move"; readonly who: string; readonly zone: string }
  | { readonly id: string; readonly kind: "fled"; readonly who: string }
  | { readonly id: string; readonly kind: "deathSave"; readonly who: string; readonly natural: number; readonly condition: CombatantCondition }
  // A hero going down, or a foe falling: the moments the Activity may call out.
  | { readonly id: string; readonly kind: "alert"; readonly tone: "down" | "slain"; readonly name: string };

export interface StoryTarget {
  readonly name: string;
  readonly check: CombatTargetResult["check"];
  readonly damage: number;
  readonly heal: number;
  readonly prone: boolean;
}

// The latest entries a snapshot carries, by their size: the current and the last round in full, older tellings cut to their opening, and the whole bounded so a long game does not bloat every snapshot.
export const storyBudget = 14000;
export const storyMinimum = 12;
// Tellings older than this many rounds behind the current one are cut to their opening.
const fullRounds = 1;
const clippedLength = 280;

const weight = (entry: StoryEntry): number => ("text" in entry && entry.text !== null ? entry.text.length : 0) + 80;

interface Placed {
  readonly order: number;
  entry: StoryEntry;
}

export function buildActivityStory(state: CampaignState, events: readonly CampaignEvent[], bible: AdventureBible, glossary: Glossary): readonly StoryEntry[] {
  const placed: Placed[] = [];
  const add = (order: number, entry: StoryEntry): void => { placed.push({ order, entry }); };
  const heroName = (id: string): string => state.characters[id]?.name ?? id;
  // A hero's wording for a round may be replaced; the entry keeps its place and takes the newest words.
  const actionAt = new Map<string, Placed>();
  const casts = new Map<string, { who: string; spell: string }>();
  const talks = new Map<string, Omit<Extract<StoryEntry, { kind: "talk" }>, "id" | "kind" | "text">>();

  const narrate = (index: number, text: string, round?: number): void => {
    const trimmed = text.trim();
    if (trimmed.length > 0) add(index, { id: `e${index}`, kind: "narration", text: trimmed, ...(round === undefined ? {} : { round }) });
  };

  // Where each declared fight action sits in the log, so its result line can be put in order with the rest.
  const declaredAt = new Map<string, number>();
  events.forEach((event, index) => { if (event.kind === "resolutionDeclared") declaredAt.set(event.resolution.id, index); });

  // The fight being told, to put names to its combatants and zones.
  let encounter: EncounterState | null = null;
  const names = { state, bible, glossary };
  const combatantOf = (id: string): string => {
    const combatant: Combatant | undefined = encounter?.combatants[id];
    return combatant === undefined ? id : combatantName(combatant, names);
  };

  events.forEach((event, index) => {
    switch (event.kind) {
      case "narrationRecorded":
        narrate(index, event.text, event.roundNumber);
        break;
      case "openingRecorded":
        narrate(index, event.text, 0);
        break;
      case "dialogueSettled": {
        const { dialogue } = event;
        const check = dialogue.kind === "press" ? dialogue.check : null;
        talks.set(dialogue.id, {
          who: heroName(dialogue.characterId),
          npc: bible.npcs.find((npc) => npc.id === dialogue.npcId)?.name ?? dialogue.npcId,
          question: dialogue.kind === "ask" || check === null ? dialogue.question : null,
          roll: check === null ? null : { test: check.test, total: check.total, dc: check.dc, success: check.success },
        });
        break;
      }
      case "dialogueNarrated": {
        const talk = talks.get(event.dialogueId);
        const told = event.text.trim();
        if (talk === undefined) narrate(index, event.text);
        else if (told.length > 0) add(index, { id: `e${index}`, kind: "talk", ...talk, text: told });
        break;
      }
      case "utilitySpellCast":
        casts.set(event.cast.id, { who: heroName(event.cast.characterId), spell: glossary.names[event.cast.spellId] ?? event.cast.spellId });
        break;
      case "utilityCastNarrated": {
        const cast = casts.get(event.castId);
        const told = event.text.trim();
        if (cast === undefined) narrate(index, event.text);
        else if (told.length > 0) add(index, { id: `e${index}`, kind: "cast", ...cast, text: told });
        break;
      }
      case "combatNarrationRecorded":
      case "tradeNarrated":
      case "hazardNarrated":
        narrate(index, event.text);
        break;
      case "actionSubmitted": {
        const key = `${event.roundNumber}:${event.characterId}`;
        const text = event.text.trim();
        const found = actionAt.get(key);
        if (found !== undefined && found.entry.kind === "action") found.entry = { ...found.entry, text };
        else if (text.length > 0) {
          const item: Placed = { order: index, entry: { id: `e${index}`, kind: "action", who: heroName(event.characterId), text } };
          actionAt.set(key, item);
          placed.push(item);
        }
        break;
      }
      case "heroSpoke":
        if (event.text.trim().length > 0) add(index, { id: `e${index}`, kind: "speech", who: heroName(event.characterId), text: event.text.trim() });
        break;
      case "checkResolved": {
        const check = state.checks[event.checkId];
        if (check !== undefined) add(index, { id: `e${index}`, kind: "roll", who: heroName(check.characterId), test: check.test, total: event.result.roll.total, dc: check.dc, success: event.result.success });
        break;
      }
      case "clueRevealed":
        add(index, { id: `e${index}`, kind: "clue", text: event.text });
        break;
      case "sceneTransitioned":
        add(index, { id: `e${index}`, kind: "system", code: "scene", text: findScene(bible, event.sceneId)?.title ?? null });
        break;
      case "encounterStarted":
        encounter = event.encounter;
        add(index, { id: `e${index}`, kind: "system", code: "combatBegins", text: null });
        break;
      case "encounterEnded":
        add(index, { id: `e${index}`, kind: "system", code: event.outcome, text: null });
        break;
      case "actionTaken":
        add(index, { id: `e${index}`, kind: "maneuver", who: combatantOf(event.combatantId), maneuver: event.action });
        break;
      case "combatantMoved":
        add(index, { id: `e${index}`, kind: "move", who: combatantOf(event.combatantId), zone: encounter?.zones.find((zone) => zone.id === event.zoneId)?.name ?? event.zoneId });
        break;
      case "combatantFled":
        add(index, { id: `e${index}`, kind: "fled", who: combatantOf(event.combatantId) });
        break;
      case "deathSaveRolled":
        add(index, { id: `e${index}`, kind: "deathSave", who: combatantOf(event.combatantId), natural: event.roll.d20.natural, condition: event.condition });
        break;
      default:
        break;
    }
  });

  // What a fight action did, with who it hit and who went down.
  const heroNames = new Set(Object.values(state.characters).map((sheet) => sheet.name));
  for (const encounter of encounterRecords(events, { state, bible, glossary })) {
    for (const round of encounter.rounds) {
      for (const beat of round.beats) {
        if (beat.kind !== "action" || beat.resolutionId === undefined) continue;
        const at = declaredAt.get(beat.resolutionId);
        if (at === undefined) continue;
        const id = `c${at}`;
        add(at + 0.5, {
          id,
          kind: "combat",
          who: beat.actor,
          using: beat.using,
          source: beat.sourceKind ?? "weapon",
          opportunity: beat.opportunity,
          targets: beat.targets.map((target) => ({ name: target.name, check: target.check, damage: Math.max(0, -target.hpChange), heal: Math.max(0, target.hpChange), prone: target.knockedProne })),
        });
        beat.targets.forEach((target, n) => {
          if (target.condition === "dead" || target.condition === "unconscious") {
            const hero = heroNames.has(target.name);
            add(at + 0.6 + n / 1000, { id: `${id}a${n}`, kind: "alert", tone: hero ? "down" : target.condition === "dead" ? "slain" : "down", name: target.name });
          }
        });
      }
    }
  }

  const sorted = placed.sort((left, right) => left.order - right.order).map((item) => item.entry);
  // Older tellings give way first: cut to their opening, then dropped from the front once the whole is over budget.
  const current = state.lastRoundNumber;
  const shaped = sorted.map((entry) => entry.kind === "narration" && entry.round !== undefined && entry.round > 0 && entry.round < current - fullRounds && entry.text.length > clippedLength
    ? { ...entry, text: `${entry.text.slice(0, clippedLength - 1).trimEnd()}…`, clipped: true as const }
    : entry);
  let size = 0;
  let start = shaped.length;
  while (start > 0 && (shaped.length - start < storyMinimum || size + weight(shaped[start - 1]!) <= storyBudget)) {
    start -= 1;
    size += weight(shaped[start]!);
  }
  return shaped.slice(start);
}
