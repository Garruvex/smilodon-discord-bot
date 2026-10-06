import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";

import type { SmiteView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";

// A landed hit waiting on its attacker's Divine Smite answer: shows in the
// Adventure channel until it is answered. Ownership and staleness are
// checked again by the engine on every click, the same as a reaction card's.
export function renderSmiteCard(view: SmiteView, text: Texts, campaignId: string): CardPayload {
  const t = text.campaign;
  const lines = [
    t.smite.title({ attacker: view.attackerName, target: view.targetName }),
    t.smite.player({ user: `<@${view.attackerUserId}>` }),
    ...(view.closesAt === null ? [] : [`-# ${t.smite.closes({ when: `<t:${Math.floor(view.closesAt / 1000)}:R>` })}`]),
  ];
  const container = new ContainerBuilder()
    .setAccentColor(accents.green)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...view.options.map((option) =>
          new ButtonBuilder()
            .setCustomId(campaignCustomId("smiteChoose", campaignId, String(option.slotLevel)))
            .setLabel(t.smite.option({ slot: option.slotLevel }))
            .setStyle(ButtonStyle.Success),
        ),
        new ButtonBuilder().setCustomId(campaignCustomId("smiteSkip", campaignId)).setLabel(t.button.skipSmite).setStyle(ButtonStyle.Secondary),
      ),
    );
  return cardPayload(container);
}
