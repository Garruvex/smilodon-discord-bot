import { app } from "./state.js";
import { showRolls } from "./dice.js";
import { liveScreen, lobbyScreen } from "./dom.js";
import { languageFromBrowser, setLanguage, t } from "./i18n.js";
import { showError } from "./lobby.js";
import { openCharactersScreen, wireCharacterScreen } from "./character-builder.js";
import { wireArtworkViewer } from "./artwork-viewer.js";
import { wireRulesBook } from "./rules-book.js";
import "./level-up.js";
import { bindMapControls } from "./map.js";
import { setTableConnectionState } from "./poll.js";
import { designPreviewSnapshot, previewStoryNext } from "./preview.js";
import { renderGame } from "./render.js";
import { mountDrawers } from "./drawers.js";
import { authenticate } from "./session.js";
import { wireTableLifecycle } from "./table-lifecycle.js";

bindMapControls();
wireTableLifecycle();
mountDrawers();
wireCharacterScreen();
wireArtworkViewer();
wireRulesBook();


if (new URLSearchParams(window.location.search).has("design-preview")) {
  const charactersPreview = new URLSearchParams(window.location.search).has("characters-preview");
  lobbyScreen.hidden = true;
  liveScreen.hidden = charactersPreview;
  const preview = designPreviewSnapshot();
  const requestedLanguage = new URLSearchParams(window.location.search).get("language");
  const previewLanguage = requestedLanguage === null ? languageFromBrowser() : requestedLanguage === "zh-TW" ? "zh-TW" : "en";
  app.discordLanguage = previewLanguage;
  app.currentSnapshot = preview;
  if (charactersPreview) {
    void setLanguage(previewLanguage).then(() => {
      document.querySelector("#server-label").textContent = previewLanguage === "zh-TW" ? "預覽伺服器" : "Preview server";
      document.querySelector("#lobby-message").hidden = true;
      document.querySelector("#lobby-empty").hidden = false;
      document.querySelector("#lobby-user").textContent = previewLanguage === "zh-TW" ? "設計預覽" : "Design preview";
      const note = document.createElement("p");
      note.className = "characters-preview-note";
      note.textContent = previewLanguage === "zh-TW" ? "設計預覽 · 範例角色只會保留到頁面重新整理。" : "Design preview · sample characters reset when you refresh this page.";
      document.querySelector("#characters-screen .characters-intro").after(note);
      openCharactersScreen();
    });
  } else if (new URLSearchParams(window.location.search).has("lobby-preview")) {
    app.currentGameId = "local-preview";
    Object.assign(preview, {
      kind: "lobby", campaignName: previewLanguage === "zh-TW" ? "提燈旅團" : "The Lantern Company", adventureTitle: previewLanguage === "zh-TW" ? "月下遺跡" : "Moonlit Ruins", language: previewLanguage,
      playerCount: 3, maxPlayers: 6, canStart: false, isOrganizer: true, isMember: true, canJoin: false, startBlockReason: "notReady", selectedHeroId: null,
      selectedHeroName: null, selectedHeroClass: null,
      members: [
        { heroName: previewLanguage === "zh-TW" ? "索恩・橡盾" : "Thorne Oakshield", className: "Paladin", ready: true, isYou: false },
        { heroName: previewLanguage === "zh-TW" ? "艾莉亞・維爾" : "Aria Vell", className: "Wizard", ready: true, isYou: false },
        { heroName: previewLanguage === "zh-TW" ? "選擇角色中" : "Choosing a character", className: null, ready: false, isYou: true },
      ],
      heroChoices: [
        { id: "mira", name: previewLanguage === "zh-TW" ? "米拉・芬" : "Mira Fen", className: "Ranger", available: true },
        { id: "pip", name: previewLanguage === "zh-TW" ? "皮普・安德堡" : "Pip Underbough", className: "Rogue", available: true },
        { id: "sable", name: previewLanguage === "zh-TW" ? "賽布爾・暮影" : "Sable Dusk", className: "Cleric", available: false },
      ],
      savedHeroChoices: [
        { id: "lib:preview-mira", name: previewLanguage === "zh-TW" ? "米拉・芬" : "Mira Fen", className: "Ranger", imageUrl: "/previews/mira.jpg" },
        { id: "lib:preview-pip", name: previewLanguage === "zh-TW" ? "皮普・安德堡" : "Pip Underbough", className: "Rogue", imageUrl: "/previews/pip.jpg" },
        { id: "lib:preview-sable", name: previewLanguage === "zh-TW" ? "賽布爾・暮影" : "Sable Dusk", className: "Cleric" },
      ],
    });
    void setLanguage(previewLanguage).then(() => { setTableConnectionState("live"); renderGame(preview); });
  } else {
  const overviewPreview = new URLSearchParams(window.location.search).has("overview-preview");
  const battlefieldPreview = new URLSearchParams(window.location.search).has("battlefield-preview");
  if (battlefieldPreview) {
    app.wasMyTurn = true;
    preview.party = preview.party.map((hero, index) => ({ ...hero, zone: index < 2 ? "Shattered dais" : "Broken gallery", imageUrl: index === 2 ? "/previews/mira.jpg" : index === 3 ? "/previews/pip.jpg" : null, deathSaves: null }));
    preview.order = preview.order.map((entry) => ({ ...entry, down: false }));
    for (const entry of [...preview.party.map((hero) => ({ ...hero, side: "party" })), ...preview.allies.map((ally) => ({ ...ally, side: "party" }))]) {
      if (!preview.order.some((turn) => turn.name === entry.name)) preview.order.push({ name: entry.name, side: entry.side, down: false, active: false });
    }
    preview.map.zones.forEach((zone) => { zone.occupants = [...preview.party.map((hero) => ({ ...hero, side: "party", active: hero.isYou })), ...preview.foes.map((foe) => ({ ...foe, side: "foes" }))].filter((entry) => entry.zone === zone.name); });
  }
  if (overviewPreview) {
    app.selectedPartyCharacterId = preview.myHero.characterId;
    app.selectedWorkspaceTab = "overview";
    app.wasMyTurn = true;
    preview.myHero.imageUrl = "/previews/mira.jpg";
    preview.party[0].imageUrl = "/previews/mira.jpg";
  }
  if (new URLSearchParams(window.location.search).has("state-preview")) {
    const effects = previewLanguage === "zh-TW" ? ["專注", "祝福"] : ["Concentrating", "Blessed"];
    preview.party = preview.party.map((hero) => hero.characterId === "aria" ? { ...hero, hp: 21, conditions: effects } : hero);
    preview.myHero = { ...preview.myHero, hp: 21, conditions: effects };
  }
  if (new URLSearchParams(window.location.search).has("down-preview")) {
    preview.party = preview.party.map((hero) => hero.characterId === "aria" ? { ...hero, hp: 0, down: true, conditions: [] } : hero);
    preview.myHero = { ...preview.myHero, hp: 0, conditions: [] };
  }
  if (new URLSearchParams(window.location.search).has("member-preview")) {
    app.selectedPartyCharacterId = "thorne";
    app.selectedWorkspaceTab = "overview";
  }
  if (new URLSearchParams(window.location.search).has("party-states")) {
    preview.party = preview.party.map((hero) => hero.characterId === "pip" ? { ...hero, presence: "away" }
      : hero.characterId === "sable" ? { ...hero, hp: 0, down: true }
        : hero.characterId === "kestrel" ? { ...hero, hp: 0, fallen: true }
          : hero);
  }
  if (new URLSearchParams(window.location.search).has("join-preview")) {
    preview.myHero = null;
    preview.canBegin = false;
    preview.joinRequestStatus = "queued";
    preview.queuedJoin = { heroName: previewLanguage === "zh-TW" ? "新加入的冒險者" : "New Adventurer", encounterRound: 4, nextEncounter: false };
  }
  if (new URLSearchParams(window.location.search).has("roll")) {
    preview.mode = "awaitingRolls";
    preview.yourTurn = false;
    preview.activeName = null;
    preview.pendingRoll = { checkId: "preview-check", test: { kind: "skill", skill: "arcana" }, action: "Identify the runes before the sentinel moves." };
    preview.pendingRollCount = 1;
    app.currentGameId = "local-preview";
    preview.party = preview.party.map((hero) => ({ ...hero, tableStatus: "waiting" }));
  }
  if (new URLSearchParams(window.location.search).has("vote") || new URLSearchParams(window.location.search).has("collect")) {
    preview.mode = "collecting";
    preview.yourTurn = false;
    preview.activeName = null;
    preview.foes = [];
    preview.turn = null;
    if (new URLSearchParams(window.location.search).has("vote")) {
      preview.canVoteMove = !new URLSearchParams(window.location.search).has("away");
      if (!preview.canVoteMove) preview.ownPresence = "away";
      preview.pendingMove = { sceneId: "gallery", present: 6, needed: 3, closesAt: Date.now() + 83000, sceneTitle: previewLanguage === "zh-TW" ? "破碎長廊" : "Broken Gallery", sceneDescription: previewLanguage === "zh-TW" ? "月光照亮橫跨裂縫的長廊，東側拱門通往古老的觀星台。" : "A moonlit gallery crosses a deep fissure. Its eastern arch leads toward the old observatory.", proposedBy: previewLanguage === "zh-TW" ? "米拉・芬" : "Mira Fen", supporters: [previewLanguage === "zh-TW" ? "米拉・芬" : "Mira Fen"], staying: [previewLanguage === "zh-TW" ? "索恩・橡盾" : "Thorne Oakshield"], choiceByYou: new URLSearchParams(window.location.search).has("stay") ? "stay" : null };
    }
  }
  void setLanguage(previewLanguage).then(() => {
    setTableConnectionState("live");
    renderGame(preview);
    if (overviewPreview) requestAnimationFrame(() => document.querySelector(".live-hero").scrollIntoView({ block: "start" }));
    if (battlefieldPreview) requestAnimationFrame(() => document.querySelector(".live-enemies").scrollIntoView({ block: "start" }));
    if (new URLSearchParams(window.location.search).has("story-live")) {
      let n = 0;
      setInterval(() => { preview.story = [...preview.story, previewStoryNext(n)]; n += 1; renderGame(preview); }, 4000);
    }
    const rollPreview = new URLSearchParams(window.location.search).get("roll-preview");
    if (rollPreview === "20" || rollPreview === "1") {
      const natural = Number(rollPreview);
      showRolls([{ id: `preview-roll-${natural}`, test: { kind: "skill", skill: "persuasion" }, natural, total: natural === 20 ? 25 : 4, dc: 15, success: natural === 20, moment: natural === 20 ? "natural20" : "natural1" }]);
    }
  });
  }
} else {
  void authenticate().catch((error) => {
    console.warn(`Discord Activity failed during ${app.connectionStage}.`, error);
    showError(error instanceof Error ? error.message : t("activity.connection.signInFailed"));
  });
}

