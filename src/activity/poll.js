import { app } from "./state.js";
import { apiErrorMessage, requestJson } from "./api.js";
import { liveActions, liveScreen, lobbyScreen, setLiveMessage } from "./dom.js";
import { setLanguage, t } from "./i18n.js";
import { renderGame, resetPaint } from "./render.js";

export const fullTableEveryMs = 30000;

export async function openGame(campaignId) {
  app.lastRollPromptId = null;
  const diceDialog = document.querySelector("#dice-dialog");
  if (diceDialog.open) diceDialog.close();
  app.currentGameId = campaignId;
  app.tableToken = null;
  resetPaint();
  setTableConnectionState("connecting");
  lobbyScreen.hidden = true;
  liveScreen.hidden = false;
  liveActions.replaceChildren();
  setLiveMessage(t("activity.status.loadingCampaign"));
  await loadTable();
  clearInterval(app.tableTimer);
  app.tableTimer = setInterval(() => void loadTable().catch(() => {}), 3000);
}


export async function loadTable() {
  if (app.currentGameId === null || app.loadingTable) return;
  app.loadingTable = true;
  try {
    const wantsFull = app.tableToken === null || Date.now() - app.lastFullTableAt >= fullTableEveryMs;
    const payload = await requestJson(`/api/activity/games/${encodeURIComponent(app.currentGameId)}/table${wantsFull ? "" : `?since=${encodeURIComponent(app.tableToken)}`}`);
    app.tableRefreshFailures = 0;
    app.lastTableRefreshAt = Date.now();
    if (payload.unchanged) {
      setTableConnectionState("live");
      return;
    }
    app.tableToken = payload.token ?? null;
    app.lastFullTableAt = Date.now();
    app.currentSnapshot = payload.snapshot;
    await setLanguage(app.currentSnapshot.language ?? app.uiLanguage);
    setTableConnectionState("live");
    renderGame(app.currentSnapshot);
  } catch (error) {
    app.tableRefreshFailures += 1;
    setTableConnectionState(app.tableRefreshFailures >= 3 || Date.now() - app.lastTableRefreshAt >= 15000 ? "offline" : "delayed");
    setLiveMessage(error instanceof Error ? error.message : t("activity.status.couldNotLoad"));
    if (error instanceof Error && error.message === apiErrorMessage("notActive")) {
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

