import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";

import type { OpportunityAttackView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";

// A mover leaving reach, waiting on the provoker's reaction: shows in the
// Adventure channel until it is answered. Ownership and staleness are
// checked again by the engine on every click, the same as a reaction card's.
export function renderOpportunityAttackCard(view: OpportunityAttackView, text: Texts, campaignId: string): CardPayload {
  const t = text.campaign;
  const lines = [
    t.opportunity.title({ mover: view.moverName, provoker: view.provokerName }),
    t.opportunity.player({ user: `<@${view.provokerUserId}>` }),
    ...(view.closesAt === null ? [] : [`-# ${t.opportunity.closes({ when: `<t:${Math.floor(view.closesAt / 1000)}:R>` })}`]),
  ];
  const container = new ContainerBuilder()
    .setAccentColor(accents.red)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(campaignCustomId("opportunityTake", campaignId)).setLabel(t.button.takeOpportunity).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(campaignCustomId("opportunityHold", campaignId)).setLabel(t.button.holdOpportunity).setStyle(ButtonStyle.Secondary),
      ),
    );
  return cardPayload(container);
}
