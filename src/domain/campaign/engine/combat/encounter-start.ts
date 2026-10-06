// Starting a fight: validating the encounter, placing everyone, rolling initiative.
import type { EncounterMonster, EncounterSpec } from "../../commands/campaign-command.js";
import type { RollId } from "../../core/ids.js";
import { companionsOf } from "../../companions/companion-roster.js";
import { isFallen } from "../../state/campaign-state.js";
import { type Combatant, type EncounterState, type PendingCombatRoll } from "../../combat/combat-state.js";
import { defaultHeroResources } from "../../character/hero-status.js";
import { hasSaveAdvantage, innateUseKey, isImmuneToCondition } from "../../rules/traits.js";
import { savingThrowModifier } from "../../character/character-sheet.js";
import { heroCombatant, monsterCombatant } from "../../combat/combatant-profile.js";
import type { D20TestSpec } from "../../dice/d20-test.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";

// Perfect Self and Superior Inspiration: rolling initiative with none left brings some back.
function refilledAtInitiative(hero: Combatant): Combatant {
  const uses = { ...hero.resources.featureUses };
  if (hero.traits.some((trait) => trait.kind === "perfectSelf") && (uses["feature:ki"] ?? 1) <= 0) uses["feature:ki"] = 4;
  const inspiration = innateUseKey("spell:bardic-inspiration");
  if (hero.traits.some((trait) => trait.kind === "superiorInspiration") && (uses[inspiration] ?? 1) <= 0) uses[inspiration] = 1;
  return { ...hero, resources: { ...hero.resources, featureUses: uses } };
}

export function startEncounter(decision: Decision, spec: EncounterSpec): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.round !== null) return { code: "roundInProgress" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  const problems = encounterProblems(decision, spec);
  if (problems.length > 0) return { code: "invalidEncounter", problems };
  beginEncounter(decision, spec);
  return null;
}

// Starts a validated fight: by the organizer, or after the round in which
// the Planner queued it has been narrated.
export function beginEncounter(decision: Decision, spec: EncounterSpec): void {
  const { state, ctx } = decision;
  const content = ctx.rules.content;
  const combatants: Record<string, Combatant> = {};
  for (const member of Object.values(state.members)) {
    const sheet = member.characterId === null ? undefined : state.characters[member.characterId];
    if (sheet === undefined || isFallen(state, sheet.id)) continue;
    const status = state.heroStatus[sheet.id] ?? { hp: sheet.maxHp, resources: defaultHeroResources(sheet, content) };
    combatants[sheet.id] = refilledAtInitiative(heroCombatant(sheet, content, spec.partyZoneId, status));
    // What the hero brought along joins on the party's side, wounds and all.
    for (const companion of companionsOf(state.companions, sheet.id)) {
      const monster = content.find(companion.monsterId);
      if (monster?.kind !== "monster") continue;
      const id = `${sheet.id}-${companion.id.replace(":", "-")}`;
      const creature = monsterCombatant(monster, content, { id, letter: null, zoneId: spec.partyZoneId, npcId: null, fleeBelowHpFraction: null });
      combatants[id] = { ...creature, side: "party", companionId: companion.id, summonedBy: sheet.id, hp: companion.hp ?? creature.hp };
    }
  }
  // More heroes than the fight was tuned for: a group of identical foes gains members in proportion, every foe grows sturdier and hits harder (a lone foe most).
  const heroCount = Object.values(combatants).filter((combatant) => combatant.source.kind === "hero").length;
  const growth = spec.partyBase === undefined || spec.partyBase < 1 ? 1 : heroCount / spec.partyBase;
  const foes = [...spec.monsters];
  const spares = spec.reinforcements ?? [];
  if (growth > 1 && spares.length > 0) {
    const extra = heroCount - (spec.partyBase ?? heroCount);
    for (let index = 0; index < extra * 2; index += 1) foes.push(spares[index % spares.length] as EncounterMonster);
  } else if (growth > 1) {
    const sizes = new Map<string, number>();
    for (const entry of spec.monsters) sizes.set(entry.monsterId, (sizes.get(entry.monsterId) ?? 0) + 1);
    for (const [monsterId, size] of sizes) {
      if (size < 2) continue;
      const template = spec.monsters.find((entry) => entry.monsterId === monsterId);
      if (template === undefined) continue;
      for (let extra = Math.round(size * (growth - 1)); extra > 0; extra -= 1) foes.push(template);
    }
  }
  // A lone foe also hits harder: +1 damage per hero beyond the base, up to +5.
  const extraHeroes = growth > 1 ? heroCount - (spec.partyBase ?? heroCount) : 0;
  const bossBonus = Math.min(5, Math.ceil(extraHeroes * 1.5));
  const minionBonus = Math.min(2, Math.ceil(extraHeroes / 2));
  const counts = new Map<string, number>();
  for (const entry of foes) counts.set(entry.monsterId, (counts.get(entry.monsterId) ?? 0) + 1);
  // One establishing shot of this fight, rather than isolated monster portraits.
  decision.request({ kind: "encounterImage", encounterId: spec.id, monsters: foes.map(({ monsterId, npcId }) => ({ monsterId, npcId })), snapshot: decision.pictureSnapshot() });
  const seen = new Map<string, number>();
  const loneFoes = new Set<string>();
  for (const entry of foes) {
    const monster = content.get(entry.monsterId);
    const index = seen.get(entry.monsterId) ?? 0;
    seen.set(entry.monsterId, index + 1);
    const letter = (counts.get(entry.monsterId) ?? 0) > 1 ? String.fromCharCode(65 + index) : null;
    const slug = entry.monsterId.slice("monster:".length);
    const id = letter === null ? slug : `${slug}-${letter.toLowerCase()}`;
    if (letter === null) loneFoes.add(id);
    combatants[id] = monsterCombatant(monster, content, {
      id,
      letter,
      zoneId: entry.zoneId,
      npcId: entry.npcId,
      fleeBelowHpFraction: entry.fleeBelowHpFraction,
      ...(entry.rank === undefined ? {} : { rank: entry.rank }),
      ...(entry.stats === undefined && extraHeroes === 0 ? {} : { stats: { ...entry.stats, ...(extraHeroes === 0 ? {} : { damage: (entry.stats?.damage ?? 0) + (letter === null ? bossBonus : minionBonus) }) } }),
    });
  }

  if (growth > 1) {
    for (const [id, combatant] of Object.entries(combatants)) {
      if (combatant.side === "party") continue;
      // A lone foe grows with the party; each member of a group by half as much.
      const hp = Math.ceil(combatant.maxHp * (loneFoes.has(id) ? 1 + (growth - 1) * 1.5 : 1 + (growth - 1) / 2));
      combatants[id] = { ...combatant, maxHp: hp, hp };
    }
  }

  // Everyone rolls initiative at once; turns begin when the last roll lands.
  const pendingRolls: Record<RollId, PendingCombatRoll> = {};
  let sequence = 0;
  for (const combatant of Object.values(combatants)) {
    const rollSpec: D20TestSpec = { mode: combatant.traits.some((trait) => trait.kind === "feralInstinct") ? "advantage" : "normal", modifier: combatant.initiativeModifier, bonusDice: [] };
    pendingRolls[`${spec.id}:roll:${++sequence}`] = { purpose: "initiative", combatantId: combatant.id, spec: rollSpec };
  }
  // Something dreadful as the fight breaks out: each hero (not one immune to fear) saves, their rolls landing with initiative.
  if (spec.dread !== undefined) {
    const { ability, dc } = spec.dread;
    for (const combatant of Object.values(combatants)) {
      const sheet = combatant.source.kind === "hero" ? state.characters[combatant.source.characterId] : undefined;
      if (sheet === undefined || isImmuneToCondition(combatant.traits, "condition:frightened")) continue;
      const advantage = hasSaveAdvantage(combatant.traits, ability, { conditions: ["condition:frightened"], damageTypes: [], magic: false });
      pendingRolls[`${spec.id}:roll:${++sequence}`] = { purpose: "dread", combatantId: combatant.id, dc, spec: { mode: advantage ? "advantage" : "normal", modifier: savingThrowModifier(sheet, ability), bonusDice: [] } };
    }
  }
  const encounter: EncounterState = {
    id: spec.id,
    status: "initiative",
    round: 0,
    turnNumber: 0,
    order: [],
    turnIndex: 0,
    turnEndsAt: null,
    combatants,
    zones: spec.zones,
    edges: spec.edges,
    engagements: [],
    resolution: null,
    pendingMove: null,
    pendingTriggers: null,
    pendingRolls,
    sequence,
    outcome: null,
    deferredTurn: null,
    narratedRound: 0,
    spec,
    loot: spec.loot ?? [],
    gold: spec.gold ?? 0,
  };
  decision.emit({ kind: "encounterStarted", encounter });
  for (const [rollId, pending] of Object.entries(pendingRolls)) {
    if (pending.purpose === "initiative" || pending.purpose === "dread") decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec: pending.spec } });
  }
  decision.request({ kind: "deliver", delivery: { kind: "encounterStarted", encounterId: spec.id } });
}

export function encounterProblems(decision: Decision, spec: EncounterSpec): readonly string[] {
  const problems: string[] = [];
  if (decision.state.encounterHistory.includes(spec.id)) problems.push("This encounter has already been fought.");
  const zoneIds = new Set(spec.zones.map((zone) => zone.id));
  if (zoneIds.size !== spec.zones.length) problems.push("Zone IDs repeat.");
  if (!zoneIds.has(spec.partyZoneId)) problems.push(`Party zone ${spec.partyZoneId} does not exist.`);
  for (const edge of spec.edges) {
    if (!zoneIds.has(edge.from) || !zoneIds.has(edge.to)) problems.push(`Edge ${edge.from}-${edge.to} names an unknown zone.`);
    if (!Number.isInteger(edge.feet) || edge.feet <= 0) problems.push(`Edge ${edge.from}-${edge.to} needs a positive distance.`);
  }
  if (spec.monsters.length === 0) problems.push("An encounter needs at least one monster.");
  if (spec.gold !== undefined && (!Number.isInteger(spec.gold) || spec.gold < 0)) problems.push("Gold must be a whole number of zero or more.");
  for (const item of spec.loot ?? []) {
    if (decision.ctx.rules.content.find(item)?.kind !== "item") problems.push(`Unknown loot item ${item}.`);
  }
  for (const monster of spec.monsters) {
    if (decision.ctx.rules.content.find(monster.monsterId)?.kind !== "monster") problems.push(`Unknown monster ${monster.monsterId}.`);
    if (!zoneIds.has(monster.zoneId)) problems.push(`${monster.monsterId} is placed in unknown zone ${monster.zoneId}.`);
    const flee = monster.fleeBelowHpFraction;
    if (flee !== null && !(flee > 0 && flee < 1)) problems.push(`${monster.monsterId} flee threshold must be between 0 and 1.`);
  }
  return problems;
}

// Highest first; ties go to the higher Dexterity modifier, then heroes, then ID.
export function initiativeOrder(encounter: EncounterState): readonly string[] {
  return Object.values(encounter.combatants)
    .sort((a, b) => {
      const byRoll = (b.initiative ?? 0) - (a.initiative ?? 0);
      if (byRoll !== 0) return byRoll;
      const byDex = b.initiativeModifier - a.initiativeModifier;
      if (byDex !== 0) return byDex;
      if (a.side !== b.side) return a.side === "party" ? -1 : 1;
      return a.id.localeCompare(b.id);
    })
    .map((combatant) => combatant.id);
}
