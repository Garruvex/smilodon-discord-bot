import { ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from "discord.js";

import type { CampaignLifecycle } from "../../../application/campaign/ports/campaign-record.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { accents, cardPayload, cardLimits, type CardPayload } from "./card-payload.js";

export interface HubGame {
  readonly name: string;
  readonly lifecycle: CampaignLifecycle;
  readonly players: number;
  readonly maxPlayers: number;
  readonly partyChannelId: string | null;
  readonly adventureChannelId: string | null;
}

// The hub channel's single message: every game on the server, one line each,
// with clickable channel mentions. Finished games sort last and are the first
// to be dropped when the list would not fit one message.
export function renderHubCard(games: readonly HubGame[], text: Texts): CardPayload {
  const t = text.campaign.hub;
  const order: Record<CampaignLifecycle, number> = { lobby: 0, active: 1, paused: 1, archived: 2 };
  const sorted = [...games].sort((a, b) => order[a.lifecycle] - order[b.lifecycle]);
  const line = (game: HubGame): string => {
    const label =
      game.lifecycle === "lobby"
        ? t.gameLobby({ name: game.name, count: game.players, max: game.maxPlayers })
        : game.lifecycle === "active"
          ? t.gameActive({ name: game.name, count: game.players })
          : game.lifecycle === "paused"
            ? t.gamePaused({ name: game.name, count: game.players })
            : t.gameFinished({ name: game.name });
    const links = [game.partyChannelId, game.adventureChannelId].flatMap((id) => (id === null ? [] : [`<#${id}>`]));
    return links.length === 0 ? label : `${label} · ${links.join(" · ")}`;
  };
  const header = `## ${t.title}\n${t.intro}`;
  const lines: string[] = [];
  let length = header.length;
  for (const game of sorted) {
    const next = line(game);
    if (length + next.length + 1 > cardLimits.characters - 100) break;
    lines.push(next);
    length += next.length + 1;
  }
  const hidden = sorted.length - lines.length;
  const body = lines.length === 0 ? t.empty : lines.join("\n") + (hidden > 0 ? `\n-# +${hidden}` : "");
  const container = new ContainerBuilder()
    .setAccentColor(accents.blue)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  return cardPayload(container);
}
