import { app } from "./state.js";
import { performAction, speechRow } from "./actions.js";
import { makeButton } from "./dom.js";
import { t } from "./i18n.js";

// The card sits under the header, which wraps to two rows on a phone.
export function placeMoveNotice() {
  const header = document.querySelector(".live-header");
  if (header) document.documentElement.style.setProperty("--vote-top", `${Math.round(header.getBoundingClientRect().bottom) + 12}px`);
}

window.addEventListener("resize", placeMoveNotice);


export function renderMoveNotice(move, canVote, game) {
  move = move ?? null;
  const notice = document.querySelector("#live-scene-move");
  const shield = document.querySelector("#vote-shield");
  const key = move === null ? null : JSON.stringify([app.currentGameId, move.sceneId, move.closesAt]);
  const opening = key !== null && key !== app.activeMoveKey;
  if (opening) app.focusBeforeVote = document.activeElement instanceof HTMLElement && !notice.contains(document.activeElement) ? document.activeElement : null;
  app.activeMoveKey = key;
  const canSpeak = game?.kind === "table" && game.myHero !== null && game.myHero !== undefined;
  const paintKey = JSON.stringify([move, canVote, canSpeak, app.uiLanguage]);
  if (paintKey === app.movePainted) {
    if (move !== null && !notice.open) {
      notice.hidden = false;
      shield.hidden = false;
      placeMoveNotice();
      notice.show();
    }
    return;
  }
  app.movePainted = paintKey;
  if (app.moveCountdown !== null) clearInterval(app.moveCountdown);
  app.moveCountdown = null;
  if (move === null) {
    if (notice.open) notice.close();
    notice.hidden = true;
    shield.hidden = true;
    notice.replaceChildren();
    const back = app.focusBeforeVote;
    app.focusBeforeVote = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
    return;
  }
  const typing = notice.contains(document.activeElement) && document.activeElement.matches("input, textarea")
    ? { label: document.activeElement.getAttribute("aria-label"), start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  notice.hidden = false;
  const line = (className, text) => { const item = document.createElement("span"); item.className = className; item.textContent = text; return item; };
  const heading = line("move-heading", t("activity.move.heading", { scene: move.sceneTitle }));
  const proposedBy = line("move-proposer", t(move.proposedBy ? "activity.move.proposedBy" : "activity.move.proposedByStory", { name: move.proposedBy ?? "" }));
  const description = move.sceneDescription ? line("move-description", move.sceneDescription) : null;
  const tally = line("move-tally", t("activity.move.tallyChoices", { go: move.supporters?.length ?? 0, stay: move.staying.length, present: move.present, undecided: Math.max(0, move.present - (move.supporters?.length ?? 0) - move.staying.length), needed: move.needed }));
  const going = move.supporters?.length ? line("move-names", t("activity.move.going", { names: move.supporters.join(", ") })) : null;
  const names = move.staying.length ? line("move-names", t("activity.move.staying", { names: move.staying.join(", ") })) : null;
  const clock = line("move-clock", "");
  heading.id = "live-move-heading";
  const prompt = line("move-prompt", t(move.choiceByYou === null ? "activity.move.yourVote" : "activity.move.voteRecorded", { scene: move.sceneTitle }));
  const choices = document.createElement("div");
  choices.className = "move-vote-actions";
  if (canVote) {
    for (const choice of ["go", "stay"]) {
      const labelKey = move.choiceByYou === choice ? choice === "go" ? "activity.move.withdrawGo" : "activity.move.withdrawStay" : choice === "go" ? "activity.move.voteGo" : "activity.move.voteStay";
      const button = makeButton(t(labelKey), () => void performAction({ kind: "moveVote", choice }), choice !== "stay", choice === "go" ? "move" : "pause");
      button.dataset.choice = choice;
      button.dataset.selected = String(move.choiceByYou === choice);
      choices.append(button);
    }
  } else if (game?.kind === "table" && game.canTogglePresence && game.ownPresence === "away") {
    // Marked away: no vote to cast, but the way back is one press.
    choices.append(makeButton(t("activity.action.back"), () => void performAction({ kind: "back" }), true, "play"));
  }
  notice.replaceChildren(prompt, heading, proposedBy, ...(description ? [description] : []), line("move-paused", t("activity.move.paused")), ...(canVote ? [] : [line("move-names", t("activity.move.awayNote"))]), tally, ...(going ? [going] : []), ...(names ? [names] : []), clock, ...(choices.childElementCount > 0 ? [choices] : []));
  const speech = canSpeak ? speechRow(game) : null;
  if (speech) notice.append(speech);
  shield.hidden = false;
  placeMoveNotice();
  if (!notice.open) notice.show();
  // A vote from someone else repaints the card: keep the sentence being typed, otherwise start at the first choice.
  const again = typing ? [...notice.querySelectorAll("input, textarea")].find((element) => element.getAttribute("aria-label") === typing.label) : null;
  if (again instanceof HTMLElement) {
    again.focus({ preventScroll: true });
    if (typing.start !== null && "setSelectionRange" in again) again.setSelectionRange(typing.start, typing.end);
  } else if (opening) notice.querySelector(".move-vote-actions button")?.focus({ preventScroll: true });
  const tick = () => {
    const left = Math.max(0, Math.ceil((move.closesAt - Date.now()) / 1000));
    if (left === 0) clock.textContent = t("activity.move.deciding");
    else {
      const days = Math.floor(left / 86400), hours = Math.floor((left % 86400) / 3600), minutes = Math.floor((left % 3600) / 60), seconds = left % 60;
      const time = days ? t("activity.move.daysHours", { days, hours }) : hours ? t("activity.move.hoursMinutes", { hours, minutes }) : `${minutes}:${String(seconds).padStart(2, "0")}`;
      clock.textContent = t("activity.move.countdown", { time });
    }
  };
  clock.hidden = move.closesAt === null;
  if (move.closesAt !== null) {
    tick();
    app.moveCountdown = setInterval(tick, 1000);
  }
}


export function renderPresenceToggle(game) {
  const button = document.querySelector("#live-presence-toggle");
  const available = game.kind === "table" && game.canTogglePresence && !["paused", "safety", "recovery", "archived"].includes(game.mode);
  button.hidden = !available;
  if (!available) return;
  button.textContent = t(game.ownPresence === "away" ? "activity.action.back" : "activity.action.away");
  button.dataset.presence = game.ownPresence;
  button.setAttribute("aria-pressed", String(game.ownPresence === "away"));
}


document.querySelector("#live-presence-toggle").addEventListener("click", () => {
  if (app.currentSnapshot?.kind !== "table" || !app.currentSnapshot.canTogglePresence) return;
  void performAction({ kind: app.currentSnapshot.ownPresence === "away" ? "back" : "away" });
});

