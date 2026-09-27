import type { CharacterSheet } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import { potionOf } from "../engine/potions.js";
import type { FeatureDefinition, SpellDefinition } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { SealedContent } from "../rules/content-registry.js";
import { healingPotionCost, type HouseRules } from "../rules/house-rules.js";
import { areEngaged, currentCombatant, engagedWith, isActive, isPresent, type AttackOption, type Combatant, type EncounterState } from "./combat-state.js";
import { isWorn } from "./combatant-profile.js";
import { spellTargetProblem, spellTargets, weaponTargetProblem, weaponTargets } from "./legal-targets.js";
import { edgeBetween, engageCost, withdrawCost } from "./positioning.js";

// The rules of a combat turn, in one place. Every choice a hero can make has a
// *problem* function: null when the choice is legal now, or why it is not.
// The engine refuses a command with the same problem the menu greys the choice
// out with, and the menu's option list (turnOptions) is exactly the choices
// whose problem is null, so the two cannot disagree (docs/dnd-engine-architecture.md §4).

// Why a combat choice is not allowed. The engine's Rejection includes these.
export type TurnProblem =
  | { readonly code: "noActionLeft" }
  | { readonly code: "notEnoughMovement"; readonly needed: number; readonly left: number }
  | { readonly code: "notAdjacent" }
  | { readonly code: "notEngaged" }
  | { readonly code: "alreadyEngaged" }
  | { readonly code: "outOfRange" }
  | { readonly code: "invalidTarget" }
  | { readonly code: "unknownWeapon" }
  | { readonly code: "unknownSpell" }
  | { readonly code: "noSpellSlot"; readonly slotLevel: number }
  | { readonly code: "invalidTargets"; readonly maxTargets: number }
  | { readonly code: "unknownFeature" }
  | { readonly code: "noUsesLeft" }
  | { readonly code: "notWearable" }
  | { readonly code: "itemNotHeld" }
  | { readonly code: "alreadyWorn" }
  | { readonly code: "alreadyWearing" }
  | { readonly code: "notWorn" }
  | { readonly code: "notUsable" };

// A checked choice: the problem, or what the engine needs to carry it out.
export type Checked<T> = { readonly problem: TurnProblem } | { readonly value: T };

const refuse = (problem: TurnProblem): { readonly problem: TurnProblem } => ({ problem });
const accept = <T>(value: T): { readonly value: T } => ({ value });

// ------------------------------------------------------------- Queries

// The single place that says whether a creature may take actions and reactions
// and how fast it moves, and how hard it is to hit. Today they read the
// combatant; lasting effects (conditions) will change them here and nowhere else.
export const canAct = (combatant: Combatant): boolean => isActive(combatant);
export const canReact = (combatant: Combatant): boolean => canAct(combatant) && combatant.budget.reaction;
export const speedOf = (combatant: Combatant): number => combatant.speed;
export const armorClassOf = (combatant: Combatant): number => combatant.armorClass;

// ------------------------------------------------------------- Costs

export function costProblem(hero: Combatant, cost: "action" | "bonusAction"): TurnProblem | null {
  return (cost === "bonusAction" ? hero.budget.bonusAction : hero.budget.action) && canAct(hero) ? null : { code: "noActionLeft" };
}

// ------------------------------------------------------------- Weapons

export function attackProblem(encounter: EncounterState, attacker: Combatant, option: AttackOption, targetId: string, purpose: "action" | "opportunity"): TurnProblem | null {
  if (purpose === "action") {
    const cost = costProblem(attacker, "action");
    if (cost !== null) return cost;
  }
  const problem = weaponTargetProblem(encounter, attacker, encounter.combatants[targetId], option);
  return problem === null ? null : { code: problem };
}

// ------------------------------------------------------------- Spells

// How many creatures a spell may name at a slot level.
export function spellMaxTargets(spell: SpellDefinition, slotLevel: number): number {
  const extra = spell.level === 0 ? 0 : (spell.targeting.countPerHigherSlot ?? 0) * (slotLevel - spell.level);
  return spell.targeting.relation === "self" ? 1 : spell.targeting.count + extra;
}

export function spellSlotProblem(caster: Combatant, spell: SpellDefinition, slotLevel: number): TurnProblem | null {
  const unavailable = spell.level === 0 ? slotLevel !== 0 : slotLevel < spell.level || (caster.resources.spellSlots[slotLevel] ?? 0) < 1;
  return unavailable ? { code: "noSpellSlot", slotLevel } : null;
}

export function spellProblem(
  encounter: EncounterState,
  content: SealedContent,
  caster: Combatant,
  spellId: ContentId<"spell">,
  slotLevel: number,
  targetIds: readonly string[],
): Checked<{ readonly spell: SpellDefinition; readonly bonus: boolean; readonly targets: readonly string[] }> {
  const casting = caster.spellcasting;
  const spell = content.find(spellId);
  if (casting === null || spell?.kind !== "spell" || !casting.spells.includes(spell.id)) return refuse({ code: "unknownSpell" });
  const slot = spellSlotProblem(caster, spell, slotLevel);
  if (slot !== null) return refuse(slot);
  // A reaction spell is cast in response to something, never on the caster's turn.
  if (spell.castingTime === "reaction") return refuse({ code: "unknownSpell" });
  const bonus = spell.castingTime === "bonus-action";
  const cost = costProblem(caster, bonus ? "bonusAction" : "action");
  if (cost !== null) return refuse(cost);
  const maxTargets = spell.targeting.relation === "self" ? spell.targeting.count : spellMaxTargets(spell, slotLevel);
  const targets = spell.targeting.relation === "self" ? [caster.id] : targetIds;
  if (targets.length === 0 || targets.length > maxTargets || new Set(targets).size !== targets.length) return refuse({ code: "invalidTargets", maxTargets });
  for (const targetId of targets) {
    const problem = spellTargetProblem(encounter, caster, spell, encounter.combatants[targetId]);
    if (problem !== null) return refuse({ code: problem });
  }
  return accept({ spell, bonus, targets });
}

// ------------------------------------------------------------- Features

export function featureProblem(hero: Combatant, content: SealedContent, featureId: ContentId<"feature">): Checked<{ readonly feature: FeatureDefinition; readonly bonus: boolean }> {
  const feature = content.find(featureId);
  if (feature?.kind !== "feature" || feature.action === null || !hero.features.includes(feature.id)) return refuse({ code: "unknownFeature" });
  if ((hero.resources.featureUses[feature.id] ?? 0) < 1) return refuse({ code: "noUsesLeft" });
  const bonus = feature.action.cost === "bonusAction";
  const cost = costProblem(hero, bonus ? "bonusAction" : "action");
  return cost === null ? accept({ feature, bonus }) : refuse(cost);
}

// ------------------------------------------------------------- Movement

export function moveProblem(encounter: EncounterState, hero: Combatant, zoneId: string): Checked<{ readonly feet: number }> {
  const edge = edgeBetween(encounter.edges, hero.zoneId, zoneId);
  if (edge === undefined) return refuse({ code: "notAdjacent" });
  if (edge.feet > hero.budget.movement) return refuse({ code: "notEnoughMovement", needed: edge.feet, left: hero.budget.movement });
  return accept({ feet: edge.feet });
}

export function engageProblem(encounter: EncounterState, hero: Combatant, targetId: string): TurnProblem | null {
  const target = encounter.combatants[targetId];
  if (target === undefined || target.side === hero.side || !isPresent(target)) return { code: "invalidTarget" };
  if (target.zoneId !== hero.zoneId) return { code: "notAdjacent" };
  if (areEngaged(encounter, hero.id, target.id)) return { code: "alreadyEngaged" };
  if (hero.budget.movement < engageCost) return { code: "notEnoughMovement", needed: engageCost, left: hero.budget.movement };
  return null;
}

export function withdrawProblem(encounter: EncounterState, hero: Combatant): TurnProblem | null {
  if (engagedWith(encounter, hero.id).length === 0) return { code: "notEngaged" };
  if (hero.budget.movement < withdrawCost) return { code: "notEnoughMovement", needed: withdrawCost, left: hero.budget.movement };
  return null;
}

// ------------------------------------------------------------- Items

// Drinking a potion costs an action, or a bonus action under the house rule.
export function potionProblem(sheet: CharacterSheet | undefined, content: SealedContent, houseRules: HouseRules, hero: Combatant, itemId: ContentId<"item">): Checked<{ readonly bonus: boolean; readonly healing: number }> {
  if (hero.source.kind !== "hero") return refuse({ code: "notUsable" });
  const potion = potionOf(sheet, content, itemId);
  if (potion === null) return refuse({ code: sheet?.equipment.includes(itemId) === true ? "notUsable" : "itemNotHeld" });
  const bonus = houseRules.option(healingPotionCost) === "bonus-action";
  const cost = costProblem(hero, bonus ? "bonusAction" : "action");
  return cost === null ? accept({ bonus, healing: potion.healing }) : refuse(cost);
}

// Putting a shield on or taking it off costs the action. Armor stays as it is until the fight is over.
export function shieldProblem(sheet: CharacterSheet | undefined, content: SealedContent, hero: Combatant, itemId: ContentId<"item">, putOn: boolean): Checked<{ readonly worn: readonly ContentId<"item">[] }> {
  if (hero.source.kind !== "hero") return refuse({ code: "notWearable" });
  const definition = content.find(itemId);
  if (sheet === undefined || definition?.kind !== "item" || definition.itemType !== "shield") return refuse({ code: "notWearable" });
  if (!sheet.equipment.includes(itemId)) return refuse({ code: "itemNotHeld" });
  const cost = costProblem(hero, "action");
  if (cost !== null) return refuse(cost);
  const typeOf = (id: ContentId<"item">): "armor" | "shield" | null => {
    const other = content.find(id);
    return other?.kind === "item" && (other.itemType === "armor" || other.itemType === "shield") ? other.itemType : null;
  };
  const worn = sheet.equipment.filter((id) => typeOf(id) !== null && isWorn(sheet, content, id));
  if (putOn) {
    if (worn.includes(itemId)) return refuse({ code: "alreadyWorn" });
    if (worn.some((id) => typeOf(id) === "shield")) return refuse({ code: "alreadyWearing" });
  } else if (!worn.includes(itemId)) return refuse({ code: "notWorn" });
  return accept({ worn: putOn ? [...worn, itemId] : worn.filter((id) => id !== itemId) });
}

// ------------------------------------------------------------- What a hero may do now

export interface TurnOptions {
  readonly combatantId: string;
  // An attack or move is being resolved: nothing new can be started yet.
  readonly busy: boolean;
  readonly attacks: readonly { readonly option: AttackOption; readonly targetIds: readonly string[] }[];
  readonly spells: readonly {
    readonly spell: SpellDefinition;
    // Every slot level it can be cast at now (0 for a cantrip).
    readonly slotLevels: readonly number[];
    readonly bonusAction: boolean;
    readonly targetIds: readonly string[];
  }[];
  readonly features: readonly { readonly feature: FeatureDefinition; readonly bonusAction: boolean; readonly left: number }[];
  readonly potions: readonly { readonly itemId: ContentId<"item">; readonly count: number; readonly bonusAction: boolean }[];
  // Shields carried, whether each is on, and whether it can be switched now.
  readonly shields: readonly { readonly itemId: ContentId<"item">; readonly on: boolean; readonly canSwitch: boolean }[];
  readonly moves: readonly { readonly zoneId: string; readonly feet: number }[];
  readonly engage: readonly string[];
  readonly canWithdraw: boolean;
  // Dash, Dodge and Disengage each cost the action.
  readonly canTakeAction: boolean;
  // Anything left worth spending: ending the turn then asks first.
  readonly hasUnspent: boolean;
}

// The hero whose turn it is, or null when it is nobody's turn to plan (a roll
// or attack is being resolved, the hero is down, or it is another creature's).
export function turnOptions(encounter: EncounterState | null, sheet: CharacterSheet | undefined, content: SealedContent, houseRules: HouseRules, characterId: CharacterId): TurnOptions | null {
  if (encounter === null || encounter.status !== "active") return null;
  const hero = encounter.combatants[characterId];
  if (hero === undefined || hero.source.kind !== "hero" || !canAct(hero)) return null;
  if (currentCombatant(encounter)?.id !== hero.id) return null;
  const busy = encounter.resolution !== null || encounter.pendingMove !== null;

  const attacks = busy || costProblem(hero, "action") !== null
    ? []
    : hero.attacks.flatMap((option) => {
        const targetIds = weaponTargets(encounter, hero, option).map((target) => target.id);
        return targetIds.length === 0 ? [] : [{ option, targetIds }];
      });

  const spells: TurnOptions["spells"][number][] = [];
  if (!busy) {
    for (const id of hero.spellcasting?.spells ?? []) {
      const spell = content.find(id);
      if (spell?.kind !== "spell" || spell.castingTime === "reaction") continue;
      const bonusAction = spell.castingTime === "bonus-action";
      if (costProblem(hero, bonusAction ? "bonusAction" : "action") !== null) continue;
      const levels = spell.level === 0 ? [0] : Object.keys(hero.resources.spellSlots).map(Number).sort((a, b) => a - b);
      const slotLevels = levels.filter((level) => spellSlotProblem(hero, spell, level) === null);
      const targetIds = spellTargets(encounter, hero, spell).map((target) => target.id);
      if (slotLevels.length > 0 && targetIds.length > 0) spells.push({ spell, slotLevels, bonusAction, targetIds });
    }
  }

  const features = busy
    ? []
    : hero.features.flatMap((id) => {
        const checked = featureProblem(hero, content, id);
        return "value" in checked ? [{ feature: checked.value.feature, bonusAction: checked.value.bonus, left: hero.resources.featureUses[id] ?? 0 }] : [];
      });

  const counts = new Map<ContentId<"item">, number>();
  for (const id of sheet?.equipment ?? []) if (potionOf(sheet, content, id) !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  const potions = busy
    ? []
    : [...counts].flatMap(([itemId, count]) => {
        const checked = potionProblem(sheet, content, houseRules, hero, itemId);
        return "value" in checked ? [{ itemId, count, bonusAction: checked.value.bonus }] : [];
      });

  const shields = busy || costProblem(hero, "action") !== null
    ? []
    : [...new Set(sheet?.equipment ?? [])].flatMap((itemId) => {
        const item = content.find(itemId);
        if (sheet === undefined || item?.kind !== "item" || item.itemType !== "shield") return [];
        const on = isWorn(sheet, content, itemId);
        return [{ itemId, on, canSwitch: "value" in shieldProblem(sheet, content, hero, itemId, !on) }];
      });

  const moves = busy
    ? []
    : encounter.zones.flatMap((zone) => {
        const checked = zone.id === hero.zoneId ? undefined : moveProblem(encounter, hero, zone.id);
        return checked !== undefined && "value" in checked ? [{ zoneId: zone.id, feet: checked.value.feet }] : [];
      });
  const engage = busy ? [] : Object.values(encounter.combatants).filter((other) => engageProblem(encounter, hero, other.id) === null).map((other) => other.id);
  const canTakeAction = !busy && costProblem(hero, "action") === null;

  return {
    combatantId: characterId,
    busy,
    attacks,
    spells,
    features,
    potions,
    shields,
    moves,
    engage,
    canWithdraw: !busy && withdrawProblem(encounter, hero) === null,
    canTakeAction,
    hasUnspent: !busy && (hero.budget.action || hero.budget.bonusAction) && attacks.length + spells.length + features.length + potions.length > 0,
  };
}
