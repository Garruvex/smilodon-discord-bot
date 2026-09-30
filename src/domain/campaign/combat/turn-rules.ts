import type { CharacterSheet } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import { potionOf } from "../engine/potions.js";
import { useKeyOf, type FeatureDefinition, type SpellDefinition } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { MetamagicOption } from "../rules/modifiers.js";
import type { SealedContent } from "../rules/content-registry.js";
import { healingPotionCost, type HouseRules } from "../rules/house-rules.js";
import { mayWildShapeInto, wildShapeFeature, wildShapeUses } from "../rules/wild-shape-rules.js";
import { canAct, conditionLookup, speedOf } from "../effects/effect-queries.js";
import { castableSlotLevels, slotUnavailable, spellMaxTargets, usePoolOf } from "../magic/spell-rules.js";
import { areEngaged, availableSlots, currentCombatant, engagedWith, isPresent, type AttackOption, type Combatant, type EncounterState } from "./combat-state.js";
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
  | { readonly code: "bonusSpellCast" }
  | { readonly code: "notMelee" }
  | { readonly code: "invalidTargets"; readonly maxTargets: number }
  | { readonly code: "unknownFeature" }
  | { readonly code: "noUsesLeft" }
  | { readonly code: "notWearable" }
  | { readonly code: "itemNotHeld" }
  | { readonly code: "alreadyWorn" }
  | { readonly code: "alreadyWearing" }
  | { readonly code: "notWorn" }
  | { readonly code: "notUsable" }
  | { readonly code: "alreadyShaped" }
  | { readonly code: "notShaped" };

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

export function attackProblem(encounter: EncounterState, attacker: Combatant, option: AttackOption, targetId: string, purpose: "action" | "opportunity" | "legendary", content: SealedContent): TurnProblem | null {
  if (purpose === "action") {
    // Extra Attack: the Attack action grants more than one attack, so what
    // must still be available is an attack left in it, not the action itself
    // (which is only spent once the last of them is made).
    if (attacker.budget.attacksLeft <= 0 || !canAct(attacker, conditionLookup(content))) return { code: "noActionLeft" };
  }
  const problem = weaponTargetProblem(encounter, attacker, encounter.combatants[targetId], option, content);
  return problem === null ? null : { code: problem };
}

// Divine Smite: spending a slot with a melee hit for bonus radiant damage.
// A slot declared up front with the attack is spent then; otherwise the paladin
// is offered the choice once the hit is confirmed (engine/combat/smite.ts).
export function smiteProblem(attacker: Combatant, option: AttackOption, slotLevel: number): TurnProblem | null {
  if (!attacker.traits.some((trait) => trait.kind === "divineSmite")) return { code: "unknownFeature" };
  if (option.range.kind !== "melee") return { code: "notMelee" };
  if ((availableSlots(attacker.resources)[slotLevel] ?? 0) < 1) return { code: "noSpellSlot", slotLevel };
  return null;
}

// ------------------------------------------------------------- Spells

export function spellSlotProblem(caster: Combatant, spell: SpellDefinition, slotLevel: number): TurnProblem | null {
  return slotUnavailable(spell, availableSlots(caster.resources), slotLevel) ? { code: "noSpellSlot", slotLevel } : null;
}

export function spellProblem(
  encounter: EncounterState,
  content: SealedContent,
  caster: Combatant,
  spellId: ContentId<"spell">,
  slotLevel: number,
  targetIds: readonly string[],
  metamagic: MetamagicOption | null = null,
): Checked<{ readonly spell: SpellDefinition; readonly bonus: boolean; readonly targets: readonly string[] }> {
  const casting = caster.spellcasting;
  const spell = content.find(spellId);
  // Wild Shape: no spellcasting while shaped (SRD 5.1).
  if ((caster.wildShapeOriginal !== null && !caster.traits.some((trait) => trait.kind === "beastSpells")) || casting === null || spell?.kind !== "spell" || !casting.spells.includes(spell.id)) return refuse({ code: "unknownSpell" });
  // A spell cast by nature needs no slot, only uses left; it is cast at its own level.
  const innate = casting.innate?.[spell.id];
  if (innate !== undefined) {
    if (slotLevel !== spell.level) return refuse({ code: "noSpellSlot", slotLevel });
    const pool = usePoolOf(casting, spell.id);
    if (innate !== null && (caster.resources.featureUses[pool.key] ?? innate) < pool.cost) return refuse({ code: "noUsesLeft" });
  } else {
    const slot = spellSlotProblem(caster, spell, slotLevel);
    if (slot !== null) return refuse(slot);
  }
  // A reaction spell is cast in response to something, never on the caster's turn.
  if (spell.castingTime === "reaction" || spell.castingTime === "long") return refuse({ code: "unknownSpell" });
  // Quickened Spell: a spell that takes an action is cast as a bonus action instead.
  const bonus = spell.castingTime === "bonus-action" || (metamagic === "quickened" && spell.castingTime === "action");
  // After a bonus-action spell, only a one-action cantrip may be cast this turn.
  if (caster.budget.bonusSpellCast && (bonus || spell.level > 0)) return refuse({ code: "bonusSpellCast" });
  const cost = costProblem(caster, bonus ? "bonusAction" : "action", content);
  if (cost !== null) return refuse(cost);
  // Twinned Spell: a spell that targets only one creature (and does not grow with the slot) may target a second.
  const twin = metamagic === "twinned" && spell.targeting.count === 1 && (spell.targeting.countPerHigherSlot ?? 0) === 0 && spell.targeting.relation !== "self" ? 1 : 0;
  const maxTargets = spell.targeting.relation === "self" ? spell.targeting.count : spellMaxTargets(spell, slotLevel) + twin;
  const targets = spell.targeting.relation === "self" ? [caster.id] : targetIds;
  if (targets.length === 0 || targets.length > maxTargets || new Set(targets).size !== targets.length) return refuse({ code: "invalidTargets", maxTargets });
  for (const targetId of targets) {
    const problem = spellTargetProblem(encounter, caster, spell, encounter.combatants[targetId], content);
    if (problem !== null) return refuse({ code: problem });
  }
  return accept({ spell, bonus, targets });
}

// ------------------------------------------------------------- Wild Shape

// A beast within the druid's level cap (rules/wild-shape-rules.ts), while a use
// is left. monsterId omitted means reverting, checked against wildShapeOriginal instead.
export function wildShapeProblem(hero: Combatant, content: SealedContent, monsterId?: ContentId<"monster">): TurnProblem | null {
  if (monsterId === undefined) return hero.wildShapeOriginal === null ? { code: "notShaped" } : null;
  if (hero.wildShapeOriginal !== null) return { code: "alreadyShaped" };
  if (!hero.traits.some((trait) => trait.kind === "wildShape")) return { code: "unknownFeature" };
  const beast = content.find(monsterId);
  if (beast?.kind !== "monster" || !mayWildShapeInto(hero.level, beast)) return { code: "unknownFeature" };
  return (hero.resources.featureUses[wildShapeFeature] ?? wildShapeUses) < 1 ? { code: "noUsesLeft" } : null;
}

// Every beast this druid may take now.
export function wildShapeForms(hero: Combatant, content: SealedContent): readonly ContentId<"monster">[] {
  return content
    .all("monster")
    .filter((beast) => wildShapeProblem(hero, content, beast.id) === null)
    .map((beast) => beast.id);
}

// ------------------------------------------------------------- Features

export function featureProblem(hero: Combatant, content: SealedContent, featureId: ContentId<"feature">, encounter: EncounterState | null = null): Checked<{ readonly feature: FeatureDefinition; readonly bonus: boolean; readonly free: boolean }> {
  const feature = content.find(featureId);
  if (feature?.kind !== "feature" || feature.action === null || !hero.features.includes(feature.id)) return refuse({ code: "unknownFeature" });
  if ((hero.resources.featureUses[useKeyOf(feature)] ?? 0) < (feature.action.spend ?? 1)) return refuse({ code: "noUsesLeft" });
  // Hide: out of every foe's reach, and somewhere to hide (cover or darkness). A rogue's Cunning Action makes it a bonus action.
  if (feature.id === "feature:hide" && encounter !== null) {
    const zone = encounter.zones.find((candidate) => candidate.id === hero.zoneId);
    const engaged = engagedWith(encounter, hero.id).some((other) => other.side !== hero.side && isPresent(other) && other.hp > 0);
    if (engaged || (zone?.cover === undefined && zone?.lighting !== "dark")) return refuse({ code: "notUsable" });
  }
  const bonus = feature.action.cost === "bonusAction" || (feature.id === "feature:hide" && hero.traits.some((trait) => trait.kind === "cunningAction"));
  const free = feature.action.cost === "free";
  const cost = free ? (canAct(hero, conditionLookup(content)) ? null : { code: "noActionLeft" as const }) : costProblem(hero, bonus ? "bonusAction" : "action", content);
  return cost === null ? accept({ feature, bonus, free }) : refuse(cost);
}

// ------------------------------------------------------------- Movement

// Movement left this turn, none at all while an effect holds the creature in
// place (grappled, restrained, paralyzed, stunned). The one place movement
// legality is decided, so a player's move and the engine's own automated
// movement (turn-flow.ts's continuePlan, for monsters and the away policy)
// can't disagree about whether a hindered creature may cross a zone.
export const movementLeft = (hero: Combatant, content: SealedContent): number => (speedOf(hero, conditionLookup(content)) === 0 ? 0 : hero.budget.movement);

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
  const bonus = houseRules.option(healingPotionCost) === "bonus-action" || hero.traits.some((trait) => trait.kind === "fastHands");
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
  // Dodge always costs the action.
  readonly canTakeAction: boolean;
  // Dash and Disengage cost the action too, unless Cunning Action makes
  // either free as a bonus action instead.
  readonly canDashOrDisengage: boolean;
  // Anything left worth spending: ending the turn then asks first.
  readonly hasUnspent: boolean;
  // Wild Shape: beast forms that may be taken now, and whether the current
  // shape (if any) may be reverted now. Both cost the bonus action.
  readonly wildShapeForms: readonly ContentId<"monster">[];
  readonly canRevertShape: boolean;
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

  // Gated on attacksLeft, not costProblem("action", ...): Extra Attack marks
  // the action spent on the first swing (attackProblem below matches), but
  // further swings from the same action stay legal while attacksLeft holds.
  const attacks = busy || hero.budget.attacksLeft <= 0 || !canAct(hero, lookup)
    ? []
    : hero.attacks.flatMap((option) => {
        const targetIds = weaponTargets(encounter, hero, option, content).map((target) => target.id);
        return targetIds.length === 0 ? [] : [{ option, targetIds }];
      });

  const spells: TurnOptions["spells"][number][] = [];
  if (!busy && (hero.wildShapeOriginal === null || hero.traits.some((trait) => trait.kind === "beastSpells"))) {
    for (const id of hero.spellcasting?.spells ?? []) {
      const spell = content.find(id);
      if (spell?.kind !== "spell" || spell.castingTime === "reaction" || spell.castingTime === "long") continue;
      const bonusAction = spell.castingTime === "bonus-action";
      if (costProblem(hero, bonusAction ? "bonusAction" : "action", content) !== null) continue;
      if (hero.budget.bonusSpellCast && (bonusAction || spell.level > 0)) continue;
      const innate = hero.spellcasting?.innate?.[id];
      const pool = usePoolOf(hero.spellcasting, id);
      if (innate !== undefined && innate !== null && (hero.resources.featureUses[pool.key] ?? innate) < pool.cost) continue;
      const slotLevels = castableSlotLevels(spell, availableSlots(hero.resources));
      const targetIds = spellTargets(encounter, hero, spell, content).map((target) => target.id);
      if (slotLevels.length > 0 && targetIds.length > 0) spells.push({ spell, slotLevels, bonusAction, targetIds });
    }
  }

  const features = busy
    ? []
    : hero.features.flatMap((id) => {
        const checked = featureProblem(hero, content, id, encounter);
        return "value" in checked ? [{ feature: checked.value.feature, bonusAction: checked.value.bonus, left: hero.resources.featureUses[useKeyOf(checked.value.feature)] ?? 0 }] : [];
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
  const cunningAvailable = hero.traits.some((trait) => trait.kind === "cunningAction") && costProblem(hero, "bonusAction", content) === null;
  const canDashOrDisengage = canTakeAction || (!busy && cunningAvailable);
  const formsNow = busy || !hero.budget.bonusAction ? [] : wildShapeForms(hero, content);
  const canRevertShape = !busy && wildShapeProblem(hero, content) === null;

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
    canDashOrDisengage,
    wildShapeForms: formsNow,
    canRevertShape,
    hasUnspent: !busy && (hero.budget.action || hero.budget.bonusAction) && attacks.length + spells.length + features.length + potions.length > 0,
  };
}
