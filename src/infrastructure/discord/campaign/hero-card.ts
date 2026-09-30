import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";

import type { HeroView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardFile, type CardPayload } from "./card-payload.js";
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
  // Shown apart from ordinary slots: a Warlock's Pact Magic is its own pool,
  // always at the Warlock's own level, recovering on a short rest rather
  // than a long one, so folding its count into slots would misstate both.
  const pactSlots = view.pactSlots.map((slot) => t.slot({ level: slot.level, left: slot.left, max: slot.max })).join(" · ");
  return [
    parts.join(" · "),
    ...(slots === "" ? [] : [t.slots({ slots })]),
    ...(pactSlots === "" ? [] : [t.pactSlots({ slots: pactSlots })]),
  ];
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
// `picture` is the hero's thumbnail (their portrait, or a tile with their initials).
export function renderHeroCard(view: HeroView, text: Texts, campaignId: string, nameOf: (id: string) => string, picture?: CardFile): CardPayload {
  const t = text.campaign;
  const presence = view.fallen ? t.hero.fallen : view.down ? t.hero.down : view.presence === "away" ? t.hero.away : t.hero.present;
  const list = (ids: readonly string[]): string => ids.map(nameOf).join(t.hero.separator);
  const conditions = view.conditions.length === 0 ? t.hero.noConditions : list(view.conditions);
  const lines = [
    t.hero.line({ name: view.name, class: classLabel(text, view.className), level: view.level }),
    t.hero.player({ user: `<@${view.ownerUserId}>` }),
    t.hero.stats({ bar: hpBar(view.hp, view.maxHp), hp: Math.max(0, view.hp), max: view.maxHp, ac: view.armorClass }) + (view.tempHp > 0 ? ` ✚${view.tempHp}` : ""),
    t.hero.status({ conditions, presence }),
    t.hero.worn({ items: view.worn.length === 0 ? t.hero.nothing : list(view.worn) }),
    t.hero.weapons({ items: view.weapons.length === 0 ? t.hero.nothing : list(view.weapons) }),
    t.hero.pack({
      items: view.pack.length === 0 ? t.hero.nothing : view.pack.map((entry) => (entry.count > 1 ? `${nameOf(entry.id)} ×${entry.count}` : nameOf(entry.id))).join(t.hero.separator),
    }),
    view.partyGold > 0 ? t.hero.goldWithPurse({ gold: view.gold, purse: view.partyGold }) : t.hero.gold({ gold: view.gold }),
    ...(view.stash.length === 0 ? [] : [t.hero.stash({ items: list(view.stash) })]),
    ...spellLines(view, text, nameOf),
    ...(view.uses.length === 0 ? [] : [t.hero.uses({ uses: view.uses.map((use) => `${nameOf(use.id)} ${use.left}/${use.max}`).join(t.hero.separator) })]),
  ];
  const body = new TextDisplayBuilder().setContent(lines.join("\n"));
  const container = new ContainerBuilder().setAccentColor(view.fallen ? accents.gray : view.down ? accents.red : view.presence === "away" ? accents.gray : accents.green);
  if (picture === undefined) container.addTextDisplayComponents(body);
  else container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(body).setThumbnailAccessory(new ThumbnailBuilder().setURL(`attachment://${picture.name}`).setDescription(view.name.slice(0, 100))));
  container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(campaignCustomId("details", campaignId, view.characterId))
          .setLabel(t.button.details)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  return cardPayload(container, picture === undefined ? [] : [picture]);
}
