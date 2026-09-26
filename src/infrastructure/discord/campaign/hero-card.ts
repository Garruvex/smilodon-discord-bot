import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";

import type { HeroView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";
import { classLabel } from "./text-keys.js";

const barCells = 8;

function spellLines(view: HeroView, text: Texts, nameOf: (id: string) => string): string[] {
  const t = text.campaign.hero;
  if (view.cantrips.length === 0 && view.prepared.length === 0) return [];
  const parts = [
    ...(view.cantrips.length === 0 ? [] : [t.cantrips({ spells: view.cantrips.map(nameOf).join(t.separator) })]),
    ...(view.prepared.length === 0 ? [] : [t.prepared({ spells: view.prepared.map(nameOf).join(t.separator) })]),
  ];
  const slots = view.slots.map((slot) => t.slot({ level: slot.level, left: slot.left, max: slot.max })).join(" · ");
  return [parts.join(" · "), ...(slots === "" ? [] : [t.slots({ slots })])];
}

export function hpBar(hp: number, maxHp: number): string {
  const filled = maxHp <= 0 ? 0 : Math.max(0, Math.min(barCells, Math.ceil((Math.max(0, hp) / maxHp) * barCells)));
  return "▰".repeat(filled) + "▱".repeat(barCells - filled);
}

// A hero's public card in the Party channel (panel spec, Hero cards): public
// identity, HP, defense, conditions, presence, and what the hero carries:
// gear, pack, party gold, prepared spells and slots, and limited uses, so the
// table never has to click for them. Private notes never appear here.
// `nameOf` localizes a content ID (a condition, item, spell, or feature).
export function renderHeroCard(view: HeroView, text: Texts, campaignId: string, nameOf: (id: string) => string): CardPayload {
  const t = text.campaign;
  const presence = view.fallen ? t.hero.fallen : view.down ? t.hero.down : view.presence === "away" ? t.hero.away : t.hero.present;
  const list = (ids: readonly string[]): string => ids.map(nameOf).join(t.hero.separator);
  const conditions = view.conditions.length === 0 ? t.hero.noConditions : list(view.conditions);
  const lines = [
    t.hero.line({ name: view.name, class: classLabel(text, view.className), level: view.level }),
    t.hero.player({ user: `<@${view.ownerUserId}>` }),
    t.hero.stats({ bar: hpBar(view.hp, view.maxHp), hp: Math.max(0, view.hp), max: view.maxHp, ac: view.armorClass }),
    t.hero.status({ conditions, presence }),
    t.hero.equipped({ items: view.equipped.length === 0 ? t.hero.nothing : list(view.equipped) }),
    t.hero.pack({
      items: view.pack.length === 0 ? t.hero.nothing : view.pack.map((entry) => (entry.count > 1 ? `${nameOf(entry.id)} ×${entry.count}` : nameOf(entry.id))).join(t.hero.separator),
      gold: view.gold,
    }),
    ...(view.stash.length === 0 ? [] : [t.hero.stash({ items: list(view.stash) })]),
    ...spellLines(view, text, nameOf),
    ...(view.uses.length === 0 ? [] : [t.hero.uses({ uses: view.uses.map((use) => `${nameOf(use.id)} ${use.left}/${use.max}`).join(t.hero.separator) })]),
  ];
  const container = new ContainerBuilder()
    .setAccentColor(view.fallen ? accents.gray : view.down ? accents.red : view.presence === "away" ? accents.gray : accents.green)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(campaignCustomId("details", campaignId, view.characterId))
          .setLabel(t.button.details)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  return cardPayload(container);
}
