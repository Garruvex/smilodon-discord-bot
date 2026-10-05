import { DiscordSDK } from "@discord/embedded-app-sdk";
import { app } from "./state.js";
import { fetchWithTimeout, requestJson, withTimeout } from "./api.js";
import { errorElement, liveScreen, lobbyScreen, serverElement, setMessage, userElement } from "./dom.js";
import { languageFromBrowser, languageFromDiscordLocale, setLanguage, t } from "./i18n.js";
import { loadGames, showError } from "./lobby.js";
import { resetDrawers } from "./drawers.js";
import { openGame } from "./poll.js";
import { resetPaint } from "./render.js";
import { returnToTables } from "./table-lifecycle.js";

document.querySelector("#back-to-lobby").addEventListener("click", () => {
  clearInterval(app.tableTimer);
  app.tableTimer = null;
  app.currentGameId = null;
  resetPaint();
  resetDrawers();
  app.currentSnapshot = null;
  liveScreen.hidden = true;
  lobbyScreen.hidden = false;
  void setLanguage(app.discordLanguage).then(() => returnToTables()).catch((error) => showError(error instanceof Error ? error.message : t("activity.status.couldNotLoad")));
});

document.querySelector("#lobby-retry").addEventListener("click", () => {
  errorElement.hidden = true;
  void authenticate().catch((error) => showError(error instanceof Error ? error.message : t("activity.connection.signInFailed")));
});


// Signs in again with Discord for a new session token, without leaving the page. Many requests can hit an expired session at once; they share one renewal.
let renewing = null;

export function renewSession() {
  renewing ??= (async () => {
    const authorization = await withTimeout(app.discordSdk.commands.authorize({
      client_id: app.applicationId,
      response_type: "code",
      state: crypto.randomUUID(),
      prompt: "none",
      scope: ["identify", "guilds.members.read"],
    }), 20000, t("activity.connection.authTimeout"));
    const session = await requestJson("/api/activity/session", {
      method: "POST",
      renewed: true,
      body: JSON.stringify({ code: authorization.code, guildId: app.discordSdk.guildId, channelId: app.discordSdk.channelId }),
    });
    if (typeof session.access_token !== "string" || typeof session.session_token !== "string") throw new Error(t("activity.connection.invalidSession"));
    app.sessionToken = session.session_token;
    await app.discordSdk.commands.authenticate({ access_token: session.access_token }).catch(() => {});
  })().finally(() => { renewing = null; });
  return renewing;
}

export async function authenticate() {
  app.discordLanguage = languageFromBrowser();
  await setLanguage(app.discordLanguage);
  app.connectionStage = "Activity setup";
  app.discordConnected = false;
  errorElement.hidden = true;
  userElement.textContent = t("activity.lobby.connectingDiscord");
  serverElement.textContent = t("activity.lobby.connectingDiscord");
  setMessage(t("activity.connection.connectingActivity"));
  const configResponse = await fetchWithTimeout("/activity-config.json", { cache: "no-store" });
  if (!configResponse.ok) throw new Error(t("activity.connection.activityConfig"));
  const config = await configResponse.json();
  if (typeof config.applicationId !== "string" || config.applicationId.length === 0) throw new Error(t("activity.connection.appId"));
  app.applicationId = config.applicationId;
  app.discordSdk = new DiscordSDK(config.applicationId);
  app.connectionStage = "Discord connection";
  setMessage(t("activity.connection.waitDiscord"));
  await withTimeout(app.discordSdk.ready(), 12000, t("activity.connection.discordTimeout"));
  const localeResult = await app.discordSdk.commands.userSettingsGetLocale().catch(() => ({ locale: app.discordLanguage }));
  app.discordLanguage = languageFromDiscordLocale(localeResult.locale);
  await setLanguage(app.discordLanguage);
  app.discordConnected = true;
  // Let the picture-in-picture window take clicks; without this it only shows the table. A refusal must not stop the sign-in.
  void app.discordSdk.commands.setConfig({ use_interactive_pip: true }).catch((error) => console.warn("Interactive picture-in-picture was not enabled.", error));
  if (!app.discordSdk.guildId) throw new Error(t("activity.connection.guildRequired"));
  serverElement.textContent = t("activity.lobby.connected");
  app.connectionStage = "Discord authorization";
  setMessage(t("activity.connection.authStart"));
  const authorization = await withTimeout(app.discordSdk.commands.authorize({
    client_id: config.applicationId,
    response_type: "code",
    state: crypto.randomUUID(),
    prompt: "none",
    scope: ["identify", "guilds.members.read"],
  }), 20000, t("activity.connection.authTimeout"));
  app.connectionStage = "Account verification";
  setMessage(t("activity.connection.verify"));
  const session = await requestJson("/api/activity/session", {
    method: "POST",
    body: JSON.stringify({ code: authorization.code, guildId: app.discordSdk.guildId, channelId: app.discordSdk.channelId }),
  });
  app.sessionToken = session.session_token;
  if (typeof session.access_token !== "string" || typeof app.sessionToken !== "string") throw new Error(t("activity.connection.invalidSession"));
  const identity = await app.discordSdk.commands.authenticate({ access_token: session.access_token });
  app.discordUserId = identity.user.id;
  userElement.textContent = identity.user.global_name || identity.user.username;
  serverElement.textContent = t("activity.connection.thisServer");
  app.connectionStage = "Loading games";
  if (typeof session.launchCampaignId === "string") await openGame(session.launchCampaignId);
  else await loadGames();
}

