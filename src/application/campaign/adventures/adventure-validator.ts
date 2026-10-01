import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { AdventureDocumentError, checkAdventureContent, parseAdventureDocument, type AdventureDocument } from "./adventure-document.js";
import { rehearseEncounter, type RehearsalResult } from "./adventure-smoke.js";

// Plan §3, Campaign source: both ways in (an uploaded file, or one the
// Adventure Author writes) run the same checks before anyone may play it.
export const adventureLimits = {
  maxBytes: 200_000,
  maxScenes: 30,
  maxNpcs: 40,
  maxEncounters: 20,
  maxInteractions: 120,
  // Any one text field: a scene description, a note, a secret.
  maxTextChars: 4_000,
} as const;

export interface AdventureReport {
  // Nothing stands in the way of approving it.
  readonly ok: boolean;
  // Why it cannot be played. Empty when ok.
  readonly errors: readonly string[];
  // Worth a look, not a reason to refuse.
  readonly warnings: readonly string[];
  readonly document: AdventureDocument | null;
  // One rehearsal of every fight per seed, when the adventure got that far.
  readonly rehearsals: readonly RehearsalResult[];
}

const rehearsalSeeds = [1, 2, 3] as const;
const maxReported = 25;

// The checks, in order, stopping at the first stage that fails so a person is
// not shown a wall of consequences of one mistake: size, shape and
// cross-references (the strict schema), the limits, the ruleset content (an
// adventure can only use monsters, items and spells the ruleset has), and a
// headless rehearsal of every fight.
export function validateAdventure(source: string, content: SealedContent): AdventureReport {
  const failed = (errors: readonly string[]): AdventureReport => ({ ok: false, errors: errors.slice(0, maxReported), warnings: [], document: null, rehearsals: [] });
  if (Buffer.byteLength(source, "utf8") > adventureLimits.maxBytes) return failed([`The file is larger than ${adventureLimits.maxBytes / 1000} KB.`]);

  let document: AdventureDocument;
  try {
    document = parseAdventureDocument(source);
  } catch (error) {
    if (error instanceof AdventureDocumentError) return failed(error.problems);
    throw error;
  }

  const limits = limitProblems(document);
  if (limits.length > 0) return failed(limits);
  const contentProblems = checkAdventureContent(document, content);
  if (contentProblems.length > 0) return failed(contentProblems);

  const rehearsals = document.bible.encounters.flatMap((encounter) => rehearsalSeeds.map((seed) => rehearseEncounter(document, encounter, content, seed)));
  const errors = [...new Set(rehearsals.flatMap((rehearsal) => (rehearsal.problem === null ? [] : [`${rehearsal.encounterId} cannot be played: ${rehearsal.problem}`])))];
  const warnings: string[] = [];
  for (const encounter of document.bible.encounters) {
    const mine = rehearsals.filter((rehearsal) => rehearsal.encounterId === encounter.id && rehearsal.problem === null);
    if (mine.length > 0 && mine.every((rehearsal) => rehearsal.outcome === "defeat")) warnings.push(`${encounter.id} defeated the adventure's own heroes in every rehearsal; it may be too hard.`);
  }
  if (document.bible.encounters.length === 0) warnings.push("The adventure has no fights.");
  warnings.push(...routeWarnings(document));
  return { ok: errors.length === 0, errors: errors.slice(0, maxReported), warnings, document, rehearsals };
}

// Only an adventure that lists exits somewhere has routes to check: a scene with no exits lets the party go anywhere. Warnings, not errors,
// because some stories are linear on purpose (a train, a dream, a one-way descent).
export function routeWarnings(document: AdventureDocument): readonly string[] {
  const { scenes, startScene } = document.bible;
  if (!scenes.some((scene) => scene.exits !== undefined)) return [];
  const byId = new Map(scenes.map((scene) => [scene.id as string, scene]));
  // An authored goto (a fight's victory, an interaction's result) takes the party there whatever the exits say.
  const jumps = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (record["kind"] === "goto" && typeof record["scene"] === "string") jumps.add(record["scene"]);
      Object.values(record).forEach(collect);
    }
  };
  collect(document.bible);
  const reached = new Set<string>([startScene, ...jumps]);
  const queue = [...reached];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const scene = byId.get(next);
    const targets = scene?.exits === undefined ? scenes.map((other) => other.id as string) : scene.exits.map((exit) => exit.to as string);
    for (const target of targets) {
      if (reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  const warnings: string[] = [];
  for (const scene of scenes) {
    if (!reached.has(scene.id)) warnings.push(`${scene.id} cannot be reached from the start scene by its exits.`);
    if (scene.exits?.length === 0) warnings.push(`${scene.id} has no way out; the party would be stuck there.`);
  }
  for (const scene of document.bible.linear === true ? [] : scenes) {
    for (const exit of scene.exits ?? []) {
      const there = byId.get(exit.to);
      if (there?.exits !== undefined && there.exits.length > 0 && !there.exits.some((back) => back.to === scene.id)) warnings.push(`${scene.id} leads to ${exit.to}, but there is no way back.`);
    }
  }
  return warnings;
}

function limitProblems(document: AdventureDocument): readonly string[] {
  const { bible } = document;
  const problems: string[] = [];
  // The version is part of the key an approval names, so it stays short and plain.
  if (bible.id.length > 40) problems.push("The adventure's id may be at most 40 characters.");
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(bible.version)) problems.push("The version must be 1 to 20 letters, digits, dots, dashes or underscores.");
  if (bible.scenes.length > adventureLimits.maxScenes) problems.push(`An adventure may have at most ${adventureLimits.maxScenes} scenes.`);
  if (bible.npcs.length > adventureLimits.maxNpcs) problems.push(`An adventure may have at most ${adventureLimits.maxNpcs} NPCs.`);
  if ((bible.interactions ?? []).length > adventureLimits.maxInteractions) problems.push(`An adventure may have at most ${adventureLimits.maxInteractions} interactions.`);
  if (bible.encounters.length > adventureLimits.maxEncounters) problems.push(`An adventure may have at most ${adventureLimits.maxEncounters} fights.`);
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if ([...value].length > adventureLimits.maxTextChars) problems.push(`${path} is longer than ${adventureLimits.maxTextChars} characters.`);
    } else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    else if (typeof value === "object" && value !== null) for (const [key, entry] of Object.entries(value)) walk(entry, path === "" ? key : `${path}.${key}`);
  };
  walk(document.bible, "");
  return problems;
}

// What the organizer may read before approving: nothing from the DM's notes,
// the overview, an NPC's secret, or a clue's notes.
export interface AdventurePreview {
  readonly title: string;
  readonly language: string;
  readonly premise: string;
  readonly scenes: readonly string[];
  readonly npcs: readonly { readonly name: string; readonly description: string }[];
  readonly encounters: readonly { readonly scene: string; readonly description: string; readonly monsters: readonly { readonly id: string; readonly count: number }[] }[];
  readonly heroes: readonly { readonly name: string; readonly className: string }[];
}

export function adventurePreview(document: AdventureDocument): AdventurePreview {
  const { bible } = document;
  const sceneTitle = (id: string): string => bible.scenes.find((scene) => scene.id === id)?.title ?? id;
  return {
    title: bible.title,
    language: bible.language,
    premise: bible.premise,
    scenes: bible.scenes.map((scene) => scene.title),
    npcs: bible.npcs.map((npc) => ({ name: npc.name, description: npc.publicDescription })),
    encounters: bible.encounters.map((encounter) => {
      const counts = new Map<string, number>();
      for (const monster of encounter.monsters) counts.set(monster.monsterId, (counts.get(monster.monsterId) ?? 0) + 1);
      return { scene: sceneTitle(encounter.sceneId), description: encounter.publicDescription, monsters: [...counts].map(([id, count]) => ({ id, count })) };
    }),
    heroes: document.heroes.map((hero) => ({ name: hero.name, className: hero.class })),
  };
}
