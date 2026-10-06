import { app } from "./state.js";
import { requestJson } from "./api.js";
import { liveActions, liveScreen, lobbyScreen, setLiveMessage } from "./dom.js";
import { setLanguage, t } from "./i18n.js";
import { renderGame, resetPaint } from "./render.js";

export const fullTableEveryMs = 30000;

export async function openGame(campaignId) {
  clearInterval(app.tableTimer);
  app.tableTimer = null;
  app.lastRollPromptId = null;
  const diceDialog = document.querySelector("#dice-dialog");
  if (diceDialog.open) diceDialog.close();
  app.currentGameId = campaignId;
  app.joinHeroSelection = null;
  app.tableToken = null;
  resetPaint();
  setTableConnectionState("connecting");
  lobbyScreen.hidden = true;
  clearInterval(app.gamesTimer);
  app.gamesTimer = null;
  document.querySelector("#table-setup-screen").hidden = true;
  document.querySelector("#table-lobby-screen").hidden = true;
  document.querySelector("#characters-screen").hidden = true;
  liveScreen.hidden = false;
  liveActions.replaceChildren();
  setLiveMessage(t("activity.status.loadingCampaign"));
  await loadTable();
  if (app.currentGameId !== campaignId) return;
  clearInterval(app.tableTimer);
  app.tableTimer = setInterval(() => void loadTable().catch(() => {}), 3000);
}


export async function loadTable() {
  if (app.currentGameId === null || app.currentGameId === "local-preview" || app.loadingTable) return;
  const campaignId = app.currentGameId;
  app.loadingTable = true;
  try {
    const wantsFull = app.tableToken === null || Date.now() - app.lastFullTableAt >= fullTableEveryMs;
    const payload = await requestJson(`/api/activity/games/${encodeURIComponent(app.currentGameId)}/table${wantsFull ? "" : `?since=${encodeURIComponent(app.tableToken)}`}`);
    if (app.currentGameId !== campaignId) return;
    app.tableRefreshFailures = 0;
    app.lastTableRefreshAt = Date.now();
    // The table is answering again, so a connection complaint from an earlier try no longer applies.
    if (app.pollErrorShown) {
      app.pollErrorShown = false;
      setLiveMessage("");
    }
    if (payload.unchanged) {
      setTableConnectionState("live");
      return;
    }
    app.tableToken = payload.token ?? null;
    app.lastFullTableAt = Date.now();
    app.currentSnapshot = payload.snapshot;
    await setLanguage(app.languagePreference ?? app.discordLanguage);
    if (app.currentGameId !== campaignId) return;
    setTableConnectionState("live");
    renderGame(app.currentSnapshot);
  } catch (error) {
    if (app.currentGameId !== campaignId) return;
    app.tableRefreshFailures += 1;
    setTableConnectionState(app.tableRefreshFailures >= 3 || Date.now() - app.lastTableRefreshAt >= 15000 ? "offline" : "delayed");
    setLiveMessage(error instanceof Error ? error.message : t("activity.status.couldNotLoad"));
    app.pollErrorShown = true;
    // Gone, closed to this player, or no longer theirs: asking again every few seconds cannot help.
    if (["notFound", "notActive", "notMember", "privateInviteOnly"].includes(error?.code)) {
      setTableConnectionState("offline");
      clearInterval(app.tableTimer);
      app.tableTimer = null;
    }
  } finally {
    app.loadingTable = false;
  }
}


export function setTableConnectionState(state) {
  const dot = document.querySelector("#table-connection-dot");
  if (!dot) return;
  const key = ({ live: "activity.connection.live", delayed: "activity.connection.delayed", offline: "activity.connection.offline", connecting: "activity.connection.connecting" })[state] ?? "activity.connection.connecting";
  dot.dataset.state = state;
  dot.title = t(key);
  dot.setAttribute("aria-label", t(key));
}

