import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";

import type { ReactionView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";

// A hit waiting on its target's reaction (Shield): shows in the Adventure
// channel until it is answered. Ownership and staleness are checked again by
// the engine on every click, the same as an offer card's buttons.
export function renderReactionCard(view: ReactionView, text: Texts, campaignId: string): CardPayload {
  const t = text.campaign;
  const lines = [
    t.reaction.title({ attacker: view.attackerName, target: view.targetName, natural: view.natural, total: view.total }),
    t.reaction.player({ user: `<@${view.targetUserId}>` }),
    ...(view.closesAt === null ? [] : [`-# ${t.reaction.closes({ when: `<t:${Math.floor(view.closesAt / 1000)}:R>` })}`]),
  ];
  const container = new ContainerBuilder()
    .setAccentColor(accents.red)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...view.options.map((option) =>
          new ButtonBuilder()
            .setCustomId(campaignCustomId("reactCast", campaignId, option.spellId))
            .setLabel(t.reaction.option({ spell: option.spellName, slot: option.slotLevel }))
            .setStyle(ButtonStyle.Success),
        ),
        new ButtonBuilder().setCustomId(campaignCustomId("reactDecline", campaignId)).setLabel(t.button.takeHit).setStyle(ButtonStyle.Secondary),
      ),
    );
  return cardPayload(container);
}
