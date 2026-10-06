import { app } from "./state.js";
import { renderTableActions } from "./actions.js";
import { showRolls, updateRollPrompt } from "./dice.js";
import { iconForClass, iconImage, liveScreen, setArtwork, setLiveMessage } from "./dom.js";
import { renderCharacterWorkspace, renderEquipment } from "./hero.js";
import { classText, t } from "./i18n.js";
import { renderLobby } from "./lobby.js";
import { renderJoiningPanel } from "./table-lifecycle.js";
import { renderMap } from "./map.js";
import { renderEnemies, renderParty } from "./party.js";
import { renderMoveNotice, renderPresenceToggle, syncAwayLock } from "./vote.js";
import { syncDrawers } from "./drawers.js";
import { renderStory } from "./story.js";
import { renderTableControls } from "./table-controls.js";

export const phaseKeys = { opening: "activity.phase.opening", readyCheck: "activity.status.gathering", collecting: "activity.phase.collecting", planning: "activity.phase.planning", awaitingRolls: "activity.phase.awaitingRolls", combat: "activity.phase.combat", waiting: "activity.phase.waiting", resting: "activity.phase.resting", paused: "activity.phase.paused", safety: "activity.phase.safety", recovery: "activity.phase.recovery", archived: "activity.phase.archived" };

export const paintedSections = new Map();


export function resetPaint() {
  app.lastGameSignature = "";
  app.actionsSignature = "";
  paintedSections.clear();
}


export function paintSection(name, inputs, paint) {
  const signature = JSON.stringify(inputs);
  if (paintedSections.get(name) === signature) return;
  paint();
  paintedSections.set(name, signature);
}


// The story's clock beside the round: "Day 3", "dusk" and "rain" as a card each. Nothing is shown for an adventure that keeps no clock.
function renderWorld(world) {
  let line = document.querySelector("#live-world");
  if (line === null) {
    line = document.createElement("span");
    line.id = "live-world";
    line.className = "live-world ui-status";
    document.querySelector(".live-header-status").append(line);
  }
  line.hidden = world === null || world === undefined;
  if (line.hidden) return;
  line.replaceChildren(...[["day", "day", t("activity.world.day", { day: world.day })], ["time", world.time, t("activity.world.time." + world.time)], ["weather", world.weather, world.weather === null ? null : t("activity.world.weather." + world.weather)]]
    .filter(([, , text]) => text !== null)
    .map(([kind, value, text]) => {
      const card = Object.assign(document.createElement("span"), { className: "live-world-card", textContent: text });
      card.dataset.kind = kind;
      card.dataset.value = value;
      return card;
    }));
}

export function renderGame(game) {
  const signature = JSON.stringify([app.uiLanguage, game, app.selectedPartyCharacterId, app.selectedEnemyName, app.selectedWorkspaceTab, app.mapPick]);
  if (signature === app.lastGameSignature) return;
  paintGame(game);
  app.lastGameSignature = signature;
}


export function paintGame(game) {
  app.classNames = game.classNames ?? {};
  document.querySelector("#table-lobby-screen").hidden = game.kind !== "lobby";
  liveScreen.hidden = game.kind === "lobby";
  document.querySelector("#table-manage").hidden = game.kind !== "table" || !game.canBegin;
  if (game.kind === "lobby") {
    renderLobby(game);
    syncDrawers(game);
    return;
  }
  renderJoiningPanel(game);
  liveScreen.dataset.mode = game.kind === "lobby" ? "lobby" : game.mode;
  document.querySelector("#live-campaign").textContent = game.campaignName;
  document.querySelector("#live-adventure").textContent = game.adventureTitle.toLocaleUpperCase();
  document.querySelector("#live-scene-eyebrow").textContent = game.kind === "lobby" ? t("activity.lobby.setupEyebrow") : t("activity.scene.label");
  document.querySelector("#live-scene-title").textContent = game.kind === "lobby" ? t("activity.lobby.chooseCharacter") : game.scene.title;
  document.querySelector("#live-scene-description").textContent = game.kind === "lobby"
    ? t("activity.lobby.chooseCharacterDescription")
    : game.scene.description;
  renderPresenceToggle(game);
  renderMoveNotice(game.kind === "table" ? game.pendingMove : null, game.kind === "table" && game.canVoteMove, game);
  showRolls(game.kind === "table" ? game.rolls ?? [] : []);
  document.querySelector(".live-scene").classList.toggle("has-enemies", game.kind === "table" && (game.foes?.length ?? 0) > 0);
  const sceneImage = document.querySelector("#live-scene-image");
  const sceneUrl = game.kind === "table" ? game.scene.imageUrl : null;
  // A fight's picture may not be there yet or may fail to load: the scene's own picture stays up instead of the placeholder.
  void setArtwork(sceneImage, document.querySelector(".scene-art-fallback"), sceneUrl, game.scene.title, true).then(() => {
    const fallback = game.kind === "table" ? game.scene.fallbackImageUrl : null;
    if (fallback && sceneImage.hidden && sceneImage.dataset.source === sceneUrl) void setArtwork(sceneImage, document.querySelector(".scene-art-fallback"), fallback, game.scene.title, true);
  });
  if (game.kind === "lobby") {
    document.querySelector(".adventure-map-panel").hidden = true;
    renderLobby(game);
  } else {
    document.querySelector(".adventure-map-panel").hidden = false;
    paintSection("map", [game.map, game.mapText, app.mapPick, app.uiLanguage], () => renderMap(game.map, game.mapText));
    renderTable(game);
  }
  syncAwayLock(game);
  syncDrawers(game);
  renderStory(game);
}


export function renderTable(game) {
  const phase = game.pendingMove ? t("activity.status.moveVoting") : t(phaseKeys[game.mode] ?? "activity.phase.adventure");
  document.querySelector("#live-phase").textContent = phase;
  document.querySelector("#live-round").textContent = game.roundNumber === null ? "" : t("activity.status.round", { round: game.roundNumber });
  renderWorld(game.world);
  document.querySelector(".live-phase").dataset.mode = game.mode;
  document.querySelector("#live-screen").dataset.mode = game.mode;
  const turn = document.querySelector("#live-turn");
  const ownStatus = game.submission === "action" ? t("activity.status.actionSubmitted") : game.submission === "pass" ? t("activity.status.passedRound") : game.pendingRoll ? t("activity.status.rollNeeded") : t("activity.status.waitTurn");
  turn.textContent = game.pendingMove ? t("activity.status.moveDecision") : game.yourTurn ? game.turn?.busy ? t("activity.status.resolvingAction") : t("activity.hero.turn") : game.mode === "collecting" && game.myHero ? ownStatus : game.activeName ? t("activity.status.activeTurnPossessive", { name: game.activeName }) : t("activity.status.waitTable");
  turn.classList.toggle("is-active", game.yourTurn);
  const hero = game.myHero;
  document.querySelector("#live-hero-name").textContent = hero?.name ?? t("activity.hero.notSelected");
  document.querySelector("#live-hero-subtitle").textContent = hero ? `${hero.raceName ?? t("activity.hero.adventurer")} ${classText(hero.className) ?? t("activity.hero.heroClass")} ${hero.level}` : t("activity.hero.joinToChoose");
  document.querySelector("#live-hero-class").textContent = (classText(hero?.className) ?? t("activity.hero.adventurerCaps")).toLocaleUpperCase();
  const classSigil = document.querySelector("#live-hero-sigil");
  classSigil.replaceChildren(iconImage(iconForClass(hero?.className)));
  void setArtwork(document.querySelector("#live-hero-image"), classSigil, hero?.imageUrl, t("activity.hero.portraitAlt", { name: hero?.name ?? t("activity.hero.heroClass") }));
  document.querySelector("#live-hero-hp").textContent = hero ? t("activity.hero.hp", { hp: hero.hp, max: hero.maxHp }) : "";
  document.querySelector("#live-hero-ac").textContent = hero ? t("activity.hero.ac", { value: hero.armorClass }) : "";
  document.querySelector("#live-hero-health").style.width = hero ? `${Math.max(0, Math.min(100, (hero.hp / Math.max(1, hero.maxHp)) * 100))}%` : "0%";
  if (hero) {
    renderEquipment(hero);
  } else {
    document.querySelector("#live-equipment").replaceChildren();
  }
  const readyCount = game.mode === "collecting" ? game.party.filter((hero) => hero.presence !== "away" && !hero.fallen && ["submitted", "passed"].includes(hero.tableStatus)).length : null;
  const presentCount = game.party.filter((hero) => hero.presence !== "away" && !hero.fallen).length;
  document.querySelector("#live-party-count").textContent = t("activity.party.count", { count: game.party.length }) + (readyCount === null ? "" : ` · ${t("activity.party.readyCount", { ready: readyCount, total: presentCount })}`);
  renderTableControls(game);
  renderTableActions(game);
  renderCharacterWorkspace(game);
  paintSection("enemies", [game.foes, game.allies, game.order, game.roundNumber, game.upcomingNames, app.selectedEnemyName, app.uiLanguage], () => renderEnemies(game.foes, game.allies ?? []));
  paintSection("party", [game.party, game.mode, game.upcomingNames, app.selectedPartyCharacterId, app.selectedEnemyName, app.uiLanguage], () => renderParty(game.party));
  setLiveMessage(game.submission === "action" ? t("activity.status.actionIn") : game.submission === "pass" ? t("activity.status.youPassed") : "");
  updateRollPrompt(["paused", "safety", "recovery"].includes(game.mode) ? null : game.pendingRoll);
}

