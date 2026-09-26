import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from "discord.js";

import type { Texts } from "../../../application/i18n/texts.js";
import type { LobbyView } from "../../../application/campaign/views/campaign-views.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";
import { campaignCustomId } from "./campaign-ids.js";

const mention = (userId: string): string => `<@${userId}>`;

// The Party channel's lobby card (panel spec, Campaign card: lobby state).
// Join is off at capacity or once the lobby closes; Start is off while a
// prerequisite is missing, and the card says which. Enabled buttons are not
// authorization: every click is checked again on the server.
export function renderLobbyCard(view: LobbyView, text: Texts, campaignId: string): CardPayload {
  const t = text.campaign;
  const pacing = t.pacing[view.pacingPreset];
  const language = view.language === "en" ? t.language.en : t.language.zhTW;
  const lines = view.members.map((member) =>
    member.status === "ready" && member.heroName !== null
      ? t.lobby.memberReady({ user: mention(member.userId), hero: member.heroName, class: member.className ?? "" })
      : t.lobby.memberCreating({ user: mention(member.userId) }),
  );
  const status = !view.open
    ? t.lobby.started
    : view.missing === "notEnoughPlayers"
      ? t.lobby.waitingPlayers({ min: view.minPlayers })
      : view.missing === "notReady"
        ? t.lobby.waitingReady
        : t.lobby.readyToStart;

  const container = new ContainerBuilder()
    .setAccentColor(accents.green)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `## ${t.lobby.title({ name: view.campaignName })}`,
          t.lobby.subtitle({ count: view.members.length, max: view.maxPlayers, pacing, language }),
          `-# ${t.lobby.adventure({ title: view.adventureTitle })} · ${t.lobby.organizer({ user: mention(view.organizerId) })}`,
        ].join("\n"),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${lines.length === 0 ? t.lobby.empty : lines.join("\n")}\n\n${status}`))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("join", campaignId, t.button.join, ButtonStyle.Success, !view.canJoin),
        button("pickHero", campaignId, t.button.chooseHero, ButtonStyle.Primary, !view.open),
        button("leave", campaignId, t.button.leave, ButtonStyle.Secondary, !view.open),
        button("start", campaignId, t.button.start, ButtonStyle.Primary, !view.open || view.missing !== null),
      ),
    );
  return cardPayload(container);
}

function button(action: Parameters<typeof campaignCustomId>[0], campaignId: string, label: string, style: ButtonStyle, disabled: boolean): ButtonBuilder {
  return new ButtonBuilder().setCustomId(campaignCustomId(action, campaignId)).setLabel(label).setStyle(style).setDisabled(disabled);
}
