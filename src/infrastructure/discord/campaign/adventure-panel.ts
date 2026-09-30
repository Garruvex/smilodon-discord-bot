import { worldLine } from "./world-text.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder, escapeMarkdown } from "discord.js";

import type { PanelMode, PanelView, RosterEntry } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { campaignCustomId, type CampaignAction } from "./campaign-ids.js";
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

// Which controls each state shows (panel spec, State and control matrix). A
// shared message shows the same buttons to everyone; every click is checked
// again on the server, and a click that cannot apply gets a private reply.
const controlsFor: Readonly<Record<PanelMode, readonly CampaignAction[]>> = {
  opening: ["myHero", "away"],
  readyCheck: ["ready", "begin", "myHero", "away"],
  collecting: ["act", "speak", "pass", "myHero", "away"],
  planning: ["myHero", "away"],
  awaitingRolls: ["roll", "myHero", "away"],
  combat: ["myHero"],
  waiting: ["continue", "away", "myHero"],
  paused: ["myHero"],
  safety: ["myHero"],
  recovery: ["myHero"],
  archived: [],
};

// A fight the players play: Take turn opens the private turn menu.
const combatControls: readonly CampaignAction[] = ["turn", "endTurn", "speak", "myHero", "away"];

// The second row, in every state until the game is over: the way to stop play
// for a moment, and the help and links.
const safetyControls: readonly CampaignAction[] = ["safety", "more"];

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
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${heading}\n${statusLine(view, text)}${view.world === undefined ? "" : `\n-# ${worldLine(view.world, text)}`}`));

  const details = view.mode === "combat" ? combatLines(view, text) : rosterLine(view.roster, text);
  if (details !== "") container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(new TextDisplayBuilder().setContent(details));

  const controls = view.mode === "combat" && view.combat?.playersControl === true ? combatControls : controlsFor[view.mode];
  if (controls.length > 0) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(controls.map((action) => controlButton(action, campaignId, text))),
    );
  }
  if (view.mode !== "archived") {
    // Explore (people, shops, spells) is for between fights.
    // Away and back are one toggle, present in every state so a player marked away can always return (the first row may already hold it).
    const toggle: readonly CampaignAction[] = controls.includes("away") ? [] : ["away"];
    const second: readonly CampaignAction[] = view.mode === "combat" ? [...safetyControls, ...toggle] : ["explore", ...safetyControls, ...toggle];
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(second.map((action) => controlButton(action, campaignId, text))));
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
      return view.combat === null
        ? ""
        : view.combat.activeName === null
          ? t.combatIdle({ round: view.combat.round })
          : `${t.combatTurn({ name: displayName(view.combat.activeName) })}${view.closesAt === null ? "" : `\n${t.turnDeadline({ date: timestamp(view.closesAt, "d"), time: timestamp(view.closesAt, "t") })}`}`;
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

function controlButton(action: CampaignAction, campaignId: string, text: Texts): ButtonBuilder {
  const t = text.campaign.button;
  const labels: Partial<Record<CampaignAction, string>> = {
    act: t.act,
    pass: t.pass,
    roll: t.roll,
    myHero: t.myHero,
    away: t.away,
    back: t.back,
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
