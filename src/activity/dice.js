import { app } from "./state.js";
import { requestJson } from "./api.js";
import { setLiveMessage } from "./dom.js";
import { t } from "./i18n.js";
import { loadTable } from "./poll.js";
import { previewRoll } from "./preview.js";
import { renderGame } from "./render.js";

// A roll is made on the server. The dialog sends the press, then watches the table for the settled result of that very check and lands
// the die on it; a roll the player did not make here (an NPC press, a prompt they closed) comes up as a toast instead. Each roll shows
// once: what was already settled when the page opened is marked seen without a show.
export const seenRolls = new Set();

const minimumTumbleMs = 1200;
const resultTimeoutMs = 15000;
const pollEveryMs = 700;
const autoCloseMs = 5000;
// The pauses between faces as the die slows down.
const settleDelays = [70, 85, 105, 135, 180, 250, 340, 460];
const stepRevealMs = 420;

// The check the dialog has sent and is waiting to see settled.
let awaiting = null;
let tumbleTimer = 0;
let autoCloseTimer = 0;

const dialog = () => document.querySelector("#dice-dialog");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const randomFace = () => String(1 + Math.floor(Math.random() * 20));
const signed = (amount) => `${amount < 0 ? "−" : "+"} ${Math.abs(amount)}`;

function momentClasses(roll) {
  return [
    ...(roll.moment === "natural20" ? ["is-natural20"] : roll.moment === "natural1" ? ["is-natural1"] : []),
    ...(roll.moment === "natural20" && roll.success ? ["is-critical-success"] : roll.moment === "natural1" && !roll.success ? ["is-critical-failure"] : []),
  ];
}

function momentText(roll) {
  return roll.moment === "natural20" ? t(roll.success ? "activity.roll.natural20Success" : "activity.roll.natural20Failure")
    : roll.moment === "natural1" ? t(roll.success ? "activity.roll.natural1Success" : "activity.roll.natural1Failure") : "";
}

// Every kind of roll is shown the same way, by this one function: a tumbling die on a toast that lands on the number. Rolls that land together
// (an attack and its damage) wait their turn, so each is seen; a pile-up keeps the latest few.
const toastQueue = [];
let toastRunning = false;
const toastLimit = 6;

export function showRolls(rolls) {
  const fresh = rolls.filter((roll) => !seenRolls.has(roll.id));
  for (const roll of rolls) seenRolls.add(roll.id);
  if (!app.rollsPrimed) { app.rollsPrimed = true; return; }
  const mine = awaiting === null ? undefined : fresh.find((roll) => roll.id === awaiting.checkId);
  if (mine !== undefined) awaiting.resolve(mine);
  toastQueue.push(...fresh.filter((candidate) => candidate !== mine));
  if (toastQueue.length > toastLimit) toastQueue.splice(0, toastQueue.length - toastLimit);
  void drainToasts();
}

async function drainToasts() {
  if (toastRunning) return;
  toastRunning = true;
  try {
    for (let roll = toastQueue.shift(); roll !== undefined; roll = toastQueue.shift()) await showToast(roll);
  } finally { toastRunning = false; }
}

// What the roll is called: a test of an ability or skill by its name, anything else by its kind (and the weapon or spell it belongs to).
export function rollTitle(roll) {
  return roll.test ? rollLabel(roll.test) : t(`activity.rollKind.${roll.kind ?? "check"}`, { using: roll.using ?? "" });
}

// The line under the die: a check against its DC, an attack against the target, a pool of dice by its total.
function rollDetail(roll) {
  const outcome = (win, lose) => t(roll.success ? win : lose);
  if (roll.natural === null || roll.natural === undefined) return t("activity.roll.poolResult", { total: roll.total });
  const sum = signed(roll.total - roll.natural);
  if (roll.dc !== null && roll.dc !== undefined) return t("activity.roll.result", { natural: roll.natural, sum, total: roll.total, dc: roll.dc, outcome: outcome("activity.roll.success", "activity.roll.failure") });
  if (roll.success === null || roll.success === undefined) return t("activity.roll.plainResult", { natural: roll.natural, sum, total: roll.total });
  return t("activity.roll.attackResult", { natural: roll.natural, sum, total: roll.total, outcome: outcome("activity.roll.hit", "activity.roll.miss") });
}

function showToast(roll) {
  return new Promise((done) => showToastNow(roll, done));
}

function showToastNow(roll, done) {
  let toast = document.querySelector("#roll-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "roll-toast";
    toast.setAttribute("role", "status");
    document.body.append(toast);
  }
  const label = document.createElement("div");
  label.className = "roll-toast-label";
  label.textContent = rollTitle(roll);
  const die = document.createElement("div");
  die.className = "roll-toast-die";
  const dieIcon = document.createElement("img");
  dieIcon.src = "/art-icons/roll.svg";
  dieIcon.alt = "";
  const number = document.createElement("div");
  number.className = "roll-toast-number";
  number.setAttribute("aria-hidden", "true");
  die.append(dieIcon, number);
  const moment = document.createElement("div");
  moment.className = "roll-toast-moment";
  moment.textContent = momentText(roll);
  const detail = document.createElement("div");
  detail.className = "roll-toast-detail";
  toast.replaceChildren(label, die, moment, detail);
  const extra = momentClasses(roll);
  toast.className = ["is-tumbling", ...extra].join(" ");
  toast.setAttribute("aria-label", `${rollTitle(roll)}: ${roll.natural ?? roll.total}${roll.success === null || roll.success === undefined ? "" : `, ${t(roll.success ? "activity.roll.success" : "activity.roll.failure")}`}`);
  clearTimeout(app.rollToastTimer);
  let ticks = 0;
  const tumble = setInterval(() => {
    number.textContent = randomFace();
    if (++ticks < 11) return;
    clearInterval(tumble);
    number.textContent = String(roll.natural ?? roll.total);
    detail.textContent = rollDetail(roll);
    toast.className = [roll.success === false ? "is-failure" : roll.success === true ? "is-success" : "is-neutral", ...extra].join(" ");
    // The next waiting roll takes over after a short hold; the last one stays a little longer.
    const hold = toastQueue.length > 0 ? 1400 : 5000;
    app.rollToastTimer = setTimeout(() => { if (toastQueue.length === 0) toast.className = ""; }, hold);
    setTimeout(done, toastQueue.length > 0 ? 1400 : 0);
  }, 80);
}

export function rollLabel(test) {
  if (!test) return t("activity.dice.abilityCheck");
  // Skill ids are camelCase ("animalHandling"), so the id is tried as it is before its lower-case form.
  const raw = String(test.kind === "skill" ? test.skill : test.ability);
  const name = [raw, raw.toLocaleLowerCase()].map((key) => t(`activity.rule.${key}`)).find((text) => !text.startsWith("activity.rule.")) ?? raw;
  return test.kind === "save" ? t("activity.dice.save", { ability: name }) : test.kind === "skill" ? t("activity.dice.skill", { skill: name }) : t("activity.dice.ability", { ability: name });
}

// Back to a die waiting to be rolled.
function readyDie(box) {
  clearInterval(tumbleTimer);
  clearTimeout(autoCloseTimer);
  box.classList.remove("is-rolling", "is-settling", "is-landed", "is-success", "is-failure", "is-critical-success", "is-critical-failure", "is-natural20", "is-natural1");
  box.dataset.phase = "ready";
  document.querySelector("#dice-face").textContent = "20";
  document.querySelector("#dice-result").hidden = true;
  for (const step of document.querySelectorAll("#dice-result .dr-step")) step.classList.remove("is-shown");
}

export function updateRollPrompt(pendingRoll) {
  const box = dialog();
  // A roll in flight keeps the dialog until its result has been shown; a newer check waits for it to close.
  if (app.rollingCheck) return;
  if (pendingRoll === null) {
    if (box.open) box.close();
    app.lastRollPromptId = null;
    return;
  }
  if (pendingRoll.checkId === app.lastRollPromptId) return;
  app.lastRollPromptId = pendingRoll.checkId;
  readyDie(box);
  document.querySelector("#dice-test").textContent = rollLabel(pendingRoll.test);
  document.querySelector("#dice-action").textContent = pendingRoll.action?.trim() || t("activity.dice.waiting");
  document.querySelector("#dice-title").textContent = t("activity.dice.title");
  const diceDescription = document.querySelector("#dice-description");
  diceDescription.textContent = "";
  diceDescription.hidden = true;
  document.querySelector("#dice-roll-button span").textContent = t("activity.dice.rollD20");
  document.querySelector("#dice-roll-button").disabled = false;
  if (!box.open) box.showModal();
}

// A prompt the player closed comes back from the action panel.
export function openRollPrompt() {
  app.lastRollPromptId = null;
  updateRollPrompt(app.currentSnapshot?.kind === "table" ? app.currentSnapshot.pendingRoll : null);
}

// The die slows, stops on the real number, and the sum is built up a step at a time.
async function landOn(box, roll) {
  clearInterval(tumbleTimer);
  const face = document.querySelector("#dice-face");
  box.classList.remove("is-rolling");
  if (!calm()) {
    box.classList.add("is-settling");
    for (const delay of settleDelays) {
      face.textContent = randomFace();
      await pause(delay);
      if (!box.open) return;
    }
  }
  face.textContent = String(roll.natural);
  box.classList.remove("is-settling");
  box.classList.add("is-landed", roll.success ? "is-success" : "is-failure", ...momentClasses(roll));
  box.dataset.phase = "landed";
  document.querySelector("#dr-mod").textContent = signed(roll.total - roll.natural);
  document.querySelector("#dr-total").textContent = `= ${roll.total}`;
  document.querySelector("#dr-dc").textContent = t("activity.dice.versusDc", { dc: roll.dc });
  document.querySelector("#dr-moment").textContent = momentText(roll);
  document.querySelector("#dice-result").hidden = false;
  document.querySelector("#dice-description").hidden = true;
  for (const step of document.querySelectorAll("#dice-result .dr-step")) {
    step.classList.add("is-shown");
    if (!calm()) await pause(stepRevealMs);
    if (!box.open) return;
  }
  document.querySelector("#dice-title").textContent = t(roll.success ? "activity.roll.success" : "activity.roll.failure");
  const button = document.querySelector("#dice-roll-button");
  button.querySelector("span").textContent = t("activity.dice.done");
  button.disabled = false;
  autoCloseTimer = setTimeout(() => { if (box.open) box.close(); }, autoCloseMs);
}

export async function rollPendingCheck() {
  const box = dialog();
  const pending = app.currentSnapshot?.kind === "table" ? app.currentSnapshot.pendingRoll : null;
  if (app.currentGameId === null || app.rollingCheck || pending === null) return;
  const button = document.querySelector("#dice-roll-button");
  app.rollingCheck = true;
  readyDie(box);
  const landed = new Promise((resolve) => { awaiting = { checkId: pending.checkId, resolve }; });
  button.disabled = true;
  button.querySelector("span").textContent = t("activity.dice.rolling");
  document.querySelector("#dice-title").textContent = t("activity.dice.rollingTitle");
  document.querySelector("#dice-description").hidden = false;
  document.querySelector("#dice-description").textContent = t("activity.dice.sending");
  box.dataset.phase = "rolling";
  box.classList.add("is-rolling");
  if (!calm()) tumbleTimer = setInterval(() => { document.querySelector("#dice-face").textContent = randomFace(); }, 70);
  const startedAt = Date.now();
  let finished = false;
  try {
    const response = app.currentGameId === "local-preview"
      ? previewRoll(pending)
      : await requestJson(`/api/activity/games/${encodeURIComponent(app.currentGameId)}/action`, {
        method: "POST",
        body: JSON.stringify({ kind: "roll" }),
      });
    if (response.snapshot) {
      app.currentSnapshot = response.snapshot;
      app.tableToken = response.token ?? null;
      app.lastFullTableAt = Date.now();
      renderGame(app.currentSnapshot);
    }
    document.querySelector("#dice-description").textContent = t("activity.dice.applying");
    // The table settles the roll a moment after the press, so it is asked for until this check's result is there.
    const watching = (async () => {
      const until = Date.now() + resultTimeoutMs;
      while (!finished && Date.now() < until) {
        await pause(pollEveryMs);
        if (!finished) await loadTable();
      }
      return null;
    })();
    const roll = await Promise.race([landed, watching]);
    finished = true;
    // Closed by the player meanwhile: the result comes up as a toast when the table next brings it.
    if (!box.open) return;
    if (roll === null) {
      box.close();
      setLiveMessage(t("activity.dice.slow"));
      return;
    }
    await pause(Math.max(0, minimumTumbleMs - (Date.now() - startedAt)));
    if (box.open) await landOn(box, roll);
  } catch (error) {
    finished = true;
    awaiting = null;
    clearInterval(tumbleTimer);
    box.classList.remove("is-rolling", "is-settling");
    box.dataset.phase = "failed";
    document.querySelector("#dice-title").textContent = t("activity.dice.failed");
    document.querySelector("#dice-description").textContent = error instanceof Error ? error.message : t("activity.dice.tryAgain");
    button.disabled = false;
    button.querySelector("span").textContent = t("activity.dice.tryAgain");
    app.rollingCheck = false;
  }
}

dialog().addEventListener("close", () => {
  const box = dialog();
  clearInterval(tumbleTimer);
  clearTimeout(autoCloseTimer);
  box.classList.remove("is-rolling", "is-settling");
  if (awaiting !== null) { awaiting.resolve(null); awaiting = null; }
  const wasBusy = app.rollingCheck;
  app.rollingCheck = false;
  // A check that came in while this one was being rolled gets its prompt now.
  if (wasBusy) updateRollPrompt(app.currentSnapshot?.kind === "table" ? app.currentSnapshot.pendingRoll : null);
});

document.querySelector("#dice-roll-button").addEventListener("click", () => {
  if (dialog().dataset.phase === "landed") dialog().close();
  else void rollPendingCheck();
});

document.querySelector("#dice-close").addEventListener("click", () => dialog().close());
