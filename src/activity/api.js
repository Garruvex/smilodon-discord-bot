import { app } from "./state.js";
import { t } from "./i18n.js";
import { renewSession } from "./session.js";

export const apiErrorKeys = {
  ...Object.fromEntries(["actionTooLong", "emptyAction", "invalidAction", "heroFallen", "moveDecisionPending", "roundNotCollecting", "memberAway", "campaignWaiting", "staleRound"].map((code) => [code, `activity.error.${code}`])),
  noOpenRound: "activity.error.roundNotCollecting",
  activityAuthNotConfigured: "activity.connection.signInConfig", discordAuthorizationFailed: "activity.connection.discordAuthorize",
  discordIdentityFailed: "activity.connection.discordIdentity", notInLaunchGuild: "activity.connection.guildRequired",
  privateInviteOnly: "activity.error.privateInvite", full: "activity.error.full", gameFull: "activity.error.gameFull",
  heroTaken: "activity.error.heroTaken", unknownHero: "activity.error.unknownHero", notReady: "activity.error.notReady",
  notEnoughPlayers: "activity.error.notEnoughPlayers", unauthorized: "activity.connection.sessionExpired",
  notFound: "activity.error.gameGone", notActive: "activity.error.notActive", notMember: "activity.error.notMember", campaignPaused: "activity.error.campaignPaused", joinNotAtBreak: "activity.error.joinNotAtBreak",
  joinNotApproved: "activity.error.joinNotApproved", notYourTurn: "activity.error.notYourTurn", invalidAction: "activity.status.actionAvailable",
  invalidCharacter: "activity.creator.invalid", characterLibraryFull: "activity.creator.full", characterIncompatible: "activity.creator.incompatible",
  characterMissing: "activity.characters.missing",
};

export function withTimeout(promise, milliseconds, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}


export async function fetchWithTimeout(url, options = {}, milliseconds = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error(t("activity.connection.serverTimeout"));
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}


export function apiErrorMessage(code) { return t(apiErrorKeys[code] ?? "activity.connection.requestFailed"); }


export async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (app.sessionToken !== null) headers.set("Authorization", `Bearer ${app.sessionToken}`);
  const response = await fetchWithTimeout(url, { ...options, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  // A session that ran out (an hour passes, or the bot restarted) is renewed quietly with Discord and the request is made once more.
  if (response.status === 401 && !options.renewed && app.discordSdk !== null && url !== "/api/activity/session") {
    const renewed = await renewSession().then(() => true, () => false);
    if (renewed) return requestJson(url, { ...options, renewed: true });
  }
  if (!response.ok) {
    const error = new Error(typeof payload.error === "string" ? apiErrorMessage(payload.error) : t("activity.connection.unexpectedResponse", { status: response.status }));
    error.status = response.status;
    error.code = typeof payload.error === "string" ? payload.error : null;
    throw error;
  }
  return payload;
}

