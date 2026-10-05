import { t } from "./i18n.js";
import { performAction } from "./actions.js";

// Stopping and resting. Any player can stop play for everyone with one tap; the organizer also pauses and asks for rests from a small menu.
// The engine decides what is allowed; the page only says what it would do, and shows why a request is refused.
let stopButton = null;
let menuButton = null;
let current = null;

function headingRight() { return document.querySelector(".live-heading-right"); }

function ensureButtons() {
  const container = headingRight();
  if (container === null) return false;
  if (stopButton === null || !container.contains(stopButton)) {
    stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.id = "table-stop";
    stopButton.className = "ui-control stop-button";
    stopButton.addEventListener("click", () => void performAction({ kind: "safetyStop" }));
    container.prepend(stopButton);
  }
  if (menuButton === null || !container.contains(menuButton)) {
    menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.id = "table-controls";
    menuButton.className = "ui-control";
    menuButton.addEventListener("click", () => openControls());
    container.prepend(menuButton);
  }
  return true;
}

function dialog() {
  let box = document.querySelector("#table-controls-dialog");
  if (box !== null) return box;
  box = document.createElement("dialog");
  box.id = "table-controls-dialog";
  box.className = "level-up-dialog table-controls-dialog";
  box.setAttribute("aria-labelledby", "table-controls-title");
  box.addEventListener("click", (event) => { if (event.target === box) box.close(); });
  document.body.append(box);
  return box;
}

async function send(action, box) {
  const ok = await performAction(action);
  if (ok) box.close();
}

function restCard(kind, controls, box) {
  const rest = controls.rest;
  const card = document.createElement("section");
  card.className = "level-up-section";
  card.append(Object.assign(document.createElement("h3"), { textContent: t(`activity.controls.${kind}Rest`) }), Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t(`activity.controls.${kind}RestWhat`) }));
  if (rest.askedFor === kind) {
    card.append(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.controls.asked", { rest: t(`activity.rest.${kind}`) }) }));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ui-control";
    cancel.textContent = t("activity.controls.cancelRest");
    cancel.addEventListener("click", () => void send({ kind: "queueRest", rest: "none" }, box));
    card.append(cancel);
    return card;
  }
  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "ui-control primary";
  ask.textContent = t(rest.now ? `activity.controls.${kind}Rest` : `activity.controls.${kind}RestLater`);
  ask.addEventListener("click", () => void send({ kind: "queueRest", rest: kind }, box));
  card.append(ask);
  return card;
}

function openControls() {
  const game = current;
  const box = dialog();
  if (game === null) return;
  const head = document.createElement("header");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ui-control";
  close.textContent = "×";
  close.setAttribute("aria-label", t("activity.controls.close"));
  close.addEventListener("click", () => box.close());
  head.append(Object.assign(document.createElement("h2"), { id: "table-controls-title", textContent: t("activity.controls.menu") }), close);
  const parts = [head];
  if (game.canPause) {
    const pause = document.createElement("section");
    pause.className = "level-up-section";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-control";
    button.textContent = t("activity.controls.pause");
    button.addEventListener("click", () => void send({ kind: "pause" }, box));
    pause.append(button);
    parts.push(pause);
  }
  if (game.proxy != null && game.proxy.options.length > 0) {
    const proxy = document.createElement("section");
    proxy.className = "level-up-section";
    const select = document.createElement("select");
    select.setAttribute("aria-label", t("activity.controls.proxyLabel"));
    select.append(Object.assign(document.createElement("option"), { value: "", textContent: t("activity.controls.proxyNobody") }));
    for (const option of game.proxy.options) select.append(Object.assign(document.createElement("option"), { value: option.userId, textContent: option.heroName }));
    select.value = game.proxy.current ?? "";
    select.addEventListener("change", () => void performAction({ kind: "setProxy", userId: select.value === "" ? null : select.value }));
    proxy.append(Object.assign(document.createElement("h3"), { textContent: t("activity.controls.proxyLabel") }), select, Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.controls.proxyWhat") }));
    parts.push(proxy);
  }
  if (game.canPropose) {
    const propose = document.createElement("section");
    propose.className = "level-up-section";
    propose.append(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.controls.proposeWhat") }));
    for (const kind of ["short", "long"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-control";
      button.textContent = t(kind === "short" ? "activity.controls.proposeShort" : "activity.controls.proposeLong");
      button.addEventListener("click", () => void send({ kind: "proposeRest", rest: kind }, box));
      propose.append(button);
    }
    parts.push(propose);
  }
  if (game.rest !== null && game.rest.resting === null) parts.push(restCard("short", game, box), restCard("long", game, box));
  if (game.rest !== null && game.rest.resting !== null) parts.push(Object.assign(document.createElement("p"), { className: "level-up-status", textContent: t("activity.status.resting") }));
  box.replaceChildren(...parts);
  if (!box.open) box.showModal();
}

// Called on every paint of a table: the stop button for any player, the menu for the organizer, both gone when there is nothing to do.
export function renderTableControls(game) {
  if (!ensureButtons()) return;
  const controls = game.kind === "table" ? game.controls : null;
  current = controls ?? null;
  stopButton.hidden = controls === null || !controls.canStop;
  stopButton.replaceChildren(Object.assign(document.createElement("span"), { textContent: "⏸", "aria-hidden": "true" }), Object.assign(document.createElement("span"), { className: "stop-label", textContent: t("activity.controls.stop") }));
  stopButton.title = t("activity.controls.stopHint");
  stopButton.setAttribute("aria-label", `${t("activity.controls.stop")}. ${t("activity.controls.stopHint")}`);
  const organizer = controls !== null && (controls.canPause || controls.rest !== null || controls.canPropose || (controls.proxy != null && controls.proxy.options.length > 0));
  menuButton.hidden = !organizer;
  menuButton.textContent = t("activity.controls.menu");
  const box = document.querySelector("#table-controls-dialog");
  if (box?.open) { if (organizer) openControls(); else box.close(); }
  renderRestVote(game.kind === "table" ? game.restVote : null);
}

// A player's proposal to rest: shown to the whole table under the header with where the vote stands, and Agree / Not now for the players present.
function renderRestVote(vote) {
  let banner = document.querySelector("#rest-vote");
  if (banner === null) {
    const header = document.querySelector(".live-header");
    if (header === null) return;
    banner = document.createElement("div");
    banner.id = "rest-vote";
    banner.className = "level-up-banner";
    banner.setAttribute("role", "status");
    header.after(banner);
  }
  banner.hidden = vote === null || vote === undefined;
  if (banner.hidden) { banner.replaceChildren(); return; }
  const text = document.createElement("span");
  text.append(
    Object.assign(document.createElement("strong"), { textContent: t(vote.rest === "short" ? "activity.restVote.shortTitle" : "activity.restVote.longTitle", { name: vote.proposedBy }) }),
    document.createTextNode(" · "),
    document.createTextNode(t("activity.restVote.tally", { agree: vote.agree, decline: vote.decline, needed: vote.needed, present: vote.present })),
  );
  const buttons = [];
  if (vote.canAnswer) {
    for (const agree of [true, false]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = agree ? "ui-control primary" : "ui-control";
      button.textContent = t(agree ? "activity.restVote.agree" : "activity.restVote.decline");
      button.setAttribute("aria-pressed", String(vote.yourAnswer === (agree ? "agree" : "decline")));
      button.addEventListener("click", () => void performAction({ kind: "answerRestVote", agree }));
      buttons.push(button);
    }
  }
  banner.replaceChildren(text, ...buttons);
}
