import { describe, expect, it } from "vitest";

import type { LobbyView } from "../../../../src/application/campaign/views/campaign-views.js";
import { texts } from "../../../../src/application/i18n/texts.js";
import { campaignCustomId, parseCampaignId } from "../../../../src/infrastructure/discord/campaign/campaign-ids.js";
import { accents, cardLimits } from "../../../../src/infrastructure/discord/campaign/card-payload.js";
import { renderLobbyCard } from "../../../../src/infrastructure/discord/campaign/lobby-card.js";
import { flatten } from "./card-helpers.js";

const view: LobbyView = {
  campaignName: "Moonlit Ruins",
  adventureTitle: "The Moonlit Ruins",
  language: "en",
  organizerId: "111",
  pacingPreset: "live",
  members: [
    { userId: "111", status: "ready", heroName: "Mira", className: "Rogue" },
    { userId: "222", status: "creating", heroName: null, className: null },
  ],
  minPlayers: 2,
  maxPlayers: 3,
  open: true,
  canJoin: true,
  missing: "notReady",
};

describe("campaign custom IDs", () => {
  it("round-trips, keeps arguments, and rejects anything else", () => {
    expect(parseCampaignId(campaignCustomId("join", "abc"))).toEqual({ action: "join", campaignId: "abc", argument: null });
    expect(parseCampaignId(campaignCustomId("heroChoice", "abc", "c-mira"))).toEqual({ action: "heroChoice", campaignId: "abc", argument: "c-mira" });
    expect(parseCampaignId("poll:vote:1")).toBeNull();
    expect(parseCampaignId("dnd:explode:abc")).toBeNull();
    expect(parseCampaignId("dnd:join:")).toBeNull();
    expect(() => campaignCustomId("join", "x".repeat(120))).toThrow("100");
  });
});

describe("the lobby card", () => {
  it("shows the roster and status in English, with Start off until everyone is ready", () => {
    const card = flatten(renderLobbyCard(view, texts.en, "camp-1"));
    expect(card.accent).toBe(accents.green);
    expect(card.text).toContain("## Moonlit Ruins — Lobby");
    expect(card.text).toContain("2 / 3 players · Live · English");
    expect(card.text).toContain("<@111> — Mira, Rogue — Ready");
    expect(card.text).toContain("<@222> — Choosing a hero");
    expect(card.text).toContain("Waiting for everyone to choose a hero.");
    expect(card.buttons).toEqual([
      { id: "dnd:join:camp-1", label: "Join", disabled: false },
      { id: "dnd:pickHero:camp-1", label: "My Hero", disabled: false },
      { id: "dnd:leave:camp-1", label: "Leave", disabled: false },
      { id: "dnd:start:camp-1", label: "Start Adventure", disabled: true },
    ]);
    expect(card.componentCount).toBeLessThan(cardLimits.components);
  });

  it("enables Start when ready, and disables Join at capacity", () => {
    const ready = flatten(renderLobbyCard({ ...view, missing: null, canJoin: false }, texts.en, "c"));
    expect(ready.text).toContain("Ready. The organizer can start the adventure.");
    expect(ready.buttons.map((button) => [button.label, button.disabled])).toEqual([
      ["Join", true],
      ["My Hero", false],
      ["Leave", false],
      ["Start Adventure", false],
    ]);
  });

  it("explains too few players, and turns every control off once the adventure started", () => {
    expect(flatten(renderLobbyCard({ ...view, missing: "notEnoughPlayers" }, texts.en, "c")).text).toContain("Waiting for at least 2 players.");
    const started = flatten(renderLobbyCard({ ...view, open: false, canJoin: false, missing: null }, texts.en, "c"));
    expect(started.text).toContain("The adventure has begun.");
    expect(started.buttons.every((button) => button.disabled)).toBe(true);
  });

  it("speaks Traditional Chinese for a zh-TW campaign, with short button labels", () => {
    const card = flatten(renderLobbyCard({ ...view, language: "zh-TW", pacingPreset: "playByPost" }, texts["zh-TW"], "c"));
    expect(card.text).toContain("Moonlit Ruins — 大廳");
    expect(card.text).toContain("論壇式");
    expect(card.text).toContain("<@222> — 正在選擇英雄");
    expect(card.buttons.map((button) => button.label)).toEqual(["加入", "我的英雄", "離開", "開始冒險"]);
    expect(card.buttons.every((button) => [...button.label].length <= 6)).toBe(true);
  });

  it("never pings anyone, whatever a campaign is called", () => {
    const payload = renderLobbyCard({ ...view, campaignName: "@everyone" }, texts.en, "c");
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(flatten(payload).text).toContain("@everyone");
  });
});
