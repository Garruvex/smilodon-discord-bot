import { app } from "./state.js";
import { requestJson } from "./api.js";
import { emptyElement, errorElement, errorMessageElement, errorTitleElement, gamesElement, makeButton, serverElement, setMessage, userElement } from "./dom.js";
import { loadCharacters } from "./character-builder.js";
import { t } from "./i18n.js";
import { openGame } from "./poll.js";

export const lifecycleKeys = { lobby: "activity.lobby.status.open", active: "activity.lobby.status.live", paused: "activity.lobby.status.paused" };

export const actionKeys = { join: "activity.lobby.action.join", continue: "activity.lobby.action.continue", request: "activity.lobby.action.request", requested: "activity.lobby.action.requested", queued: "activity.lobby.action.queued", invited: "activity.lobby.action.invited", expired: "activity.lobby.action.expired", full: "activity.lobby.action.full", resume: "activity.lobby.action.continue" };

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
  } else if (game.action === "expired") {
    const note = document.createElement("p");
    note.className = "lobby-card-request-status";
    note.textContent = t("activity.lobby.request.expired");
    copy.append(note);
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
  if (game.action === "requested") action.textContent = t(game.canWatch ? "activity.tables.viewRequest" : "activity.action.withdrawJoin");
  if (game.action === "queued") action.textContent = t("activity.lobby.action.queued");
  action.addEventListener("click", () => void selectGame(game, action).catch((error) => setMessage(error.message)));
  const actions = document.createElement("div");
  actions.className = "table-flow-actions";
  actions.append(action);
  if (game.canWatch && ["request", "requested", "expired", "full"].includes(game.action)) {
    actions.append(makeButton(t("activity.tables.watch"), () => void openGame(game.campaignId).catch((error) => setMessage(error.message))));
  }
  copy.append(document.createElement("p"));
  copy.lastChild.className = "lobby-card-description";
  copy.lastChild.textContent = t(game.lifecycle === "lobby" ? "activity.tables.lobbyHelp" : "activity.tables.liveHelp");
  card.append(copy, actions);
  return card;
}


export async function loadGames() {
  errorElement.hidden = true;
  emptyElement.hidden = true;
  setMessage(t("activity.lobby.loading"));
  const payload = await requestJson("/api/activity/games");
  app.tableOptions = await requestJson("/api/activity/table-options").catch(() => null);
  const create = document.querySelector("#table-create");
  create.hidden = !app.tableOptions?.canCreate;
  try { await loadCharacters(); } catch {
    document.querySelector("#lobby-character-count").textContent = t("activity.creator.unavailable");
  }
  userElement.textContent = payload.user?.displayName ?? t("activity.lobby.connectedUser");
  gamesElement.replaceChildren(...(payload.games ?? []).map(createGameCard));
  gamesElement.dataset.signature = JSON.stringify(payload.games);
  emptyElement.hidden = (payload.games ?? []).length !== 0;
  setMessage(payload.games?.length ? t("activity.lobby.choose") : "");
  clearInterval(app.gamesTimer);
  app.gamesTimer = setInterval(() => {
    if (app.currentGameId !== null || document.querySelector("#lobby-screen").hidden) return;
    void requestJson("/api/activity/games").then((latest) => {
      if (app.currentGameId !== null || document.querySelector("#lobby-screen").hidden) return;
      const signature = JSON.stringify(latest.games);
      if (signature === gamesElement.dataset.signature) return;
      gamesElement.dataset.signature = signature;
      gamesElement.replaceChildren(...(latest.games ?? []).map(createGameCard));
      emptyElement.hidden = Boolean(latest.games?.length);
    }).catch(() => {});
  }, 5000);
}


export async function selectGame(game, button) {
  if (game.action === "requested" && !game.canWatch) {
    button.disabled = true;
    try {
      await requestJson(`/api/activity/games/${encodeURIComponent(game.campaignId)}/withdraw`, { method: "POST" });
      await loadGames();
    } catch (error) { button.disabled = false; throw error; }
    return;
  }
  if (game.action === "join" || game.action === "request" || game.action === "expired") {
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = game.action === "join" ? t("activity.lobby.action.joining") : game.action === "requested" ? t("activity.lobby.action.withdrawing") : t("activity.lobby.action.sending");
    try {
      await requestJson(`/api/activity/games/${encodeURIComponent(game.campaignId)}/${game.action === "requested" ? "withdraw" : game.action === "expired" ? "request" : game.action}`, { method: "POST" });
      if (game.action === "join" || game.canWatch) await openGame(game.campaignId);
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
  if (["continue", "resume", "invited", "queued", "requested"].includes(game.action)) await openGame(game.campaignId);
  else if (game.action === "requested") setMessage(t("activity.lobby.request.waiting"));
}


export { renderTableLobby as renderLobby } from "./table-lifecycle.js";
