import { app } from "./state.js";
import { fetchWithTimeout } from "./api.js";

export const gamesElement = document.querySelector("#lobby-games");

export const messageElement = document.querySelector("#lobby-message");

export const emptyElement = document.querySelector("#lobby-empty");

export const errorElement = document.querySelector("#lobby-error");

export const errorTitleElement = document.querySelector("#lobby-error-title");

export const errorMessageElement = document.querySelector("#lobby-error-message");

export const userElement = document.querySelector("#lobby-user");

export const serverElement = document.querySelector("#server-label");

export const lobbyScreen = document.querySelector("#lobby-screen");

export const liveScreen = document.querySelector("#live-screen");

export const liveActions = document.querySelector("#live-actions");

export const liveParty = document.querySelector("#live-party");

export const liveEnemies = document.querySelector("#live-enemies");

export const liveMap = document.querySelector("#live-map");

export const artIconPrefix = "/art-icons";


export function setMessage(message) { messageElement.textContent = message; }

export function setLiveMessage(message) { document.querySelector("#live-message").textContent = message; }

// The pill that says an action is on its way. It sits at the bottom of the screen, where the small status line cannot be missed,
// says so again if the answer is slow, and ends with what happened.
let busyTimers = [];
const busyPill = () => document.querySelector("#action-busy");
const clearBusyTimers = () => { for (const id of busyTimers) clearTimeout(id); busyTimers = []; };
export function showBusy(message, slowMessage) {
  const pill = busyPill();
  clearBusyTimers();
  pill.dataset.state = "busy";
  pill.querySelector(".busy-text").textContent = message;
  // A reply that comes straight back needs no flicker of "sending": the pill only appears if it is not instant.
  busyTimers.push(setTimeout(() => { pill.hidden = false; }, 150));
  busyTimers.push(setTimeout(() => { pill.querySelector(".busy-text").textContent = slowMessage; }, 4000));
}
export function finishBusy(message, failed) {
  const pill = busyPill();
  clearBusyTimers();
  pill.hidden = false;
  pill.dataset.state = failed ? "failed" : "done";
  pill.querySelector(".busy-text").textContent = message;
  busyTimers.push(setTimeout(() => { pill.hidden = true; }, failed ? 5000 : 2000));
}


export const actionIcon = { attack: "attack", combatSpell: "spell", exploreSpell: "spell", healSpell: "heal", reviveSpell: "heal", useItem: "potion", combatItem: "potion", move: "move", moveScene: "move", dash: "dash", combatDodge: "dodge", withdraw: "withdraw", shield: "shield", wildShape: "shape", roll: "roll", ready: "play", begin: "play", continue: "play", details: "notice", submit: "attack", pass: "pause", shop: "coins", askNpc: "clue", feature: "shape", reaction: "shield", smite: "attack", opportunityAttack: "attack", teleport: "move", summonCompanion: "shape", acceptInvite: "play", joinHero: "play", chooseHero: "play", startLobby: "play" };

export const classIcon = { wizard: "spell", sorcerer: "spell", warlock: "spell", cleric: "heal", druid: "shape", paladin: "shield", ranger: "ranged", rogue: "withdraw", fighter: "attack", barbarian: "attack", monk: "dodge", bard: "clue" };

export const artworkCache = new Map();

export const artworkMisses = new Map();


export function iconImage(name, label = "") {
  const image = document.createElement("img");
  image.src = `${artIconPrefix}/${name}.svg`;
  image.alt = label;
  image.setAttribute("aria-hidden", label ? "false" : "true");
  return image;
}


export function iconForClass(className) {
  const key = className?.toLocaleLowerCase().split(/\s+/)[0] ?? "";
  return classIcon[key] ?? "shape";
}


// A picture can be repainted under the same address (an organizer's redo), so ones that must stay current are re-checked now and then.
export const artworkRecheckMs = 20000;

export const artworkPending = new Map();


export async function setArtwork(imageElement, fallbackElement, imageUrl, alt, revalidate = false) {
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    imageElement.removeAttribute("src");
    imageElement.dataset.source = "";
    imageElement.alt = "";
    imageElement.hidden = true;
    fallbackElement.hidden = false;
    return;
  }
  imageElement.alt = alt;
  // A picture that was not ready is asked for again after a while.
  if (Date.now() - (artworkMisses.get(imageUrl) ?? 0) < artworkRecheckMs) return;
  const changed = imageElement.dataset.source !== imageUrl;
  imageElement.dataset.source = imageUrl;
  const show = (objectUrl) => {
    if (imageElement.dataset.source !== imageUrl) return;
    if (imageElement.src !== objectUrl) imageElement.src = objectUrl;
    imageElement.hidden = false;
    fallbackElement.hidden = true;
  };
  const cached = artworkCache.get(imageUrl);
  if (cached !== undefined) {
    show(cached.objectUrl);
    if (!revalidate || Date.now() - cached.checkedAt < artworkRecheckMs) return;
  } else if (changed || imageElement.hidden) {
    imageElement.hidden = true;
    fallbackElement.hidden = false;
  }
  const pending = artworkPending.get(imageUrl);
  if (pending) {
    await pending;
    const loaded = artworkCache.get(imageUrl);
    if (loaded) show(loaded.objectUrl);
    return;
  }
  const loading = (async () => {
  try {
    const headers = { Authorization: `Bearer ${app.sessionToken}` };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const response = await fetchWithTimeout(imageUrl, { headers, cache: "no-store" });
    if (response.status === 304 && cached !== undefined) {
      cached.checkedAt = Date.now();
      return;
    }
    if (!response.ok) {
      // Any refusal counts as "not ready": asked again after a while, not on every poll.
      artworkMisses.set(imageUrl, Date.now());
      console.warn(`Picture could not be loaded (${response.status}).`, imageUrl);
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    artworkCache.set(imageUrl, { objectUrl, etag: response.headers.get("ETag"), checkedAt: Date.now() });
    show(objectUrl);
    if (cached !== undefined) setTimeout(() => URL.revokeObjectURL(cached.objectUrl), 2000);
  } catch (error) {
    console.warn("Picture request failed; showing the illustration fallback.", imageUrl, error);
  } finally {
    artworkPending.delete(imageUrl);
  }
  })();
  artworkPending.set(imageUrl, loading);
  await loading;
}


export function makeButton(label, onClick, primary = false, iconName = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `live-action-choice ui-control${primary ? " primary" : ""}`;
  if (iconName) button.append(iconImage(iconName));
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  button.addEventListener("click", (event) => {
    app.pressedLabel = label;
    onClick(event);
    // The press went out: this button shows it, and the rest wait until the table answers.
    if (app.actionInFlight) button.classList.add("is-pending");
  });
  return button;
}


export const svgNs = "http://www.w3.org/2000/svg";


export function svgElement(name, attributes = {}, text = null) {
  const element = document.createElementNS(svgNs, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== null) element.textContent = text;
  return element;
}

