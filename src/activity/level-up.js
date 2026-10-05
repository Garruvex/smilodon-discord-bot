import { app } from "./state.js";
import { classText, t } from "./i18n.js";
import { performAction } from "./actions.js";
import { abilityName, signed } from "./hero-sheet.js";

// Level-up: a banner on your hero page while an ability improvement waits, and a dialog for every choice that comes with levelling.
// The engine decides each one; this only collects the player's pick and says why one is refused.
const abilityOrder = ["str", "dex", "con", "int", "wis", "cha"];
const draft = { mode: "two", picks: [], invocations: null };
const statusLine = () => document.querySelector("#level-up-status");

function dialog() {
  let box = document.querySelector("#level-up");
  if (box !== null) return box;
  box = document.createElement("dialog");
  box.id = "level-up";
  box.className = "level-up-dialog";
  box.setAttribute("aria-labelledby", "level-up-title");
  box.addEventListener("click", (event) => { if (event.target === box) box.close(); });
  document.body.append(box);
  return box;
}

// Sends one choice and shows the game's answer in the dialog, where the player is looking.
async function choose(action) {
  const ok = await performAction(action);
  const line = statusLine();
  if (line !== null) {
    line.textContent = document.querySelector("#live-message")?.textContent ?? "";
    line.dataset.state = ok ? "ok" : "error";
  }
  if (ok) { draft.picks = []; draft.invocations = null; }
  paintLevelUp(app.currentSnapshot);
}

function section(titleKey, ...content) {
  const part = document.createElement("section");
  part.className = "level-up-section";
  part.append(Object.assign(document.createElement("h3"), { textContent: t(titleKey) }), ...content);
  return part;
}

function button(label, onClick, { primary = false, disabled = false } = {}) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `ui-control${primary ? " primary" : ""}`;
  control.textContent = label;
  control.disabled = disabled;
  control.addEventListener("click", onClick);
  return control;
}

function improvementSection(level) {
  const count = level.pendingAsi;
  const choices = document.createElement("div");
  choices.className = "level-up-modes";
  for (const mode of ["two", "one"]) {
    const option = button(t(`activity.levelUp.mode.${mode}`), () => { draft.mode = mode; draft.picks = []; paintLevelUp(app.currentSnapshot); });
    option.setAttribute("aria-pressed", String(draft.mode === mode));
    choices.append(option);
  }
  const need = draft.mode === "two" ? 1 : 2;
  const tiles = document.createElement("div");
  tiles.className = "level-up-abilities";
  for (const ability of abilityOrder) {
    const score = level.scores[ability];
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "level-up-ability";
    tile.disabled = score >= 20;
    tile.setAttribute("aria-pressed", String(draft.picks.includes(ability)));
    tile.append(
      Object.assign(document.createElement("span"), { textContent: abilityName(ability) }),
      Object.assign(document.createElement("strong"), { textContent: String(score) }),
      Object.assign(document.createElement("small"), { textContent: score >= 20 ? t("activity.levelUp.capped") : `${signed(Math.floor((score - 10) / 2))} → ${signed(Math.floor((score + (draft.mode === "two" ? 2 : 1) - 10) / 2))}` }),
    );
    tile.addEventListener("click", () => {
      draft.picks = draft.picks.includes(ability) ? draft.picks.filter((entry) => entry !== ability) : [...draft.picks, ability].slice(-need);
      paintLevelUp(app.currentSnapshot);
    });
    tiles.append(tile);
  }
  const apply = button(t("activity.levelUp.apply"), () => void choose(draft.mode === "two" ? { kind: "chooseAsi", plusTwo: draft.picks[0] } : { kind: "chooseAsi", plusOne: draft.picks }), { primary: true, disabled: draft.picks.length !== need });
  return section("activity.levelUp.improvement", Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.levelUp.waiting", { count }) }), choices, tiles, apply);
}

function requirementText(requires) {
  return t("activity.levelUp.needs", { need: requires.map((group) => group.map(abilityName).join(` ${t("activity.levelUp.or")} `)).join(" + ") + " 13" });
}

function classSection(level) {
  const plan = level.classPlan;
  const list = document.createElement("div");
  list.className = "level-up-classes";
  for (const choice of plan.choices) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "level-up-class";
    row.disabled = !choice.allowed;
    row.setAttribute("aria-pressed", String(choice.buildClass === plan.landing));
    const name = classText(choice.buildClass);
    row.append(
      Object.assign(document.createElement("strong"), { textContent: choice.current ? t("activity.levelUp.classCurrent", { name, level: choice.level }) : name }),
      Object.assign(document.createElement("small"), { textContent: choice.allowed ? (choice.current ? t("activity.levelUp.keep") : t("activity.levelUp.multiclass")) : requirementText(choice.requires) }),
    );
    row.addEventListener("click", () => void choose({ kind: "chooseClassLevel", buildClass: choice.buildClass }));
    list.append(row);
  }
  const parts = [
    Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.levelUp.next", { level: plan.level, name: classText(plan.landing), hp: plan.hpGain }) }),
  ];
  if (plan.gains.length > 0) parts.push(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.levelUp.gains", { features: plan.gains.join(", ") }) }));
  parts.push(list);
  if (plan.skillOptions.length > 0) {
    const pick = document.createElement("select");
    pick.className = "ui-control";
    pick.setAttribute("aria-label", t("activity.levelUp.skill"));
    for (const skill of plan.skillOptions) pick.append(Object.assign(document.createElement("option"), { value: skill, textContent: t(`activity.rule.${skill.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`), selected: skill === plan.skill }));
    pick.addEventListener("change", () => void choose({ kind: "chooseClassLevel", buildClass: plan.landing, skill: pick.value }));
    parts.push(pick);
  }
  return section("activity.levelUp.nextLevel", ...parts);
}

function styleSection(style) {
  const pick = document.createElement("select");
  pick.className = "ui-control";
  pick.setAttribute("aria-label", t("activity.levelUp.style"));
  for (const option of style.options) pick.append(Object.assign(document.createElement("option"), { value: option.id, textContent: option.name, selected: option.id === style.held }));
  return section("activity.levelUp.style", pick, button(t("activity.levelUp.change"), () => void choose({ kind: "chooseFightingStyle", styleId: pick.value })));
}

function warlockSection(warlock) {
  if (draft.invocations === null) draft.invocations = [...warlock.held];
  const grid = document.createElement("div");
  grid.className = "level-up-invocations";
  for (const option of warlock.options) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = draft.invocations.includes(option.id);
    box.disabled = !box.checked && draft.invocations.length >= warlock.slots;
    box.addEventListener("change", () => {
      draft.invocations = box.checked ? [...draft.invocations, option.id] : draft.invocations.filter((id) => id !== option.id);
      paintLevelUp(app.currentSnapshot);
    });
    label.append(box, document.createTextNode(option.name));
    grid.append(label);
  }
  const parts = [Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.levelUp.invocations", { count: draft.invocations.length, slots: warlock.slots }) }), grid,
    button(t("activity.levelUp.apply"), () => void choose({ kind: "chooseWarlockOptions", invocations: draft.invocations }), { primary: true })];
  if (warlock.boon !== null) {
    const pick = document.createElement("select");
    pick.className = "ui-control";
    pick.setAttribute("aria-label", t("activity.levelUp.boon"));
    if (warlock.boon.held === null) pick.append(Object.assign(document.createElement("option"), { value: "", textContent: t("activity.levelUp.none"), selected: true }));
    for (const option of warlock.boon.options) pick.append(Object.assign(document.createElement("option"), { value: option.id, textContent: option.name, selected: option.id === warlock.boon.held }));
    parts.push(Object.assign(document.createElement("h4"), { textContent: t("activity.levelUp.boon") }), pick, button(t("activity.levelUp.change"), () => { if (pick.value !== "") void choose({ kind: "chooseWarlockOptions", pactBoon: pick.value }); }));
  }
  return section("activity.levelUp.warlock", ...parts);
}

function paintLevelUp(game) {
  const box = dialog();
  const level = game?.levelUp;
  if (level === null || level === undefined) { if (box.open) box.close(); return; }
  const status = Object.assign(document.createElement("p"), { id: "level-up-status", className: "level-up-status", role: "status" });
  status.textContent = statusLine()?.textContent ?? "";
  status.dataset.state = statusLine()?.dataset.state ?? "";
  const head = document.createElement("header");
  head.append(Object.assign(document.createElement("h2"), { id: "level-up-title", textContent: t("activity.levelUp.title") }), button("×", () => box.close()));
  head.lastChild.setAttribute("aria-label", t("activity.rules.close"));
  const parts = [head];
  if (level.pendingAsi > 0) parts.push(improvementSection(level));
  if (level.classPlan !== null) parts.push(classSection(level));
  if (level.fightingStyle !== null) parts.push(styleSection(level.fightingStyle));
  if (level.warlock !== null) parts.push(warlockSection(level.warlock));
  parts.push(status);
  box.replaceChildren(...parts);
}

document.addEventListener("open-level-up", () => openLevelUp());

export function openLevelUp() {
  const box = dialog();
  paintLevelUp(app.currentSnapshot);
  if (!box.open && app.currentSnapshot?.levelUp) box.showModal();
}

// The strip across the top of your hero page while an improvement waits, and a quiet link to the same dialog when only changes are possible.
export function renderLevelUpBanner(game) {
  let banner = document.querySelector("#level-up-banner");
  if (banner === null) {
    banner = document.createElement("div");
    banner.id = "level-up-banner";
    banner.className = "level-up-banner";
    document.querySelector(".hero-body").before(banner);
  }
  const level = game.levelUp;
  const owed = level?.owed === true;
  banner.hidden = !owed;
  if (!owed) { banner.replaceChildren(); return; }
  banner.replaceChildren(
    Object.assign(document.createElement("span"), { textContent: t("activity.levelUp.banner", { count: level.pendingAsi }) }),
    button(t("activity.levelUp.open"), () => openLevelUp(), { primary: true }),
  );
  const box = document.querySelector("#level-up");
  if (box?.open) paintLevelUp(game);
}
