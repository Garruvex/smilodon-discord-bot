import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AdventureBible, ClockId, ClueId, EncounterId, NpcId, SceneId } from "../../../domain/campaign/adventure/adventure-bible.js";
import { isSkill, type CharacterSheet, type Skill, type SkillProficiency } from "../../../domain/campaign/character/character-sheet.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import { abilities } from "../../../domain/campaign/rules/effects.js";

// A ready-made hero shipped with an adventure. The owner is assigned when a
// player picks it.
export type PresetHero = Omit<CharacterSheet, "ownerUserId"> & { readonly class: string };

export interface AdventureDocument {
  readonly bible: AdventureBible;
  readonly heroes: readonly PresetHero[];
}

const sceneId = z.string().regex(/^scene:[a-z0-9-]+$/) as unknown as z.ZodType<SceneId>;
const npcId = z.string().regex(/^npc:[a-z0-9-]+$/) as unknown as z.ZodType<NpcId>;
const encounterId = z.string().regex(/^encounter:[a-z0-9-]+$/) as unknown as z.ZodType<EncounterId>;
const clockId = z.string().regex(/^clock:[a-z0-9-]+$/) as unknown as z.ZodType<ClockId>;
const clueId = z.string().regex(/^clue:[a-z0-9-]+$/) as unknown as z.ZodType<ClueId>;
const zoneId = z.string().regex(/^[a-z0-9-]+$/);
const text = z.string().trim().min(1);
function contentId<K extends "item" | "feature" | "spell" | "monster">(kind: K): z.ZodType<ContentId<K>> {
  return z.string().regex(new RegExp('^' + kind + ':[a-z0-9-]+$')) as unknown as z.ZodType<ContentId<K>>;
}
const abilityScore = z.number().int().min(1).max(30);

const documentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: text,
    language: z.enum(["en", "zh-TW"]),
    title: text,
    premise: text,
    dmOverview: text,
    startScene: sceneId,
    scenes: z
      .array(
        z.object({ id: sceneId, title: text, publicDescription: text, dmNotes: text, npcIds: z.array(npcId) }).strict(),
      )
      .min(1),
    npcs: z.array(z.object({ id: npcId, name: text, voice: text, publicDescription: text, secret: text }).strict()),
    clocks: z
      .array(
        z
          .object({ id: clockId, sceneId, name: text, segments: z.number().int().min(2).max(12), dmNotes: text, onFull: encounterId.nullable().default(null) })
          .strict(),
      )
      .default([]),
    clues: z.array(z.object({ id: clueId, sceneId, publicText: text, dmNotes: text }).strict()).default([]),
    encounters: z
      .array(
        z
          .object({
            id: encounterId,
            sceneId,
            publicDescription: text,
            dmNotes: text,
            zones: z.array(z.object({ id: zoneId, name: text }).strict()).min(1),
            edges: z.array(z.object({ from: zoneId, to: zoneId, feet: z.number().int().min(5) }).strict()),
            partyZoneId: zoneId,
            monsters: z
              .array(
                z
                  .object({
                    monsterId: contentId("monster"),
                    zoneId,
                    npcId: npcId.nullable().default(null),
                    fleeBelowHpFraction: z.number().gt(0).lt(1).nullable().default(null),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .default([]),
    heroes: z
      .array(
        z
          .object({
            id: z.string().regex(/^c-[a-z0-9-]+$/),
            name: text,
            class: text,
            abilityScores: z.object(Object.fromEntries(abilities.map((ability) => [ability, abilityScore]))).strict(),
            proficiencyBonus: z.number().int().min(2).max(6),
            skills: z.record(z.string(), z.enum(["proficient", "expertise"])),
            savingThrows: z.array(z.enum(abilities)),
            level: z.number().int().min(1).max(20),
            maxHp: z.number().int().min(1),
            hitDie: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
            speed: z.number().int().min(0),
            equipment: z.array(contentId("item")).min(1),
            features: z.array(contentId("feature")),
            spellcasting: z
              .object({
                ability: z.enum(abilities),
                spells: z.array(contentId("spell")),
                slots: z.record(z.string().regex(/^[1-9]$/), z.number().int().min(0)),
              })
              .strict()
              .nullable()
              .default(null),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export class AdventureDocumentError extends Error {
  public constructor(public readonly problems: readonly string[]) {
    super(`Invalid adventure document:\n- ${problems.join("\n- ")}`);
    this.name = "AdventureDocumentError";
  }
}

// Parses and validates one language edition. Shape errors come from zod;
// cross-references (scene NPCs, unique IDs, skills) are checked here, and
// every problem is reported at once.
export function parseAdventureDocument(source: string): AdventureDocument {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new AdventureDocumentError([`Unable to parse YAML: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdventureDocumentError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }
  const data = parsed.data;
  const problems: string[] = [];
  const npcIds = new Set(data.npcs.map((npc) => npc.id));
  problems.push(...duplicates("scene", data.scenes.map((scene) => scene.id)));
  problems.push(...duplicates("npc", data.npcs.map((npc) => npc.id)));
  problems.push(...duplicates("hero", data.heroes.map((hero) => hero.id)));
  if (!data.scenes.some((scene) => scene.id === data.startScene)) problems.push(`startScene ${data.startScene} is not a scene.`);
  for (const scene of data.scenes) {
    for (const id of scene.npcIds) if (!npcIds.has(id)) problems.push(`${scene.id} lists unknown ${id}.`);
  }
  // Monster IDs are checked against the ruleset when the fight starts; the
  // harness and the starter-adventure tests start every authored encounter.
  problems.push(...duplicates("encounter", data.encounters.map((encounter) => encounter.id)));
  const sceneIds = new Set(data.scenes.map((scene) => scene.id));
  const encounterIds = new Set(data.encounters.map((encounter) => encounter.id));
  problems.push(...duplicates("clock", data.clocks.map((clock) => clock.id)));
  problems.push(...duplicates("clue", data.clues.map((clue) => clue.id)));
  for (const clock of data.clocks) {
    if (!sceneIds.has(clock.sceneId)) problems.push(`${clock.id} is in unknown ${clock.sceneId}.`);
    if (clock.onFull !== null && !encounterIds.has(clock.onFull)) problems.push(`${clock.id} starts unknown ${clock.onFull} when it fills.`);
  }
  for (const clue of data.clues) {
    if (!sceneIds.has(clue.sceneId)) problems.push(`${clue.id} is in unknown ${clue.sceneId}.`);
  }
  for (const encounter of data.encounters) {
    if (!sceneIds.has(encounter.sceneId)) problems.push(`${encounter.id} is in unknown ${encounter.sceneId}.`);
    const zones = new Set(encounter.zones.map((zone) => zone.id));
    problems.push(...duplicates(`${encounter.id} zone`, encounter.zones.map((zone) => zone.id)));
    if (!zones.has(encounter.partyZoneId)) problems.push(`${encounter.id} starts the party in unknown zone ${encounter.partyZoneId}.`);
    for (const edge of encounter.edges) {
      if (!zones.has(edge.from) || !zones.has(edge.to)) problems.push(`${encounter.id} edge ${edge.from}-${edge.to} names an unknown zone.`);
    }
    for (const monster of encounter.monsters) {
      if (!zones.has(monster.zoneId)) problems.push(`${encounter.id} places ${monster.monsterId} in unknown zone ${monster.zoneId}.`);
      if (monster.npcId !== null && !npcIds.has(monster.npcId)) problems.push(`${encounter.id} names unknown ${monster.npcId}.`);
    }
  }
  const heroes: PresetHero[] = data.heroes.map((hero) => {
    const skills: Partial<Record<Skill, SkillProficiency>> = {};
    for (const [skill, proficiency] of Object.entries(hero.skills)) {
      if (isSkill(skill)) skills[skill] = proficiency;
      else problems.push(`${hero.id} has unknown skill "${skill}".`);
    }
    const spellcasting =
      hero.spellcasting === null
        ? null
        : { ...hero.spellcasting, slots: Object.fromEntries(Object.entries(hero.spellcasting.slots).map(([level, count]) => [Number(level), count])) };
    return { ...hero, abilityScores: hero.abilityScores as CharacterSheet["abilityScores"], skills, spellcasting };
  });
  if (problems.length > 0) throw new AdventureDocumentError(problems);

  const { heroes: _heroes, ...bible } = data;
  return { bible, heroes };
}

// Two language editions of one adventure must describe the same structure.
export function checkEditionsMatch(editions: readonly AdventureDocument[]): readonly string[] {
  const [first, ...rest] = editions;
  if (first === undefined) return [];
  const shape = (document: AdventureDocument): string =>
    JSON.stringify({
      id: document.bible.id,
      version: document.bible.version,
      startScene: document.bible.startScene,
      scenes: document.bible.scenes.map((scene) => [scene.id, scene.npcIds]),
      npcs: document.bible.npcs.map((npc) => npc.id),
      clocks: document.bible.clocks.map((clock) => [clock.id, clock.sceneId, clock.segments, clock.onFull]),
      clues: document.bible.clues.map((clue) => [clue.id, clue.sceneId]),
      encounters: document.bible.encounters.map((encounter) => ({
        ...encounter,
        publicDescription: null,
        dmNotes: null,
        zones: encounter.zones.map((zone) => zone.id),
      })),
      heroes: document.heroes.map(({ name: _name, ...mechanics }) => mechanics),
    });
  const expected = shape(first);
  return rest.flatMap((edition) =>
    shape(edition) === expected ? [] : [`The ${edition.bible.language} edition does not match the ${first.bible.language} edition.`],
  );
}

function duplicates(kind: string, ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) (seen.has(id) ? repeated : seen).add(id);
  return [...repeated].map((id) => `${kind} ${id} is defined more than once.`);
}
