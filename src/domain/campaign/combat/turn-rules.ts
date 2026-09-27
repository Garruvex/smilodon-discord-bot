import type { CharacterSheet } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import { potionOf } from "../engine/potions.js";
import type { FeatureDefinition, SpellDefinition } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { SealedContent } from "../rules/content-registry.js";
import { healingPotionCost, type HouseRules } from "../rules/house-rules.js";
import { canAct, conditionLookup, speedOf } from "../effects/effect-queries.js";
import { castableSlotLevels, slotUnavailable, spellMaxTargets } from "../magic/spell-rules.js";
import { areEngaged, currentCombatant, engagedWith, isPresent, type AttackOption, type Combatant, type EncounterState } from "./combat-state.js";
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

// Whether a creature may act, how fast it moves and how hard it is to hit come from the
// effect queries (effects/effect-queries.ts), so conditions change them in one place. How hard it
// is to hit is armorClassOf there too.

// ------------------------------------------------------------- Costs

export function costProblem(hero: Combatant, cost: "action" | "bonusAction", content: SealedContent): TurnProblem | null {
  return (cost === "bonusAction" ? hero.budget.bonusAction : hero.budget.action) && canAct(hero, conditionLookup(content)) ? null : { code: "noActionLeft" };
}

// ------------------------------------------------------------- Weapons

export function attackProblem(encounter: EncounterState, attacker: Combatant, option: AttackOption, targetId: string, purpose: "action" | "opportunity", content: SealedContent): TurnProblem | null {
  if (purpose === "action") {
    // Extra Attack: the Attack action grants more than one attack, so what
    // must still be available is an attack left in it, not the action itself
    // (which is only spent once the last of them is made).
    if (attacker.budget.attacksLeft <= 0 || !canAct(attacker, conditionLookup(content))) return { code: "noActionLeft" };
  }
  const problem = weaponTargetProblem(encounter, attacker, encounter.combatants[targetId], option);
  return problem === null ? null : { code: problem };
}

// ------------------------------------------------------------- Spells

export function spellSlotProblem(caster: Combatant, spell: SpellDefinition, slotLevel: number): TurnProblem | null {
  return slotUnavailable(spell, caster.resources.spellSlots, slotLevel) ? { code: "noSpellSlot", slotLevel } : null;
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
  const cost = costProblem(caster, bonus ? "bonusAction" : "action", content);
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
  const cost = costProblem(hero, bonus ? "bonusAction" : "action", content);
  return cost === null ? accept({ feature, bonus }) : refuse(cost);
}

// ------------------------------------------------------------- Movement

// Movement left this turn, none at all while an effect holds the creature in place.
const movementLeft = (hero: Combatant, content: SealedContent): number => (speedOf(hero, conditionLookup(content)) === 0 ? 0 : hero.budget.movement);

export function moveProblem(encounter: EncounterState, hero: Combatant, zoneId: string, content: SealedContent): Checked<{ readonly feet: number }> {
  const edge = edgeBetween(encounter.edges, hero.zoneId, zoneId);
  if (edge === undefined) return refuse({ code: "notAdjacent" });
  const left = movementLeft(hero, content);
  if (edge.feet > left) return refuse({ code: "notEnoughMovement", needed: edge.feet, left });
  return accept({ feet: edge.feet });
}

export function engageProblem(encounter: EncounterState, hero: Combatant, targetId: string, content: SealedContent): TurnProblem | null {
  const target = encounter.combatants[targetId];
  if (target === undefined || target.side === hero.side || !isPresent(target)) return { code: "invalidTarget" };
  if (target.zoneId !== hero.zoneId) return { code: "notAdjacent" };
  if (areEngaged(encounter, hero.id, target.id)) return { code: "alreadyEngaged" };
  const left = movementLeft(hero, content);
  if (left < engageCost) return { code: "notEnoughMovement", needed: engageCost, left };
  return null;
}

export function withdrawProblem(encounter: EncounterState, hero: Combatant, content: SealedContent): TurnProblem | null {
  if (engagedWith(encounter, hero.id).length === 0) return { code: "notEngaged" };
  const left = movementLeft(hero, content);
  if (left < withdrawCost) return { code: "notEnoughMovement", needed: withdrawCost, left };
  return null;
}

// ------------------------------------------------------------- Items

// Drinking a potion costs an action, or a bonus action under the house rule.
export function potionProblem(sheet: CharacterSheet | undefined, content: SealedContent, houseRules: HouseRules, hero: Combatant, itemId: ContentId<"item">): Checked<{ readonly bonus: boolean; readonly healing: number }> {
  if (hero.source.kind !== "hero") return refuse({ code: "notUsable" });
  const potion = potionOf(sheet, content, itemId);
  if (potion === null) return refuse({ code: sheet?.equipment.includes(itemId) === true ? "notUsable" : "itemNotHeld" });
  const bonus = houseRules.option(healingPotionCost) === "bonus-action";
  const cost = costProblem(hero, bonus ? "bonusAction" : "action", content);
  return cost === null ? accept({ bonus, healing: potion.healing }) : refuse(cost);
}

// Putting a shield on or taking it off costs the action. Armor stays as it is until the fight is over.
export function shieldProblem(sheet: CharacterSheet | undefined, content: SealedContent, hero: Combatant, itemId: ContentId<"item">, putOn: boolean): Checked<{ readonly worn: readonly ContentId<"item">[] }> {
  if (hero.source.kind !== "hero") return refuse({ code: "notWearable" });
  const definition = content.find(itemId);
  if (sheet === undefined || definition?.kind !== "item" || definition.itemType !== "shield") return refuse({ code: "notWearable" });
  if (!sheet.equipment.includes(itemId)) return refuse({ code: "itemNotHeld" });
  const cost = costProblem(hero, "action", content);
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
  const lookup = conditionLookup(content);
  if (hero === undefined || hero.source.kind !== "hero" || !canAct(hero, lookup)) return null;
  if (currentCombatant(encounter)?.id !== hero.id) return null;
  const busy = encounter.resolution !== null || encounter.pendingMove !== null || encounter.pendingTriggers !== null;

  const attacks = busy || costProblem(hero, "action", content) !== null
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
      if (costProblem(hero, bonusAction ? "bonusAction" : "action", content) !== null) continue;
      const slotLevels = castableSlotLevels(spell, hero.resources.spellSlots);
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

  const shields = busy || costProblem(hero, "action", content) !== null
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
        const checked = zone.id === hero.zoneId ? undefined : moveProblem(encounter, hero, zone.id, content);
        return checked !== undefined && "value" in checked ? [{ zoneId: zone.id, feet: checked.value.feet }] : [];
      });
  const engage = busy ? [] : Object.values(encounter.combatants).filter((other) => engageProblem(encounter, hero, other.id, content) === null).map((other) => other.id);
  const canTakeAction = !busy && costProblem(hero, "action", content) === null;

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
    canWithdraw: !busy && withdrawProblem(encounter, hero, content) === null,
    canTakeAction,
    hasUnspent: !busy && (hero.budget.action || hero.budget.bonusAction) && attacks.length + spells.length + features.length + potions.length > 0,
  };
}
