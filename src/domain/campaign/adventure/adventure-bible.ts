import type { EncounterMonster, EncounterSpec } from "../commands/campaign-command.js";

// The adventure as authored (plan §6, layer B). Fields are split by who may
// see them: public fields can reach narration; dmOverview, dmNotes, and
// secrets go only to the Planner and never to the Narrator.
export type CampaignLanguage = "en" | "zh-TW";

export type SceneId = `scene:${string}`;
export type NpcId = `npc:${string}`;
export type EncounterId = `encounter:${string}`;

export interface AdventureBible {
  readonly id: string;
  readonly version: string;
  readonly language: CampaignLanguage;
  readonly title: string;
  readonly premise: string;
  readonly dmOverview: string;
  readonly startScene: SceneId;
  readonly scenes: readonly BibleScene[];
  readonly npcs: readonly BibleNpc[];
  readonly encounters: readonly BibleEncounter[];
}

export interface BibleScene {
  readonly id: SceneId;
  readonly title: string;
  readonly publicDescription: string;
  readonly dmNotes: string;
  // NPCs present in the scene.
  readonly npcIds: readonly NpcId[];
}

export interface BibleNpc {
  readonly id: NpcId;
  readonly name: string;
  // How the NPC talks, so narration keeps a consistent voice.
  readonly voice: string;
  readonly publicDescription: string;
  readonly secret: string;
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
}

export function findScene(bible: AdventureBible, sceneId: string | null): BibleScene | undefined {
  return bible.scenes.find((scene) => scene.id === sceneId);
}

export function findEncounter(bible: AdventureBible, encounterId: string | null): BibleEncounter | undefined {
  return bible.encounters.find((encounter) => encounter.id === encounterId);
}

export function encounterSpec(encounter: BibleEncounter): EncounterSpec {
  const { id, zones, edges, partyZoneId, monsters } = encounter;
  return { id, zones, edges, partyZoneId, monsters };
}
