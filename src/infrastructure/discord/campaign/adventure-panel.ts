import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from "discord.js";

import type { PanelMode, PanelView, RosterEntry } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId, type CampaignAction } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";

const accentFor: Readonly<Record<PanelMode, number>> = {
  collecting: accents.green,
  planning: accents.amber,
  awaitingRolls: accents.amber,
  combat: accents.red,
  waiting: accents.gray,
  paused: accents.gray,
  recovery: accents.gray,
  archived: accents.gray,
};

// Which controls each state shows (panel spec, State and control matrix). A
// shared message shows the same buttons to everyone; every click is checked
// again on the server, and a click that cannot apply gets a private reply.
const controlsFor: Readonly<Record<PanelMode, readonly CampaignAction[]>> = {
  collecting: ["act", "pass", "myHero", "away"],
  planning: ["myHero", "away"],
  awaitingRolls: ["roll", "myHero", "away"],
  combat: ["myHero"],
  waiting: ["continue", "back", "myHero"],
  paused: ["myHero"],
  recovery: ["myHero"],
  archived: [],
};

// The Adventure channel's one live control message, replaced at each round
// boundary. Deadlines are Discord relative timestamps, so the message never
// needs editing every second.
export function renderAdventurePanel(view: PanelView, text: Texts, campaignId: string): CardPayload {
  const t = text.campaign;
  const mode = t.mode[view.mode];
  const heading =
    view.roundNumber === null ? t.panel.heading({ scene: view.sceneTitle, mode }) : t.panel.headingRound({ scene: view.sceneTitle, mode, round: view.roundNumber });
  const container = new ContainerBuilder()
    .setAccentColor(accentFor[view.mode])
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${heading}\n${statusLine(view, text)}`));

  const details = view.mode === "combat" ? combatLines(view, text) : rosterLine(view.roster, text);
  if (details !== "") container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(new TextDisplayBuilder().setContent(details));

  const controls = controlsFor[view.mode];
  if (controls.length > 0) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(controls.map((action) => controlButton(action, campaignId, text, view))),
    );
  }
  return cardPayload(container);
}

function statusLine(view: PanelView, text: Texts): string {
  const t = text.campaign.panel;
  switch (view.mode) {
    case "collecting":
      return `${t.collecting} ${view.closesAt === null ? t.noTimer : t.closes({ when: relative(view.closesAt) })}`;
    case "planning":
      return t.planning;
    case "awaitingRolls":
      return `${t.awaitingRolls({ heroes: view.pendingRolls.map((roll) => roll.heroName).join(", ") })}${view.closesAt === null ? "" : ` ${t.closes({ when: relative(view.closesAt) })}`}`;
    case "combat":
      return view.combat === null
        ? ""
        : view.combat.activeName === null
          ? t.combatIdle({ round: view.combat.round })
          : `${t.combat({ round: view.combat.round, name: view.combat.activeName })}${view.closesAt === null ? "" : ` ${t.closes({ when: relative(view.closesAt) })}`}`;
    case "waiting":
      return t.waiting;
    case "paused":
      return t.paused;
    case "recovery":
      return t.recovery;
    case "archived":
      return t.archived;
  }
}

function rosterLine(roster: readonly RosterEntry[], text: Texts): string {
  return roster.map((entry) => `${entry.heroName} ${text.campaign.roster[entry.status]}`).join(" · ");
}

function combatLines(view: PanelView, text: Texts): string {
  const combat = view.combat;
  if (combat === null) return "";
  const t = text.campaign;
  const party = combat.party.map((hero) => t.panel.hero({ name: hero.name, hp: Math.max(0, hero.hp), max: hero.maxHp })).join(" · ");
  const foes = combat.foes.map((foe) => t.panel.foe({ name: foe.name, band: t.band[foe.band] })).join(" · ");
  return `${party}\n${foes}`;
}

function controlButton(action: CampaignAction, campaignId: string, text: Texts, view: PanelView): ButtonBuilder {
  const t = text.campaign.button;
  const labels: Partial<Record<CampaignAction, string>> = {
    act: t.act,
    pass: t.pass,
    roll: t.roll,
    myHero: t.myHero,
    away: t.away,
    back: t.back,
    continue: t.continue,
  };
  const style = action === "act" || action === "roll" || action === "continue" ? ButtonStyle.Primary : ButtonStyle.Secondary;
  // Roll is enabled while a check waits; the click still finds the clicker's own.
  const disabled = action === "roll" && view.pendingRolls.length === 0;
  return new ButtonBuilder().setCustomId(campaignCustomId(action, campaignId)).setLabel(labels[action] ?? action).setStyle(style).setDisabled(disabled);
}

function relative(milliseconds: number): string {
  return `<t:${Math.floor(milliseconds / 1000)}:R>`;
}
