import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from "discord.js";

import type { HeroView, PanelMode } from "../../../application/campaign/views/campaign-views.js";
import type { PacingPresetId } from "../../../application/campaign/ports/campaign-record.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";

export interface CampaignCardInput {
  readonly campaignName: string;
  readonly sceneTitle: string;
  readonly mode: PanelMode;
  readonly language: "en" | "zh-TW";
  readonly pacingPreset: PacingPresetId;
  readonly organizerId: string;
  readonly heroes: readonly HeroView[];
  // Links to the Adventure channel and the discussion thread, when they exist.
  readonly adventureUrl: string | null;
  readonly talkUrl: string | null;
}

const accentFor: Readonly<Record<PanelMode, number>> = {
  collecting: accents.green,
  planning: accents.green,
  awaitingRolls: accents.green,
  combat: accents.red,
  waiting: accents.gray,
  paused: accents.gray,
  recovery: accents.gray,
  archived: accents.gray,
};

// The Party channel's campaign overview (panel spec, Active campaign card):
// the lobby card becomes this once the adventure starts, and it stays in place.
export function renderCampaignCard(input: CampaignCardInput, text: Texts, campaignId: string): CardPayload {
  const t = text.campaign;
  const status = (hero: HeroView): string =>
    hero.fallen ? t.hero.fallen : hero.down ? t.hero.down : hero.presence === "away" ? t.hero.away : t.hero.present;
  const party = input.heroes.map((hero) => t.card.hero({ hero: hero.name, user: `<@${hero.ownerUserId}>`, status: status(hero) })).join("\n");
  const container = new ContainerBuilder()
    .setAccentColor(accentFor[input.mode])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `## ${t.card.title({ name: input.campaignName })}`,
          t.card.scene({ scene: input.sceneTitle, mode: t.mode[input.mode] }),
          `-# ${t.card.pacing({ pacing: t.pacing[input.pacingPreset], language: input.language === "en" ? t.language.en : t.language.zhTW, user: `<@${input.organizerId}>` })}`,
        ].join("\n"),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${t.card.party}**\n${party}`));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(campaignCustomId("myHero", campaignId)).setLabel(t.button.myHero).setStyle(ButtonStyle.Primary),
  );
  if (input.adventureUrl !== null) row.addComponents(new ButtonBuilder().setURL(input.adventureUrl).setLabel(t.card.linkAdventure).setStyle(ButtonStyle.Link));
  if (input.talkUrl !== null) row.addComponents(new ButtonBuilder().setURL(input.talkUrl).setLabel(t.card.linkTalk).setStyle(ButtonStyle.Link));
  return cardPayload(container.addActionRowComponents(row));
}
