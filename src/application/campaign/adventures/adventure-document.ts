import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AdventureBible, BibleEffect, BibleFightEffect, BibleInteraction, BibleRequirement, BibleTrigger, ClockId, ClueId, EncounterId, NpcId, SceneId } from "../../../domain/campaign/adventure/adventure-bible.js";
import { isSkill, type CharacterSheet, type Skill, type SkillProficiency } from "../../../domain/campaign/character/character-sheet.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { abilities } from "../../../domain/campaign/rules/effects.js";

// A ready-made hero shipped with an adventure. The owner is assigned when a
// player picks it.
export type PresetHero = Omit<CharacterSheet, "ownerUserId"> & { readonly class: string };

export interface AdventureDocument {
  readonly bible: AdventureBible;
  readonly heroes: readonly PresetHero[];
}

const sceneId = z.string().regex(/^scene:[a-z0-9-]+$/) as unknown as z.ZodType<SceneId>;
// At most 40 characters after "npc:", so a control that names the NPC always fits a custom ID.
const npcId = z.string().regex(/^npc:[a-z0-9-]{1,40}$/) as unknown as z.ZodType<NpcId>;
const encounterId = z.string().regex(/^encounter:[a-z0-9-]+$/) as unknown as z.ZodType<EncounterId>;
const clockId = z.string().regex(/^clock:[a-z0-9-]+$/) as unknown as z.ZodType<ClockId>;
const clueId = z.string().regex(/^clue:[a-z0-9-]+$/) as unknown as z.ZodType<ClueId>;
const zoneId = z.string().regex(/^[a-z0-9-]+$/);
const text = z.string().trim().min(1);
function contentId<K extends "item" | "feature" | "spell" | "monster">(kind: K): z.ZodType<ContentId<K>> {
  return z.string().regex(new RegExp('^' + kind + ':[a-z0-9-]+$')) as unknown as z.ZodType<ContentId<K>>;
}
const abilityScore = z.number().int().min(1).max(30);
const flagName = z.string().regex(/^[a-z0-9-]{1,60}$/);
const revealEffect = z.object({ kind: z.literal("reveal"), clue: clueId }).strict();
const setEffect = z.object({ kind: z.literal("set"), flag: flagName, value: z.number().int().min(0).max(1000).optional() }).strict();
const rewardEffect = z.object({ kind: z.literal("reward"), gold: z.number().int().min(0).max(100_000).optional(), items: z.array(contentId("item")).max(20).optional() }).strict();
const gotoEffect = z.object({ kind: z.literal("goto"), scene: sceneId }).strict();
const clockEffect = z.object({ kind: z.literal("clock"), clock: clockId, by: z.number().int().min(1).max(3) }).strict();
const effectSchema = z.discriminatedUnion("kind", [revealEffect, setEffect, rewardEffect, gotoEffect, clockEffect, z.object({ kind: z.literal("encounter"), encounter: encounterId }).strict()]);
// A fight's effects: the story ones (a fight never starts another fight), foes arriving, a truce, a line for the table.
const monsterEntry = z.object({ monsterId: contentId("monster"), zoneId, npcId: npcId.nullable().default(null), fleeBelowHpFraction: z.number().gt(0).lt(1).nullable().default(null) }).strict();
const fightEffectSchema = z.discriminatedUnion("kind", [
  revealEffect,
  setEffect,
  rewardEffect,
  gotoEffect,
  clockEffect,
  z.object({ kind: z.literal("add"), monsters: z.array(monsterEntry).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("end") }).strict(),
  z.object({ kind: z.literal("announce"), text }).strict(),
]);
const victoryEffectSchema = z.discriminatedUnion("kind", [revealEffect, setEffect, rewardEffect, gotoEffect, clockEffect]);
const triggerSchema = z
  .object({
    when: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("foesDown"), count: z.number().int().min(1).max(20) }).strict(),
      z.object({ kind: z.literal("round"), round: z.number().int().min(2).max(30) }).strict(),
    ]),
    effects: z.array(fightEffectSchema).min(1),
  })
  .strict();
const requirementSchema = z.object({ clues: z.array(clueId).optional(), flags: z.array(flagName).optional(), notFlags: z.array(flagName).optional() }).strict();
const interactionSchema = z
  .object({
    id: z.string().regex(/^interaction:[a-z0-9-]{1,60}$/),
    sceneId,
    label: text,
    dmNotes: text,
    check: z.object({ skill: z.string().optional(), ability: z.enum(abilities).optional(), dc: z.number().int().min(1).max(30) }).strict().nullable().default(null),
    requires: requirementSchema.default({}),
    pay: z.number().int().min(0).max(100_000).default(0),
    attempts: z.number().int().min(1).max(10).default(1),
    onSuccess: z.array(effectSchema).default([]),
    onFailure: z.array(effectSchema).default([]),
    tiers: z.array(z.object({ dc: z.number().int().min(2).max(30), effects: z.array(effectSchema).min(1) }).strict()).default([]),
  })
  .strict();

const documentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: text,
    language: z.enum(["en", "zh-TW"]),
    title: text,
    premise: text,
    startingLevel: z.number().int().min(1).max(10).optional(),
    dmOverview: text,
    startScene: sceneId,
    scenes: z
      .array(
        z.object({ id: sceneId, title: text, publicDescription: text, dmNotes: text, npcIds: z.array(npcId), exits: z.array(z.object({ to: sceneId, requires: requirementSchema.optional() }).strict()).optional() }).strict(),
      )
      .min(1),
    npcs: z.array(
      z
        .object({
          id: npcId,
          name: text,
          voice: text,
          publicDescription: text,
          secret: text,
          shop: z
            .object({
              stock: z.array(z.object({ itemId: contentId("item"), buyPrice: z.number().int().min(0), sellPrice: z.number().int().min(0).optional() }).strict()).min(1),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    clocks: z
      .array(
        z
          .object({ id: clockId, sceneId, name: text, segments: z.number().int().min(2).max(12), dmNotes: text, onFull: encounterId.nullable().default(null) })
          .strict(),
      )
      .default([]),
    clues: z.array(z.object({ id: clueId, sceneId, publicText: text, dmNotes: text }).strict()).default([]),
    interactions: z.array(interactionSchema).default([]),
    encounters: z
      .array(
        z
          .object({
            id: encounterId,
            sceneId,
            publicDescription: text,
            dmNotes: text,
            zones: z.array(z.object({ id: zoneId, name: text, lighting: z.enum(["bright", "dim", "dark"]).optional(), cover: z.enum(["half", "three-quarters"]).optional(), difficult: z.boolean().optional() }).strict()).min(1),
            edges: z.array(z.object({ from: zoneId, to: zoneId, feet: z.number().int().min(5) }).strict()),
            partyZoneId: zoneId,
            surprised: z.enum(["party", "foes"]).optional(),
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
            triggers: z.array(triggerSchema).default([]),
            onVictory: z.array(victoryEffectSchema).default([]),
            loot: z.array(contentId("item")).default([]),
            gold: z.number().int().min(0).default(0),
            milestoneLevel: z.number().int().min(2).max(20).optional(),
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
  for (const npc of data.npcs) {
    if (npc.shop !== undefined) problems.push(...duplicates(`${npc.id} shop`, npc.shop.stock.map((entry) => entry.itemId)));
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
  problems.push(...interactionProblems(data));
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

  const { heroes: _heroes, startingLevel, encounters, interactions, scenes, ...rest } = data;
  // zod's .optional() leaves the key present with value undefined, which
  // exactOptionalPropertyTypes treats as different from the key being
  // absent; strip it so an npc with no shop matches BibleNpc exactly.
  const npcs = data.npcs.map(({ shop, ...npc }) => {
    if (shop === undefined) return npc;
    const stock = shop.stock.map(({ sellPrice, ...entry }) => (sellPrice === undefined ? entry : { ...entry, sellPrice }));
    return { ...npc, shop: { stock } };
  });
  // Same for the optional levels: absent, not undefined.
  const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const bibleEncounters = encounters.map(({ milestoneLevel, triggers, onVictory, ...encounter }) => ({
    ...encounter,
    ...(milestoneLevel === undefined ? {} : { milestoneLevel }),
    ...(triggers.length === 0 ? {} : { triggers: clean(triggers) as unknown as readonly BibleTrigger[] }),
    ...(onVictory.length === 0 ? {} : { onVictory: clean(onVictory) as unknown as readonly BibleEffect[] }),
  }));
  // The same for the optional pieces of interactions, requirements and exits: absent, not undefined (a JSON round trip drops them).
  const bible: AdventureBible = {
    ...rest,
    scenes: clean(scenes) as unknown as AdventureBible["scenes"],
    npcs,
    encounters: bibleEncounters,
    ...(interactions.length === 0 ? {} : { interactions: clean(interactions) as unknown as readonly BibleInteraction[] }),
    ...(startingLevel === undefined ? {} : { startingLevel }),
  };
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
      startingLevel: document.bible.startingLevel ?? null,
      scenes: document.bible.scenes.map((scene) => [scene.id, scene.npcIds, scene.exits ?? null]),
      interactions: (document.bible.interactions ?? []).map(({ label: _label, dmNotes: _notes, ...mechanics }) => mechanics),
      npcs: document.bible.npcs.map((npc) => [npc.id, npc.shop ?? null]),
      clocks: document.bible.clocks.map((clock) => [clock.id, clock.sceneId, clock.segments, clock.onFull]),
      clues: document.bible.clues.map((clue) => [clue.id, clue.sceneId]),
      encounters: document.bible.encounters.map((encounter) => ({
        ...encounter,
        publicDescription: null,
        dmNotes: null,
        zones: encounter.zones.map((zone) => zone.id),
        triggers: (encounter.triggers ?? []).map((trigger) => ({ ...trigger, effects: trigger.effects.map((effect) => (effect.kind === "announce" ? { kind: "announce" } : effect)) })),
      })),
      heroes: document.heroes.map(({ name: _name, ...mechanics }) => mechanics),
    });
  const expected = shape(first);
  return rest.flatMap((edition) =>
    shape(edition) === expected ? [] : [`The ${edition.bible.language} edition does not match the ${first.bible.language} edition.`],
  );
}

// Every reference an interaction, tier or exit makes, and whether the checks make sense.
function interactionProblems(data: z.infer<typeof documentSchema>): readonly string[] {
  const problems: string[] = [];
  const sceneIds = new Set<string>(data.scenes.map((scene) => scene.id));
  const clueIds = new Set<string>(data.clues.map((clue) => clue.id));
  const encounterIds = new Set<string>(data.encounters.map((encounter) => encounter.id));
  const clockIds = new Set<string>(data.clocks.map((clock) => clock.id));
  problems.push(...duplicates("interaction", data.interactions.map((interaction) => interaction.id)));
  const effects = (list: readonly BibleEffect[]): BibleEffect[] => [...list];
  const allEffects = data.interactions.flatMap((interaction) => [...effects(interaction.onSuccess as BibleEffect[]), ...effects(interaction.onFailure as BibleEffect[]), ...interaction.tiers.flatMap((tier) => effects(tier.effects as BibleEffect[]))]);
  const fightEffects = data.encounters.flatMap((encounter) => [...encounter.triggers.flatMap((trigger) => trigger.effects as BibleFightEffect[]), ...(encounter.onVictory as BibleEffect[])]);
  const setFlags = new Set([...allEffects, ...fightEffects].flatMap((effect) => (effect.kind === "set" ? [effect.flag] : [])));
  const checkEffects = (owner: string, list: readonly BibleEffect[]): void => {
    for (const effect of list) {
      if (effect.kind === "reveal" && !clueIds.has(effect.clue)) problems.push(`${owner} reveals unknown ${effect.clue}.`);
      if (effect.kind === "goto" && !sceneIds.has(effect.scene)) problems.push(`${owner} goes to unknown ${effect.scene}.`);
      if (effect.kind === "encounter" && !encounterIds.has(effect.encounter)) problems.push(`${owner} starts unknown ${effect.encounter}.`);
      if (effect.kind === "clock" && !clockIds.has(effect.clock)) problems.push(`${owner} advances unknown ${effect.clock}.`);
      if (effect.kind === "reward" && (effect.gold ?? 0) === 0 && (effect.items ?? []).length === 0) problems.push(`${owner} has an empty reward.`);
    }
  };
  const checkRequirement = (owner: string, requires: BibleRequirement | undefined): void => {
    for (const clue of requires?.clues ?? []) if (!clueIds.has(clue)) problems.push(`${owner} requires unknown ${clue}.`);
    for (const flag of requires?.flags ?? []) if (!setFlags.has(flag)) problems.push(`${owner} requires flag "${flag}", which nothing sets.`);
    for (const flag of requires?.notFlags ?? []) if (!setFlags.has(flag)) problems.push(`${owner} requires flag "${flag}" to be unset, but nothing sets it.`);
  };
  for (const interaction of data.interactions) {
    const owner = interaction.id;
    if (!sceneIds.has(interaction.sceneId)) problems.push(`${owner} is in unknown ${interaction.sceneId}.`);
    const { check } = interaction;
    if (check !== null) {
      if ((check.skill === undefined) === (check.ability === undefined)) problems.push(`${owner}'s check names either a skill or an ability, not both or neither.`);
      if (check.skill !== undefined && !isSkill(check.skill)) problems.push(`${owner} has unknown skill "${check.skill}".`);
      let last = check.dc;
      for (const tier of interaction.tiers) {
        if (tier.dc <= last) problems.push(`${owner}'s tiers must rise above the check's DC and each other.`);
        last = tier.dc;
      }
    } else {
      if (interaction.tiers.length > 0) problems.push(`${owner} has tiers but no check.`);
      if (interaction.onFailure.length > 0) problems.push(`${owner} has no check, so it never fails.`);
    }
    checkEffects(owner, interaction.onSuccess as BibleEffect[]);
    checkEffects(owner, interaction.onFailure as BibleEffect[]);
    for (const tier of interaction.tiers) checkEffects(owner, tier.effects as BibleEffect[]);
    checkRequirement(owner, interaction.requires as BibleRequirement);
  }
  for (const encounter of data.encounters) {
    const owner = encounter.id;
    const zoneIds = new Set(encounter.zones.map((zone) => zone.id));
    const npcIds = new Set(data.npcs.map((npc) => npc.id));
    encounter.triggers.forEach((trigger, index) => {
      checkEffects(`${owner} trigger ${index + 1}`, trigger.effects.filter((effect) => effect.kind !== "add" && effect.kind !== "end" && effect.kind !== "announce") as BibleEffect[]);
      for (const effect of trigger.effects) {
        if (effect.kind !== "add") continue;
        for (const monster of effect.monsters) {
          if (!zoneIds.has(monster.zoneId)) problems.push(`${owner} trigger ${index + 1} adds ${monster.monsterId} to unknown zone ${monster.zoneId}.`);
          if (monster.npcId !== null && !npcIds.has(monster.npcId)) problems.push(`${owner} trigger ${index + 1} names unknown ${monster.npcId}.`);
        }
      }
    });
    checkEffects(`${owner} victory`, encounter.onVictory as BibleEffect[]);
  }
  for (const scene of data.scenes) {
    for (const exit of scene.exits ?? []) {
      if (!sceneIds.has(exit.to)) problems.push(`${scene.id} has an exit to unknown ${exit.to}.`);
      checkRequirement(`${scene.id}'s exit to ${exit.to}`, exit.requires as BibleRequirement | undefined);
    }
  }
  return problems;
}

function duplicates(kind: string, ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) (seen.has(id) ? repeated : seen).add(id);
  return [...repeated].map((id) => `${kind} ${id} is defined more than once.`);
}

// Checks what the adventure references against the sealed ruleset: heroes'
// equipment, features, and spells, and every encounter's monsters. Parsing
// checks structure; this needs the ruleset, so it runs when a campaign is set
// up and in the tests of every shipped adventure.
export function checkAdventureContent(document: AdventureDocument, content: SealedContent): readonly string[] {
  const problems: string[] = [];
  const expectKind = (owner: string, id: string, kind: string): void => {
    const found = content.find(id);
    if (found === undefined) problems.push(`${owner} uses ${id}, which the ruleset does not have.`);
    else if (found.kind !== kind) problems.push(`${owner} uses ${id} as a ${kind}, but it is of kind ${found.kind}.`);
  };
  for (const hero of document.heroes) {
    for (const id of hero.equipment) expectKind(hero.id, id, "item");
    for (const id of hero.features) expectKind(hero.id, id, "feature");
    for (const id of hero.spellcasting?.spells ?? []) expectKind(hero.id, id, "spell");
  }
  for (const npc of document.bible.npcs) for (const entry of npc.shop?.stock ?? []) expectKind(npc.id, entry.itemId, "item");
  for (const interaction of document.bible.interactions ?? []) {
    for (const effect of [...interaction.onSuccess, ...interaction.onFailure, ...interaction.tiers.flatMap((tier) => tier.effects)]) {
      if (effect.kind === "reward") for (const item of effect.items ?? []) expectKind(interaction.id, item, "item");
    }
  }
  for (const encounter of document.bible.encounters) {
    for (const monster of encounter.monsters) expectKind(encounter.id, monster.monsterId, "monster");
    for (const trigger of encounter.triggers ?? []) {
      for (const effect of trigger.effects) {
        if (effect.kind === "add") for (const monster of effect.monsters) expectKind(encounter.id, monster.monsterId, "monster");
        if (effect.kind === "reward") for (const item of effect.items ?? []) expectKind(encounter.id, item, "item");
      }
    }
    for (const effect of encounter.onVictory ?? []) if (effect.kind === "reward") for (const item of effect.items ?? []) expectKind(encounter.id, item, "item");
    for (const item of encounter.loot) expectKind(encounter.id, item, "item");
  }
  return problems;
}
