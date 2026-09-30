import type { EncounterMonster, EncounterSpec } from "../commands/campaign-command.js";
import type { ContentId } from "../rules/content-id.js";
import type { Ability } from "../rules/effects.js";

// The adventure as authored (plan §6, layer B). Fields are split by who may
// see them: public fields can reach narration; dmOverview, dmNotes, and
// secrets go only to the Planner and never to the Narrator.
export type CampaignLanguage = "en" | "zh-TW";

export type SceneId = `scene:${string}`;
export type NpcId = `npc:${string}`;
export type EncounterId = `encounter:${string}`;
export type ClockId = `clock:${string}`;
export type ClueId = `clue:${string}`;
export type InteractionId = `interaction:${string}`;

export interface AdventureBible {
  readonly id: string;
  readonly version: string;
  readonly language: CampaignLanguage;
  readonly title: string;
  readonly premise: string;
  // The level the adventure is written for. Absent: level 1. The table's
  // starting-level rule can override it; everyone is brought up to the result.
  readonly startingLevel?: number;
  readonly dmOverview: string;
  readonly startScene: SceneId;
  readonly scenes: readonly BibleScene[];
  readonly npcs: readonly BibleNpc[];
  readonly encounters: readonly BibleEncounter[];
  readonly clocks: readonly BibleClock[];
  readonly clues: readonly BibleClue[];
  // What the party can do in each scene, as the engine plays it (see BibleInteraction). Absent: the Planner improvises from the notes alone.
  readonly interactions?: readonly BibleInteraction[];
}

// What the engine can do when a story beat lands. The same few words serve every scene, check and fight, so an adventure is data and
// never code: the Planner picks which interaction the players are attempting, and the engine rolls it and applies these.
export type BibleEffect =
  | { readonly kind: "reveal"; readonly clue: ClueId }
  // Sets a story flag (value 1 unless given) that interactions and exits can require.
  | { readonly kind: "set"; readonly flag: string; readonly value?: number }
  | { readonly kind: "reward"; readonly gold?: number; readonly items?: readonly ContentId<"item">[] }
  | { readonly kind: "goto"; readonly scene: SceneId }
  | { readonly kind: "encounter"; readonly encounter: EncounterId }
  | { readonly kind: "clock"; readonly clock: ClockId; readonly by: number };

// What must hold before an interaction or an exit is available. Every listed condition must hold.
export interface BibleRequirement {
  readonly clues?: readonly ClueId[];
  // Story flags that must be set, and flags that must not be.
  readonly flags?: readonly string[];
  readonly notFlags?: readonly string[];
}

// Something the players can attempt in a scene: an authored check (or none) and what follows. The label says what the players are doing
// in plain words, and the notes tell the Planner when it applies; neither reaches the Narrator.
export interface BibleInteraction {
  readonly id: InteractionId;
  readonly sceneId: SceneId;
  readonly label: string;
  readonly dmNotes: string;
  // Absent: it happens on its own (talking to someone who is willing, taking what is offered).
  readonly check: { readonly skill?: string; readonly ability?: Ability; readonly dc: number } | null;
  readonly requires: BibleRequirement;
  // Gold the hero pays for it; they must have it.
  readonly pay: number;
  // How many times the party may try it (normal play: once, unless the situation changes).
  readonly attempts: number;
  readonly onSuccess: readonly BibleEffect[];
  readonly onFailure: readonly BibleEffect[];
  // Extra results for a roll that reaches a higher total; each tier's effects join the success ones. Ascending by dc.
  readonly tiers: readonly { readonly dc: number; readonly effects: readonly BibleEffect[] }[];
}

export const interactionsOf = (bible: AdventureBible): readonly BibleInteraction[] => bible.interactions ?? [];

// A skill-challenge clock (plan §5): the Planner advances it when failure or
// noise costs the party time; when it fills, the authored fight begins.
export interface BibleClock {
  readonly id: ClockId;
  readonly sceneId: SceneId;
  readonly name: string;
  readonly segments: number;
  // When and why to advance it; Planner only.
  readonly dmNotes: string;
  readonly onFull: EncounterId | null;
}

// Something the party can learn. The public text may reach narration once
// the clue is revealed; the notes say when to reveal it.
export interface BibleClue {
  readonly id: ClueId;
  readonly sceneId: SceneId;
  readonly publicText: string;
  readonly dmNotes: string;
}

export interface BibleScene {
  readonly id: SceneId;
  readonly title: string;
  readonly publicDescription: string;
  readonly dmNotes: string;
  // NPCs present in the scene.
  readonly npcIds: readonly NpcId[];
  // Where the party can go from here. Absent: anywhere the Planner sends them.
  readonly exits?: readonly { readonly to: SceneId; readonly requires?: BibleRequirement }[];
}

export interface BibleNpc {
  readonly id: NpcId;
  readonly name: string;
  // How the NPC talks, so narration keeps a consistent voice.
  readonly voice: string;
  readonly publicDescription: string;
  readonly secret: string;
  // Present when this NPC trades. Prices are gold, authored (items carry no
  // inherent value of their own — engine/shop.ts's buyItem/sellItem/hagglePrice
  // never invent one). sellPrice absent means this NPC won't buy that item back.
  readonly shop?: { readonly stock: readonly ShopStock[] };
}

export interface ShopStock {
  readonly itemId: ContentId<"item">;
  readonly buyPrice: number;
  readonly sellPrice?: number;
}

// An authored fight. The Planner may start it by ID (plan §6, "start
// encounter ID"); the map and roster come from here, never from the model.
export interface BibleEncounter {
  readonly id: EncounterId;
  readonly sceneId: SceneId;
  // What the table sees as the fight breaks out.
  readonly publicDescription: string;
  // When to start it; Planner only.
  readonly dmNotes: string;
  readonly zones: readonly { readonly id: string; readonly name: string }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly feet: number }[];
  readonly partyZoneId: string;
  readonly monsters: readonly EncounterMonster[];
  // Found by the party on a victory.
  readonly loot: readonly ContentId<"item">[];
  readonly gold: number;
  // Winning this fight is a story milestone: at a milestone table the party is
  // raised to this level. An experience table ignores it.
  readonly milestoneLevel?: number;
}

export function findScene(bible: AdventureBible, sceneId: string | null): BibleScene | undefined {
  return bible.scenes.find((scene) => scene.id === sceneId);
}

export function findEncounter(bible: AdventureBible, encounterId: string | null): BibleEncounter | undefined {
  return bible.encounters.find((encounter) => encounter.id === encounterId);
}

export function findNpc(bible: AdventureBible, npcId: string): BibleNpc | undefined {
  return bible.npcs.find((npc) => npc.id === npcId);
}

export function findClock(bible: AdventureBible, clockId: string): BibleClock | undefined {
  return bible.clocks.find((clock) => clock.id === clockId);
}

export function findClue(bible: AdventureBible, clueId: string): BibleClue | undefined {
  return bible.clues.find((clue) => clue.id === clueId);
}

export function encounterSpec(encounter: BibleEncounter): EncounterSpec {
  const { id, zones, edges, partyZoneId, monsters, loot, gold, milestoneLevel } = encounter;
  return { id, zones, edges, partyZoneId, monsters, loot, gold, ...(milestoneLevel === undefined ? {} : { milestoneLevel }) };
}
