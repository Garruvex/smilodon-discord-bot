import { app } from "./state.js";
import { requestJson } from "./api.js";
import { t } from "./i18n.js";
import { renderGame } from "./render.js";

// A settled roll of the viewer's hero: numbers tumble for a moment, then the real result stays up. Each roll shows once; what was
// already settled when the page opened is marked seen without a show.
export const seenRolls = new Set();

export function showRolls(rolls) {
  const fresh = rolls.filter((roll) => !seenRolls.has(roll.id));
  for (const roll of rolls) seenRolls.add(roll.id);
  if (!app.rollsPrimed) { app.rollsPrimed = true; return; }
  const roll = fresh.at(-1);
  if (!roll) return;
  let toast = document.querySelector("#roll-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "roll-toast";
    toast.setAttribute("role", "status");
    document.body.append(toast);
  }
  const modifier = roll.total - roll.natural;
  const sum = `${modifier < 0 ? "−" : "+"} ${Math.abs(modifier)}`;
  const label = document.createElement("div");
  label.className = "roll-toast-label";
  label.textContent = rollLabel(roll.test);
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
  moment.textContent = roll.moment === "natural20" ? t(roll.success ? "activity.roll.natural20Success" : "activity.roll.natural20Failure")
    : roll.moment === "natural1" ? t(roll.success ? "activity.roll.natural1Success" : "activity.roll.natural1Failure") : "";
  const detail = document.createElement("div");
  detail.className = "roll-toast-detail";
  toast.replaceChildren(label, die, moment, detail);
  const momentClass = roll.moment === "natural20" ? " is-natural20" : roll.moment === "natural1" ? " is-natural1" : "";
  const criticalClass = roll.moment === "natural20" && roll.success ? " is-critical-success" : roll.moment === "natural1" && !roll.success ? " is-critical-failure" : "";
  toast.className = `is-tumbling${momentClass}${criticalClass}`;
  toast.setAttribute("aria-label", `${rollLabel(roll.test)}: ${roll.natural}, ${t(roll.success ? "activity.roll.success" : "activity.roll.failure")}`);
  clearTimeout(app.rollToastTimer);
  let ticks = 0;
  const tumble = setInterval(() => {
    number.textContent = String(1 + Math.floor(Math.random() * 20));
    if (++ticks < 11) return;
    clearInterval(tumble);
    number.textContent = String(roll.natural);
    detail.textContent = t("activity.roll.result", { natural: roll.natural, sum, total: roll.total, dc: roll.dc, outcome: t(roll.success ? "activity.roll.success" : "activity.roll.failure") });
    toast.className = `${roll.success ? "is-success" : "is-failure"}${momentClass}${criticalClass}`;
    app.rollToastTimer = setTimeout(() => { toast.className = ""; }, 5000);
  }, 80);
}


export function humanizeRuleName(value) {
  return String(value ?? "check").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}


export function rollLabel(test) {
  if (!test) return t("activity.dice.abilityCheck");
  const key = String(test.kind === "skill" ? test.skill : test.ability).toLocaleLowerCase();
  const name = t(`activity.rule.${key}`);
  return test.kind === "save" ? t("activity.dice.save", { ability: name }) : test.kind === "skill" ? t("activity.dice.skill", { skill: name }) : t("activity.dice.ability", { ability: name });
}


export function updateRollPrompt(pendingRoll) {
  const dialog = document.querySelector("#dice-dialog");
  if (pendingRoll === null) {
    if (!app.rollingCheck && dialog.open) dialog.close();
    if (!app.rollingCheck) app.lastRollPromptId = null;
    return;
  }
  if (pendingRoll.checkId === app.lastRollPromptId) return;
  app.lastRollPromptId = pendingRoll.checkId;
  document.querySelector("#dice-test").textContent = rollLabel(pendingRoll.test);
  document.querySelector("#dice-action").textContent = pendingRoll.action?.trim() || t("activity.dice.waiting");
  document.querySelector("#dice-title").textContent = t("activity.dice.title");
  const diceDescription = document.querySelector("#dice-description");
  diceDescription.textContent = "";
  diceDescription.hidden = true;
  document.querySelector("#dice-roll-button span").textContent = t("activity.dice.rollD20");
  document.querySelector("#dice-roll-button").disabled = false;
  if (!dialog.open) dialog.showModal();
}


export async function rollPendingCheck() {
  if (app.currentGameId === null || app.rollingCheck) return;
  const dialog = document.querySelector("#dice-dialog");
  const button = document.querySelector("#dice-roll-button");
  app.rollingCheck = true;
  button.disabled = true;
  button.querySelector("span").textContent = t("activity.dice.rolling");
  dialog.classList.add("is-rolling");
  document.querySelector("#dice-title").textContent = t("activity.dice.rollingTitle");
  document.querySelector("#dice-description").hidden = false;
  document.querySelector("#dice-description").textContent = t("activity.dice.sending");
  const startedAt = Date.now();
  try {
    const response = await requestJson(`/api/activity/games/${encodeURIComponent(app.currentGameId)}/action`, {
      method: "POST",
      body: JSON.stringify({ kind: "roll" }),
    });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1150 - (Date.now() - startedAt))));
    if (response.snapshot) {
      app.currentSnapshot = response.snapshot;
      app.tableToken = response.token ?? null;
      app.lastFullTableAt = Date.now();
      renderGame(app.currentSnapshot);
    }
    document.querySelector("#dice-title").textContent = t("activity.dice.sent");
    document.querySelector("#dice-description").textContent = t("activity.dice.applying");
    button.querySelector("span").textContent = t("activity.dice.done");
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (dialog.open) dialog.close();
  } catch (error) {
    document.querySelector("#dice-title").textContent = t("activity.dice.failed");
    document.querySelector("#dice-description").textContent = error instanceof Error ? error.message : t("activity.dice.tryAgain");
    button.disabled = false;
    button.querySelector("span").textContent = t("activity.dice.tryAgain");
    app.lastRollPromptId = null;
  } finally {
    app.rollingCheck = false;
    dialog.classList.remove("is-rolling");
  }
}


document.querySelector("#dice-roll-button").addEventListener("click", () => void rollPendingCheck());

document.querySelector("#dice-close").addEventListener("click", () => document.querySelector("#dice-dialog").close());

