import { worldLine } from "./world-text.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder, escapeMarkdown } from "discord.js";

import type { PanelMode, PanelView, RosterEntry } from "../../../application/campaign/views/campaign-views.js";
import { panelActions, type PanelActionId } from "../../../application/campaign/views/panel-actions.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId } from "./campaign-ids.js";
import { accents, cardPayload, type CardPayload } from "./card-payload.js";
import { hpBar } from "./hero-card.js";
import { checkLabel } from "./text-keys.js";

const accentFor: Readonly<Record<PanelMode, number>> = {
  opening: accents.amber,
  readyCheck: accents.amber,
  collecting: accents.green,
  planning: accents.amber,
  awaitingRolls: accents.amber,
  combat: accents.red,
  waiting: accents.gray,
  paused: accents.gray,
  safety: accents.gray,
  recovery: accents.gray,
  archived: accents.gray,
};

// The Adventure channel's one live control message, replaced at each round
// boundary. Deadlines are Discord relative timestamps, so the message never
// needs editing every second.
export function renderAdventurePanel(view: PanelView, text: Texts, campaignId: string, partyUrl: string | null = null): CardPayload {
  const t = text.campaign;
  const mode = t.mode[view.mode];
  const heading =
    view.mode === "combat" && view.combat?.activeName != null
      ? t.panel.combatTurn({ name: displayName(view.combat.activeName) })
      : view.roundNumber === null ? t.panel.heading({ scene: view.sceneTitle, mode }) : t.panel.headingRound({ scene: view.sceneTitle, mode, round: view.roundNumber });
  const container = new ContainerBuilder()
    .setAccentColor(accentFor[view.mode])
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${heading}\n${statusLine(view, text)}${view.world === undefined ? "" : `\n-# ${worldLine(view.world, text)}`}`));

  const details = view.mode === "combat" ? combatLines(view, text) : rosterLine(view.roster, text);
  if (details !== "") container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(new TextDisplayBuilder().setContent(details));

  const { primary, secondary } = panelActions(view);
  if (primary.length > 0) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(primary.map((action) => controlButton(action, campaignId, text))),
    );
  }
  if (secondary.length > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(secondary.map((action) => controlButton(action, campaignId, text)));
    // A link button needs no click handler: it takes a player straight to the Party channel and its hero cards.
    if (partyUrl !== null) row.addComponents(new ButtonBuilder().setURL(partyUrl).setLabel(text.campaign.button.partyChannel).setStyle(ButtonStyle.Link));
    container.addActionRowComponents(row);
  }
  return cardPayload(container);
}

function statusLine(view: PanelView, text: Texts): string {
  const t = text.campaign.panel;
  switch (view.mode) {
    case "collecting":
      return `${t.collecting} ${view.closesAt === null ? t.noTimer : t.closes({ when: relative(view.closesAt) })}`;
    case "opening":
      return t.opening;
    case "readyCheck":
      return t.readyCheck;
    case "planning":
      return t.planning;
    case "awaitingRolls":
      return [
        `${t.awaitingRolls}${view.closesAt === null ? "" : ` ${t.closes({ when: relative(view.closesAt) })}`}`,
        ...view.pendingRolls.map((roll) => {
          const hero = displayName(roll.heroName);
          const check = checkLabel(roll.test, text);
          // The player's own words are why the dice are called for; a long one is cut.
          const action = roll.action === null ? "" : escapeMarkdown(roll.action.replace(/\s+/g, " ").trim().slice(0, 80));
          return action === "" ? t.rollWhyBare({ hero, check }) : t.rollWhy({ hero, check, action });
        }),
      ].join("\n");
    case "combat":
      if (view.combat === null) return "";
      return [
        ...((view.combat.upcoming?.length ?? 0) === 0 ? [] : [t.upNext({ names: view.combat.upcoming!.map((name) => `**${displayName(name)}**`).join(" → ") })]),
        `${displayName(view.sceneTitle)} · ${t.combatIdle({ round: view.combat.round })}`,
        ...(view.closesAt === null ? [] : [t.turnDeadline({ date: timestamp(view.closesAt, "d"), time: timestamp(view.closesAt, "t") })]),
        ...(view.combat.playersControl ? [t.turnControls] : []),
      ].join("\n");
    case "waiting":
      return t.waiting;
    case "paused":
      return t.paused;
    case "safety":
      return t.safety;
    case "recovery":
      return t.recovery;
    case "archived":
      return t.archived;
  }
}

function rosterLine(roster: readonly RosterEntry[], text: Texts): string {
  return roster.map((entry) => `${entry.heroName} ${text.campaign.roster[entry.status]}`).join(" · ");
}

// Separate sides, one combatant per line. A crowded fight keeps the active
// combatant visible and reserves room for both sides within Discord's limit.
function combatLines(view: PanelView, text: Texts): string {
  const combat = view.combat;
  if (combat === null) return "";
  const t = text.campaign;
  const location = (zone: string): string => combat.zones.length > 1 ? ` · 📍 ${displayName(zone)}` : "";
  const party = [...combat.party].sort((a, b) => Number(b.active) - Number(a.active)).map((hero) => {
    const condition = hero.condition === "dead" ? t.hero.fallen : hero.condition === "fled" ? t.panel.combatFled : hero.condition === "stable" ? t.panel.combatStable : hero.hp <= 0 ? t.hero.down : "";
    return `${hero.active ? "▶" : "•"} **${displayName(hero.name)}** · ${hpBar(hero.hp, hero.maxHp)} ${t.panel.combatHp({ hp: Math.max(0, hero.hp), max: hero.maxHp })}${hero.tempHp > 0 ? ` · ${t.panel.combatTempHp({ hp: hero.tempHp })}` : ""}${condition === "" ? "" : ` · ${condition}`}${location(hero.zone)}`;
  });
  const foes = [...combat.foes].sort((a, b) => Number(b.active) - Number(a.active)).map((foe) =>
    `${foe.active ? "▶" : "•"} **${displayName(foe.name)}** · ${hpBar(foe.hp, foe.maxHp)} ${t.panel.combatHp({ hp: Math.max(0, foe.hp), max: foe.maxHp })} · ${t.band[foe.band]}${location(foe.zone)}`,
  );
  return [boundedRoster(t.panel.combatParty({ count: party.length }), party, text), boundedRoster(t.panel.combatFoes({ count: foes.length }), foes, text)].filter(Boolean).join("\n\n");
}

function boundedRoster(heading: string, lines: readonly string[], text: Texts): string {
  if (lines.length === 0) return "";
  const shown: string[] = [];
  let length = heading.length + 8;
  for (const line of lines) {
    if (length + line.length + 1 > 1450) break;
    shown.push(line);
    length += line.length + 1;
  }
  if (shown.length < lines.length) shown.push(text.campaign.panel.combatMore({ count: lines.length - shown.length }));
  return `### ${heading}\n${shown.join("\n")}`;
}

function displayName(name: string): string {
  return escapeMarkdown(name.replace(/[\r\n]/g, " ").slice(0, 64));
}

function controlButton(action: PanelActionId, campaignId: string, text: Texts): ButtonBuilder {
  const t = text.campaign.button;
  const labels: Readonly<Record<PanelActionId, string>> = {
    act: t.act,
    pass: t.pass,
    roll: t.roll,
    myHero: t.myHero,
    away: t.away,
    continue: t.continue,
    ready: t.ready,
    begin: t.begin,
    turn: t.turn,
    endTurn: t.endTurn,
    speak: t.speak,
    safety: t.safety,
    more: t.more,
    explore: t.explore,
  };
  const style = action === "act" || action === "roll" || action === "continue" || action === "ready" || action === "turn" ? ButtonStyle.Primary : ButtonStyle.Secondary;
  return new ButtonBuilder().setCustomId(campaignCustomId(action, campaignId)).setLabel(labels[action] ?? action).setStyle(style);
}

function relative(milliseconds: number): string {
  return `<t:${Math.floor(milliseconds / 1000)}:R>`;
}

function timestamp(milliseconds: number, style: "d" | "t"): string {
  return `<t:${Math.floor(milliseconds / 1000)}:${style}>`;
}
