import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";

import type { OfferView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";

// An item offered from one hero to another, in the Party channel until it is
// answered (Inventory and trade). The receiving hero's owner accepts or
// declines; the giver can take it back. Each press is checked again by the
// engine, so the buttons carry no authority.
export function renderOfferCard(view: OfferView, text: Texts, campaignId: string, nameOf: (id: string) => string): CardPayload {
  const t = text.campaign;
  const line =
    view.want === null
      ? t.offer.line({ from: view.fromName, item: nameOf(view.give), to: view.toName })
      : t.offer.trade({ from: view.fromName, item: nameOf(view.give), to: view.toName, want: nameOf(view.want) });
  const container = new ContainerBuilder()
    .setAccentColor(accents.blue)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${line}\n${t.offer.player({ user: `<@${view.toUserId}>` })}`))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(campaignCustomId("offerYes", campaignId, view.id)).setLabel(t.button.accept).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(campaignCustomId("offerNo", campaignId, view.id)).setLabel(t.button.decline).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(campaignCustomId("offerCancel", campaignId, view.id)).setLabel(t.button.cancelOffer).setStyle(ButtonStyle.Secondary),
      ),
    );
  return cardPayload(container);
}
