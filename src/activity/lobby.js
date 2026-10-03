import { app } from "./state.js";
import { performAction } from "./actions.js";
import { requestJson } from "./api.js";
import { emptyElement, errorElement, errorMessageElement, errorTitleElement, gamesElement, iconImage, liveActions, liveEnemies, makeButton, serverElement, setArtwork, setLiveMessage, setMessage, userElement } from "./dom.js";
import { loadCharacters, openCharacterCreator, wireCharacterCreator } from "./character-builder.js";
import { setHeroWatermark, updateHealthMeter } from "./hero.js";
import { classText, t } from "./i18n.js";
import { renderParty } from "./party.js";
import { openGame } from "./poll.js";

export const lifecycleKeys = { lobby: "activity.lobby.status.open", active: "activity.lobby.status.live", paused: "activity.lobby.status.paused" };

export const actionKeys = { join: "activity.lobby.action.join", continue: "activity.lobby.action.continue", request: "activity.lobby.action.request", requested: "activity.lobby.action.requested", queued: "activity.lobby.action.queued", invited: "activity.lobby.action.invited", full: "activity.lobby.action.full", resume: "activity.lobby.action.continue" };

export function showError(error) {
  gamesElement.replaceChildren();
  emptyElement.hidden = true;
  errorElement.hidden = false;
  errorTitleElement.textContent = app.connectionStage === "Discord connection"
    ? t("activity.lobby.error.connect")
    : app.connectionStage === "Discord authorization"
      ? t("activity.lobby.error.signIn")
      : app.connectionStage === "Account verification"
        ? t("activity.lobby.error.verify")
        : t("activity.lobby.error.load");
  errorMessageElement.textContent = error;
  userElement.textContent = t("activity.lobby.connectionAttention");
  serverElement.textContent = app.discordConnected ? t("activity.lobby.discordConnected") : t("activity.lobby.connectingDiscord");
  setMessage("");
}


export function createGameCard(game) {
  const card = document.createElement("article");
  card.className = "lobby-card ui-card";
  card.dataset.lifecycle = game.lifecycle;
  const art = document.createElement("div");
  art.className = "lobby-card-art";
  art.setAttribute("aria-hidden", "true");
  art.textContent = game.lifecycle === "active" ? "⚔" : game.lifecycle === "paused" ? "◷" : "✧";
  const copy = document.createElement("div");
  copy.className = "lobby-card-copy";
  const status = document.createElement("span");
  status.className = "lobby-card-status";
  status.textContent = t(lifecycleKeys[game.lifecycle] ?? "activity.lobby.status.campaign");
  const title = document.createElement("h3");
  title.textContent = game.name;
  const adventure = document.createElement("p");
  adventure.className = "lobby-card-adventure";
  adventure.textContent = game.adventureTitle;
  const players = document.createElement("p");
  players.className = "lobby-card-players";
  players.textContent = t("activity.lobby.players", { count: game.playerCount, max: game.maxPlayers });
  copy.append(status, title, adventure, players);
  if (game.action === "requested") {
    const pending = document.createElement("p");
    pending.className = "lobby-card-request-status";
    pending.textContent = t("activity.join.waitingApproval");
    copy.append(pending);
  } else if (game.action === "queued") {
    const pending = document.createElement("p");
    pending.className = "lobby-card-request-status";
    pending.textContent = t("activity.lobby.request.queued");
    copy.append(pending);
  }
  const action = document.createElement("button");
  action.className = "lobby-card-action ui-control";
  action.type = "button";
  action.textContent = t(actionKeys[game.action] ?? "activity.lobby.action.view");
  action.disabled = game.action === "full";
  if (game.action === "requested") action.textContent = t("activity.lobby.action.withdraw");
  if (game.action === "queued") action.textContent = t("activity.lobby.action.queued");
  action.addEventListener("click", () => void selectGame(game, action));
  card.append(art, copy, action);
  return card;
}


export async function loadGames() {
  errorElement.hidden = true;
  emptyElement.hidden = true;
  setMessage(t("activity.lobby.loading"));
  const payload = await requestJson("/api/activity/games");
  try { await loadCharacters(); } catch {
    const area = document.querySelector("#lobby-characters");
    if (area) area.textContent = t("activity.creator.unavailable");
  }
  userElement.textContent = payload.user?.displayName ?? t("activity.lobby.connectedUser");
  gamesElement.replaceChildren(...(payload.games ?? []).map(createGameCard));
  emptyElement.hidden = (payload.games ?? []).length !== 0;
  setMessage(payload.games?.length ? t("activity.lobby.choose") : "");
}


export async function selectGame(game, button) {
  if (game.action === "join" || game.action === "request" || game.action === "requested") {
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = game.action === "join" ? t("activity.lobby.action.joining") : game.action === "requested" ? t("activity.lobby.action.withdrawing") : t("activity.lobby.action.sending");
    try {
      await requestJson(`/api/activity/games/${encodeURIComponent(game.campaignId)}/${game.action === "requested" ? "withdraw" : game.action}`, { method: "POST" });
      if (game.action === "join") await openGame(game.campaignId);
      else {
        await loadGames();
        setMessage(game.action === "requested" ? t("activity.lobby.request.withdrawn") : t("activity.lobby.request.sent", { name: game.name }));
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = originalLabel;
      setMessage(error instanceof Error ? error.message : t("activity.connection.requestFailed"));
    }
    return;
  }
  if (["continue", "resume", "invited", "queued"].includes(game.action)) await openGame(game.campaignId);
  else if (game.action === "requested") setMessage(t("activity.lobby.request.waiting"));
}


export function renderLobby(game) {
  document.querySelector("#hero-workspace-tabs").hidden = true;
  document.querySelector("#hero-workspace-label").textContent = t("activity.lobby.yourCharacter");
  document.querySelectorAll(".hero-tab-panel").forEach((panel) => { panel.hidden = panel.id !== "hero-panel-actions"; });
  document.querySelector("#live-phase").textContent = t("activity.status.openTable");
  document.querySelector("#live-round").textContent = t("activity.status.seats", { count: game.playerCount, max: game.maxPlayers });
  document.querySelector(".live-phase").dataset.mode = "lobby";
  document.querySelector("#live-turn").textContent = game.selectedHeroId ? t("activity.lobby.characterSelected") : t("activity.lobby.chooseCharacter");
  document.querySelector("#live-turn").classList.remove("is-active");
  document.querySelector("#live-hero-name").textContent = game.selectedHeroName ?? t("activity.lobby.noCharacterSelected");
  document.querySelector("#live-hero-subtitle").textContent = classText(game.selectedHeroClass) ?? t("activity.lobby.chooseCharacter");
  document.querySelector("#live-hero-hp").textContent = t("activity.hero.preGame");
  document.querySelector("#live-hero-ac").textContent = "";
  updateHealthMeter(0, 1);
  document.querySelector("#member-overview").hidden = true;
  document.querySelector("#live-hero-class").textContent = t("activity.lobby.yourCharacter");
  setHeroWatermark(null);
  document.querySelector("#live-hero-sigil").replaceChildren(iconImage("shape"));
  void setArtwork(document.querySelector("#live-hero-image"), document.querySelector("#live-hero-sigil"), null, "");
  document.querySelector("#live-resources").replaceChildren();
  document.querySelector("#live-equipment").replaceChildren();
  liveEnemies.replaceChildren();
  liveActions.replaceChildren();
  const choices = document.createElement("details");
  choices.className = "lobby-presets";
  const choicesHeading = document.createElement("summary");
  choicesHeading.textContent = `${t("activity.lobby.adventureCharacters")} · ${game.heroChoices.length}`;
  const choiceList = document.createElement("div");
  choiceList.className = "lobby-preset-list";
  for (const hero of game.heroChoices) {
    const button = makeButton(t("activity.action.chooseHero", { name: hero.name, class: classText(hero.className) }) + (hero.available ? "" : t("activity.action.chosen")), () => {
      if (app.currentGameId === "local-preview") {
        document.querySelector("#live-hero-name").textContent = hero.name;
        document.querySelector("#live-hero-subtitle").textContent = classText(hero.className);
        document.querySelector("#live-turn").textContent = t("activity.lobby.characterSelected");
      } else void performAction({ kind: "chooseHero", heroId: hero.id });
    }, hero.id === game.selectedHeroId);
    button.disabled = !hero.available;
    choiceList.append(button);
  }
  choices.append(choicesHeading, choiceList);
  if (game.savedHeroChoices?.length) {
    const saved = document.createElement("section");
    saved.className = "lobby-saved-card";
    const heading = document.createElement("h3");
    heading.textContent = t("activity.lobby.savedCharacters");
    saved.append(heading);
    for (const hero of game.savedHeroChoices) saved.append(makeButton(`${hero.name} · ${classText(hero.className)}`, () => {
      if (app.currentGameId === "local-preview") setLiveMessage(hero.name);
      else void performAction({ kind: "chooseSaved", snapshotId: hero.id.replace(/^lib:/, "") });
    }));
    liveActions.append(saved);
  }
  liveActions.append(choices);
  if (game.joinRequestStatus === "requested") liveActions.append(makeButton(t("activity.action.withdrawJoin"), () => void performAction({ kind: "withdrawJoin" })));
  if (game.canStart) liveActions.append(makeButton(t("activity.action.startAdventure"), () => void performAction({ kind: "startLobby" }), true));
  renderParty(game.members.map((member, index) => ({
    characterId: `member-${index}`,
    name: member.heroName,
    className: member.className,
    level: null,
    hp: null,
    maxHp: null,
    armorClass: null,
    presence: member.ready ? "ready" : "choosing",
    down: false,
    fallen: false,
    conditions: [],
    isYou: member.isYou,
    tableStatus: member.ready ? "submitted" : "waiting",
  })));
  document.querySelector("#live-party-count").textContent = t("activity.lobby.players", { count: game.playerCount, max: game.maxPlayers });
  setLiveMessage(game.startBlockReason === "notEnoughPlayers" ? t("activity.status.waitingPlayers") : game.startBlockReason === "notReady" ? t("activity.lobby.waitingReady") : game.selectedHeroId ? t("activity.status.readyOrganizer") : t("activity.lobby.chooseCharacterPrompt"));
}


export { openCharacterCreator, wireCharacterCreator };

