import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";

import type { CampaignLifecycle } from "../../../application/campaign/ports/campaign-record.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";
import { hubCustomId } from "./hub-ids.js";

export interface HubGame {
  readonly campaignId: string;
  readonly name: string;
  readonly lifecycle: CampaignLifecycle;
  readonly players: number;
  readonly maxPlayers: number;
  readonly partyChannelId: string | null;
  readonly adventureChannelId: string | null;
}

// The hub's first, pinned message: what the hub is for and the Create game
// button. It is the oldest message in the channel, with one message per live
// game below it.
export function renderHubControl(gameCount: number, text: Texts): CardPayload {
  const t = text.campaign.hub;
  const container = new ContainerBuilder()
    .setAccentColor(accents.blue)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${t.title}\n${t.intro}${gameCount === 0 ? `\n\n${t.empty}` : ""}`))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(hubCustomId("create")).setLabel(t.createButton).setStyle(ButtonStyle.Success),
      ),
    );
  return cardPayload(container);
}

// One live game's message: its state, links to its channels, and Manage.
export function renderHubGame(game: HubGame, text: Texts): CardPayload {
  const t = text.campaign.hub;
  const status =
    game.lifecycle === "lobby"
      ? t.gameLobby({ count: game.players, max: game.maxPlayers })
      : game.lifecycle === "paused"
        ? t.gamePaused({ count: game.players })
        : game.lifecycle === "archived"
          ? t.gameFinished
          : t.gameActive({ count: game.players });
  const links = [
    game.partyChannelId === null ? null : `${t.linkParty}: <#${game.partyChannelId}>`,
    game.adventureChannelId === null ? null : `${t.linkAdventure}: <#${game.adventureChannelId}>`,
  ].filter((link): link is string => link !== null);
  const accent = game.lifecycle === "active" ? accents.green : game.lifecycle === "paused" ? accents.amber : game.lifecycle === "archived" ? accents.gray : accents.blue;
  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([`### ${game.name}`, status, ...(links.length === 0 ? [] : [`-# ${links.join(" · ")}`])].join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(hubCustomId("manage", game.campaignId)).setLabel(t.manageButton).setStyle(ButtonStyle.Secondary),
      ),
    );
  return cardPayload(container);
}

// Kept so a caller that draws a game list can keep it out of the way: a game
// counts as live until it is archived.
export const isLiveGame = (game: Pick<HubGame, "lifecycle">): boolean => game.lifecycle !== "archived";
