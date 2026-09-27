import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";

import type { TargetView, TurnView } from "../../../application/campaign/views/turn-view.js";
import type { Texts } from "../../../application/i18n/texts.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { campaignCustomId } from "./campaign-ids.js";

// The private turn menu (panel spec: Combat targeting). Each option is one
// legal action; targets come in a second menu. A choice is written into the
// menu's option values, so a menu still works after a restart and never grants
// authority: the engine checks every command again.

export type TurnChoice =
  | { readonly kind: "attack"; readonly weapon: string }
  | { readonly kind: "cast"; readonly spell: string; readonly slot: number }
  | { readonly kind: "feature"; readonly feature: string }
  | { readonly kind: "potion"; readonly item: string }
  | { readonly kind: "move"; readonly zone: string }
  | { readonly kind: "shield"; readonly item: string; readonly on: boolean }
  | { readonly kind: "engage" }
  | { readonly kind: "withdraw" }
  | { readonly kind: "dodge" }
  | { readonly kind: "dash" }
  | { readonly kind: "disengage" }
  | { readonly kind: "end" };

export function encodeChoice(choice: TurnChoice): string {
  switch (choice.kind) {
    case "attack":
      return `attack|${choice.weapon}`;
    case "cast":
      return `cast|${choice.spell}|${choice.slot}`;
    case "feature":
      return `feature|${choice.feature}`;
    case "potion":
      return `potion|${choice.item}`;
    case "move":
      return `move|${choice.zone}`;
    case "shield":
      return `shield|${choice.on ? "on" : "off"}|${choice.item}`;
    default:
      return choice.kind;
  }
}

export function parseChoice(value: string): TurnChoice | null {
  const [kind, first, second] = value.split("|");
  switch (kind) {
    case "attack":
      return first?.startsWith("item:") === true ? { kind, weapon: first } : null;
    case "cast": {
      const slot = Number(second);
      return first?.startsWith("spell:") === true && Number.isInteger(slot) && slot >= 0 ? { kind, spell: first, slot } : null;
    }
    case "feature":
      return first?.startsWith("feature:") === true ? { kind, feature: first } : null;
    case "potion":
      return first?.startsWith("item:") === true ? { kind, item: first } : null;
    case "move":
      return first !== undefined && first.length > 0 ? { kind, zone: first } : null;
    case "shield":
      return (first === "on" || first === "off") && second?.startsWith("item:") === true ? { kind, item: second, on: first === "on" } : null;
    case "engage":
    case "withdraw":
    case "dodge":
    case "dash":
    case "disengage":
    case "end":
      return { kind };
    default:
      return null;
  }
}

// "<choice>><target>", one per picked target.
export function encodeAim(choice: TurnChoice, targetId: string): string {
  return `${encodeChoice(choice)}>${targetId}`;
}

export function parseAim(value: string): { readonly choice: TurnChoice; readonly targetId: string } | null {
  const split = value.lastIndexOf(">");
  if (split < 0) return null;
  const choice = parseChoice(value.slice(0, split));
  const targetId = value.slice(split + 1);
  return choice === null || targetId.length === 0 ? null : { choice, targetId };
}

export interface TurnMenu {
  readonly content: string;
  readonly components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
}

const maxOptions = 25;

// The turn view: what is left this turn, then one menu of everything legal.
export function renderTurnMenu(view: TurnView, text: Texts, glossary: Glossary, campaignId: string): TurnMenu {
  const t = text.campaign.turn;
  const mark = (left: boolean): string => (left ? "✅" : "❌");
  const lines = [
    t.header({ hero: view.heroName, zone: view.zone, action: mark(view.budget.action), bonus: mark(view.budget.bonusAction), reaction: mark(view.budget.reaction), feet: view.budget.movement }),
  ];
  if (view.engagedWith.length > 0) lines.push(t.engaged({ names: view.engagedWith.join(", ") }));
  const options = choicesOf(view).map((choice) => ({ label: choiceLabel(choice, view, text, glossary).slice(0, 100), value: encodeChoice(choice) }));
  const refresh = refreshRow(campaignId, text.campaign.button.refresh);
  if (view.busy) return { content: [...lines, t.busy].join("\n"), components: [refresh] };
  // End turn always fits; the others give way if there are too many.
  const menu = [...options.slice(0, maxOptions - 1), { label: t.end, value: encodeChoice({ kind: "end" }) }];
  lines.push(options.length === 0 ? t.nothing : t.prompt);
  return {
    content: lines.join("\n"),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(campaignCustomId("pick", campaignId)).setPlaceholder(t.placeholder).addOptions(menu),
      ),
      refresh,
    ],
  };
}

// The second step: who the chosen action is aimed at.
export function renderTargetMenu(choice: TurnChoice, view: TurnView, text: Texts, glossary: Glossary, campaignId: string): TurnMenu | null {
  const targets = targetsOf(choice, view);
  if (targets === null || targets.targets.length === 0) return null;
  const t = text.campaign.turn;
  const max = Math.max(1, Math.min(targets.max, targets.targets.length, maxOptions));
  const action = choiceLabel(choice, view, text, glossary);
  const options = targets.targets.slice(0, maxOptions).map((target) => ({ label: targetLabel(target, text).slice(0, 100), value: encodeAim(choice, target.id) }));
  return {
    content: max > 1 ? t.targetsPrompt({ action, max }) : t.targetPrompt({ action }),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(campaignCustomId("aim", campaignId)).setPlaceholder(t.targetPlaceholder).setMinValues(1).setMaxValues(max).addOptions(options),
      ),
      refreshRow(campaignId, t.back),
    ],
  };
}

// Ending a turn with something unspent asks first.
export function renderEndConfirm(text: Texts, campaignId: string): TurnMenu {
  return {
    content: text.campaign.turn.confirmEnd,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(campaignCustomId("endTurn", campaignId, "yes")).setLabel(text.campaign.button.endTurnAnyway).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(campaignCustomId("turnRefresh", campaignId)).setLabel(text.campaign.turn.back).setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function refreshRow(campaignId: string, label: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(campaignCustomId("turnRefresh", campaignId)).setLabel(label).setStyle(ButtonStyle.Secondary),
  );
}

// Every legal action, in the order a player usually wants them.
function choicesOf(view: TurnView): readonly TurnChoice[] {
  return [
    ...view.attacks.map((attack): TurnChoice => ({ kind: "attack", weapon: attack.weapon })),
    ...view.spells.map((spell): TurnChoice => ({ kind: "cast", spell: spell.spellId, slot: spell.slotLevel })),
    ...view.features.map((feature): TurnChoice => ({ kind: "feature", feature: feature.id })),
    ...view.potions.map((potion): TurnChoice => ({ kind: "potion", item: potion.id })),
    ...view.shields.map((shield): TurnChoice => ({ kind: "shield", item: shield.id, on: !shield.on })),
    ...view.moves.map((move): TurnChoice => ({ kind: "move", zone: move.zoneId })),
    ...(view.engage.length > 0 ? [{ kind: "engage" } as const] : []),
    ...(view.canWithdraw ? [{ kind: "withdraw" } as const] : []),
    ...(view.canDodge ? [{ kind: "dodge" } as const] : []),
    ...(view.canDashOrDisengage ? [{ kind: "dash" } as const, { kind: "disengage" } as const] : []),
  ];
}

function targetsOf(choice: TurnChoice, view: TurnView): { readonly targets: readonly TargetView[]; readonly max: number } | null {
  switch (choice.kind) {
    case "attack": {
      const attack = view.attacks.find((candidate) => candidate.weapon === choice.weapon);
      return attack === undefined ? null : { targets: attack.targets, max: 1 };
    }
    case "cast": {
      const spell = view.spells.find((candidate) => candidate.spellId === choice.spell && candidate.slotLevel === choice.slot);
      return spell === undefined ? null : { targets: spell.targets, max: spell.maxTargets };
    }
    case "engage":
      return { targets: view.engage, max: 1 };
    default:
      return null;
  }
}

function choiceLabel(choice: TurnChoice, view: TurnView, text: Texts, glossary: Glossary): string {
  const t = text.campaign.turn;
  const name = (id: string): string => glossary.names[id] ?? id;
  switch (choice.kind) {
    case "attack": {
      const attack = view.attacks.find((candidate) => candidate.weapon === choice.weapon);
      const toHit = attack === undefined ? 0 : attack.toHit;
      return t.attack({ weapon: name(choice.weapon), toHit: toHit >= 0 ? `+${toHit}` : `${toHit}`, damage: attack?.damage ?? "" });
    }
    case "cast": {
      const spell = view.spells.find((candidate) => candidate.spellId === choice.spell && candidate.slotLevel === choice.slot);
      const base = choice.slot === 0 ? t.cast({ spell: name(choice.spell) }) : t.castSlot({ spell: name(choice.spell), level: choice.slot, left: spell?.slotsLeft ?? 0 });
      return spell?.bonusAction === true ? `${base} · ${t.bonusTag}` : base;
    }
    case "feature":
      return t.feature({ feature: name(choice.feature), left: view.features.find((candidate) => candidate.id === choice.feature)?.left ?? 0 });
    case "potion":
      return t.potion({ potion: name(choice.item), count: view.potions.find((candidate) => candidate.id === choice.item)?.count ?? 1 });
    case "move": {
      const move = view.moves.find((candidate) => candidate.zoneId === choice.zone);
      return t.move({ zone: move?.zone ?? choice.zone, feet: move?.feet ?? 0 });
    }
    case "shield":
      return choice.on ? t.shieldOn({ item: name(choice.item) }) : t.shieldOff({ item: name(choice.item) });
    case "engage":
      return t.engage;
    case "withdraw":
      return t.withdraw;
    case "dodge":
      return t.dodge;
    case "dash":
      return t.dash;
    case "disengage":
      return t.disengage;
    case "end":
      return t.end;
  }
}

function targetLabel(target: TargetView, text: Texts): string {
  const t = text.campaign.turn;
  if (target.self) return t.self({ name: target.name });
  if (target.side === "party") return t.ally({ name: target.name, hp: Math.max(0, target.hp), max: target.maxHp });
  return t.foe({ name: target.name, zone: target.zone, band: text.campaign.band[target.band] });
}
