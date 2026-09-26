import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AdventureBible, NpcId, SceneId } from "../../../domain/campaign/adventure/adventure-bible.js";
import { isSkill, type CharacterSheet, type Skill, type SkillProficiency } from "../../../domain/campaign/character/character-sheet.js";
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
const text = z.string().trim().min(1);
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
  const heroes: PresetHero[] = data.heroes.map((hero) => {
    const skills: Partial<Record<Skill, SkillProficiency>> = {};
    for (const [skill, proficiency] of Object.entries(hero.skills)) {
      if (isSkill(skill)) skills[skill] = proficiency;
      else problems.push(`${hero.id} has unknown skill "${skill}".`);
    }
    return { ...hero, abilityScores: hero.abilityScores as CharacterSheet["abilityScores"], skills };
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
