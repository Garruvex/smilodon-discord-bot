import type { Texts } from "../../../application/i18n/texts.js";
import { formatDiceExpression } from "../../../domain/campaign/dice/dice-expression.js";
import type { ContentDefinition, FeatureDefinition, ItemDefinition, SpellDefinition } from "../../../domain/campaign/rules/content-definitions.js";
import type { Effect, ResolutionPlan } from "../../../domain/campaign/rules/effects.js";

// A short stats screen for a spell, item or feature (private, from the hero's
// Items & spells button). Every number is read from the same definition the
// engine rolls from, so the screen can never disagree with play; the rules
// text itself is not stored, so nothing here is prose.
export interface InfoContext {
  readonly text: Texts;
  readonly nameOf: (id: string) => string;
  // The reading hero's level, which sets how far a cantrip has grown.
  readonly level: number;
  // How many of the item the hero carries (0 for a spell or feature).
  readonly count?: number;
}

export function describeContent(definition: ContentDefinition, context: InfoContext): string | null {
  const title = `**${context.nameOf(definition.id)}**`;
  const body = bodyOf(definition, context);
  if (body === null) return null;
  const owned = (context.count ?? 0) > 1 ? [context.text.campaign.info.owned({ count: context.count ?? 0 })] : [];
  return [title, ...body, ...owned].join("\n");
}

function bodyOf(definition: ContentDefinition, context: InfoContext): string[] | null {
  switch (definition.kind) {
    case "spell":
      return spellLines(definition, context);
    case "item":
      return itemLines(definition, context);
    case "feature":
      return featureLines(definition, context);
    default:
      return null;
  }
}

function spellLines(spell: SpellDefinition, context: InfoContext): string[] {
  const t = context.text.campaign.info;
  const school = spell.school === undefined ? t.school.unknown : t.school[spell.school];
  const kind = spell.level === 0 ? t.cantrip({ school }) : t.spellLevel({ level: spell.level, school });
  const range = spell.range.kind === "feet" ? t.range.feet({ feet: spell.range.feet }) : t.range[spell.range.kind];
  const flags = [...(spell.concentration ? [t.concentration] : []), ...(spell.ritual === true ? [t.ritual] : [])];
  const targets =
    spell.targeting.destination === true
      ? t.targetsPlace
      : spell.targeting.area === true
        ? t.targetsArea
        : spell.targeting.relation === "self"
          ? null
          : t.targets({ count: spell.targeting.count });
  const plan = spell.plan({ slotLevel: spell.level, casterLevel: Math.max(1, context.level), spellcastingModifier: 0 });
  return [
    `${kind}${flags.length === 0 ? "" : ` · ${flags.join(" · ")}`}`,
    t.spellMeta({ casting: t.casting[spell.castingTime === "bonus-action" ? "bonusAction" : spell.castingTime], range }),
    ...(targets === null ? [] : [targets]),
    ...planLines(plan, context),
  ];
}

function planLines(plan: ResolutionPlan, context: InfoContext): string[] {
  const t = context.text.campaign.info;
  const check =
    plan.check === null
      ? t.check.none
      : plan.check.kind === "savingThrow"
        ? t.check.savingThrow({ ability: context.text.campaign.ability[plan.check.ability] })
        : t.check[plan.check.kind];
  const onLand = effectsText(plan.onLand, context);
  const onAvoid = effectsText(plan.onAvoid, context);
  if (plan.check === null && onLand === "") return [];
  return [
    check,
    ...(onLand === "" ? [] : [plan.check === null ? t.effects({ effects: onLand }) : t.onLand({ effects: onLand })]),
    ...(onAvoid === "" ? [] : [t.onAvoid({ effects: onAvoid })]),
  ];
}

function effectsText(effects: readonly Effect[], context: InfoContext): string {
  return effects.map((effect) => effectText(effect, context)).join(", ");
}

function effectText(effect: Effect, context: InfoContext): string {
  const t = context.text.campaign.info;
  switch (effect.kind) {
    case "damage":
      return effect.halfOfLand === true ? t.effect.damageHalf : t.effect.damage({ amount: formatDiceExpression(effect.amount), type: t.damageType[effect.damageType] });
    case "heal":
      return t.effect.heal({ amount: formatDiceExpression(effect.amount) });
    case "tempHp":
      return t.effect.tempHp({ amount: formatDiceExpression(effect.amount) });
    case "applyCondition":
    case "conditionUnlessSave":
      return context.nameOf(effect.condition);
    case "bonusDie":
      return t.effect.bonusDie({ die: formatDiceExpression(effect.die) });
    case "nextAttackAdvantage":
      return t.effect.advantage;
    case "summon":
      return t.effect.summon({ count: effect.count, monster: context.nameOf(effect.monsterId) });
    case "teleport":
      return t.effect.teleport;
    case "revive":
      return t.effect.revive;
    case "stabilize":
      return t.effect.stabilize;
    case "removeCondition":
      return t.effect.removeCondition({ conditions: effect.conditions.map(context.nameOf).join("/") });
    case "push":
      return t.effect.push;
    case "setLighting":
      return t.effect.lighting;
    case "dispel":
      return t.effect.dispel;
    case "applyModifiers":
      return t.effect.lasting;
    default:
      return t.effect.other;
  }
}

function itemLines(item: ItemDefinition, context: InfoContext): string[] {
  const t = context.text.campaign.info;
  switch (item.itemType) {
    case "weapon": {
      const range = item.range.kind === "melee" ? t.weaponMelee : t.weaponRanged({ normal: item.range.normal, long: item.range.long });
      return [
        t.weaponStats({ damage: formatDiceExpression(item.damage), type: t.damageType[item.damageType], range }),
        ...(item.enchantment === undefined ? [] : [t.enchantment({ bonus: item.enchantment })]),
        ...(item.finesse ? [t.finesse] : []),
        ...(item.light === true ? [t.light] : []),
        ...(item.onHit === undefined || item.onHit.length === 0 ? [] : [t.onLand({ effects: effectsText(item.onHit, context) })]),
      ];
    }
    case "armor": {
      const dex = item.dexterityCap === null ? t.armorDex : item.dexterityCap === 0 ? "" : t.armorDexCap({ cap: item.dexterityCap });
      return [
        t.armorStats({ category: t.armorCategory[item.category], base: item.baseArmorClass, dex }),
        ...(item.stealthDisadvantage ? [t.stealthDisadvantage] : []),
        ...(item.strengthRequirement === null ? [] : [t.strengthRequirement({ score: item.strengthRequirement })]),
      ];
    }
    case "shield":
      return [t.shieldStats({ bonus: item.armorClassBonus })];
    case "potion":
      return [t.potionStats({ healing: item.healing }), ...(item.effects === undefined || item.effects.length === 0 ? [] : [t.effects({ effects: effectsText(item.effects, context) })])];
    case "gear": {
      const cost = item.costCp >= 100 ? t.gearCostGp({ gp: item.costCp / 100 }) : t.gearCostCp({ cp: item.costCp });
      return [t.gearStats({ cost, weight: item.weight === null ? "" : t.gearWeight({ weight: item.weight }) })];
    }
    case "magic":
      return [
        t.magicStats({ rarity: t.rarity[item.rarity === "very rare" ? "veryRare" : item.rarity], category: item.category }),
        ...(item.attunement ? [t.attunement] : []),
        ...(item.traits.length === 0 ? [t.storyOnly] : []),
      ];
  }
}

function featureLines(feature: FeatureDefinition, context: InfoContext): string[] {
  const t = context.text.campaign.info;
  const action = feature.action;
  if (action === null) return [t.featurePassive];
  const uses = feature.resource ?? ("recharge" in action.uses ? action.uses : null);
  const count = uses === null ? null : (uses.perLevel?.(context.level) ?? uses.count);
  const plan = action.plan({ level: context.level, spellcastingModifier: 0 });
  return [
    t.featureCost[action.cost],
    ...(uses === null || count === null ? [] : [t.featureUses({ count, recharge: t.recharge[uses.recharge] })]),
    ...planLines(plan, context),
  ];
}
