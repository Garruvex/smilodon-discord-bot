import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";

import type { HeroView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";

const barCells = 8;

export function hpBar(hp: number, maxHp: number): string {
  const filled = maxHp <= 0 ? 0 : Math.max(0, Math.min(barCells, Math.ceil((Math.max(0, hp) / maxHp) * barCells)));
  return "▰".repeat(filled) + "▱".repeat(barCells - filled);
}

// A hero's public card in the Party channel (panel spec, Hero cards): public
// identity, HP, defense, conditions, and presence. Private inventory and
// notes never appear here. `conditionName` localizes a condition ID.
export function renderHeroCard(view: HeroView, text: Texts, campaignId: string, conditionName: (id: string) => string): CardPayload {
  const t = text.campaign;
  const presence = view.fallen ? t.hero.fallen : view.down ? t.hero.down : view.presence === "away" ? t.hero.away : t.hero.present;
  const conditions = view.conditions.length === 0 ? t.hero.noConditions : view.conditions.map(conditionName).join(", ");
  const lines = [
    t.hero.line({ name: view.name, class: view.className ?? "", level: view.level }),
    t.hero.player({ user: `<@${view.ownerUserId}>` }),
    t.hero.stats({ bar: hpBar(view.hp, view.maxHp), hp: Math.max(0, view.hp), max: view.maxHp, ac: view.armorClass }),
    t.hero.status({ conditions, presence }),
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
