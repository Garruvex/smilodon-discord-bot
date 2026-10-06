import { app } from "./state.js";
import { t } from "./i18n.js";
import { featureText } from "./feature-texts.js";
import { performAction } from "./actions.js";
import { setLiveMessage } from "./dom.js";

// Overview: the hero's abilities, training, progress and features from the game state.
const abilityOrder = ["str", "dex", "con", "int", "wis", "cha"];
const camel = (slug) => slug.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
export const abilityName = (ability) => t(`activity.sheet.ability.${ability}`);
export const signed = (value) => (value >= 0 ? `+${value}` : `−${Math.abs(value)}`);

function block(titleKey, ...content) {
  const section = document.createElement("section");
  section.className = "sheet-block";
  const heading = document.createElement("h3");
  heading.textContent = t(titleKey);
  section.append(heading, ...content);
  return section;
}

function stat(label, value) {
  const item = document.createElement("div");
  item.className = "sheet-stat";
  item.append(Object.assign(document.createElement("span"), { textContent: label }), Object.assign(document.createElement("strong"), { textContent: value }));
  return item;
}

function progressBlock(sheet) {
  const { level, xp, floor, next } = sheet.progress;
  const lines = [];
  const head = document.createElement("p");
  head.className = "sheet-progress-head";
  head.textContent = t("activity.sheet.level", { level });
  lines.push(head);
  if (xp === null) lines.push(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.sheet.milestone") }));
  else if (next === null) lines.push(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.sheet.xpMax", { xp: xp.toLocaleString() }) }));
  else {
    const bar = document.createElement("span");
    bar.className = "sheet-xp ui-meter";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", t("activity.sheet.progress"));
    bar.setAttribute("aria-valuemin", String(floor));
    bar.setAttribute("aria-valuemax", String(next));
    bar.setAttribute("aria-valuenow", String(Math.max(floor, Math.min(next, xp))));
    bar.setAttribute("aria-valuetext", t("activity.sheet.xp", { xp: xp.toLocaleString(), next: next.toLocaleString(), level: level + 1 }));
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(100, Math.round(((xp - floor) / Math.max(1, next - floor)) * 100)))}%`;
    bar.append(fill);
    lines.push(bar, Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.sheet.xp", { xp: xp.toLocaleString(), next: next.toLocaleString(), level: level + 1 }) }));
  }
  const summary = document.createElement("div");
  summary.className = "hero-progress-summary";
  summary.append(...lines);
  return summary;
}

export function renderHeroProgress(sheet) {
  let progress = document.querySelector("#hero-progress");
  if (progress === null) {
    progress = document.createElement("section");
    progress.id = "hero-progress";
    progress.className = "hero-progress";
    document.querySelector("#live-hero-subtitle").after(progress);
  }
  progress.hidden = !sheet;
  progress.replaceChildren(...(sheet ? [progressBlock(sheet)] : []));
}

function skillsBlock(sheet) {
  const saves = document.createElement("div");
  saves.className = "sheet-saves";
  for (const save of sheet.saves) {
    const chip = document.createElement("span");
    chip.className = `sheet-chip${save.proficient ? " is-proficient" : ""}`;
    chip.textContent = `${abilityName(save.ability)} ${signed(save.bonus)}`;
    saves.append(chip);
  }
  const list = document.createElement("ul");
  list.className = "sheet-skills";
  for (const skill of [...sheet.skills].sort((a, b) => abilityOrder.indexOf(a.ability) - abilityOrder.indexOf(b.ability))) {
    const row = document.createElement("li");
    row.dataset.proficiency = skill.proficiency;
    const mark = skill.proficiency === "expertise" ? "◆" : skill.proficiency === "proficient" ? "●" : "○";
    row.append(
      Object.assign(document.createElement("span"), { className: "sheet-mark", textContent: mark }),
      Object.assign(document.createElement("span"), { className: "sheet-skill-name", textContent: t(`activity.rule.${camel(skill.skill)}`) }),
      Object.assign(document.createElement("small"), { textContent: abilityName(skill.ability) }),
      Object.assign(document.createElement("b"), { textContent: signed(skill.bonus) }),
    );
    list.append(row);
  }
  const legend = Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.sheet.legend") });
  return block("activity.sheet.skills", Object.assign(document.createElement("h4"), { textContent: t("activity.sheet.saves") }), saves, Object.assign(document.createElement("h4"), { textContent: t("activity.sheet.skillList") }), list, legend);
}

// Saves this hero's progress to your library, to pick when you join another game.
function saveBlock() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-control";
  button.textContent = t("activity.sheet.saveProgress");
  button.addEventListener("click", async () => {
    if (await performAction({ kind: "saveProgress" })) setLiveMessage(t("activity.sheet.progressSaved"));
  });
  return block("activity.sheet.saveTitle", Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.sheet.saveWhat") }), button);
}

function featuresBlock(sheet) {
  const list = document.createElement("div");
  list.className = "sheet-features";
  for (const feature of sheet.features) {
    const item = document.createElement("details");
    item.className = "sheet-feature";
    const text = featureText(feature.id, app.uiLanguage);
    const head = document.createElement("summary");
    head.textContent = feature.name;
    item.append(head, Object.assign(document.createElement("p"), { textContent: text ?? t("activity.sheet.noText") }));
    list.append(item);
  }
  if (sheet.features.length === 0) list.append(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.sheet.noFeatures") }));
  return block("activity.sheet.features", list);
}

export function renderOverview(game) {
  const panel = document.querySelector("#hero-panel-overview");
  const sheet = game.heroSheet;
  if (sheet === null || sheet === undefined) { panel.replaceChildren(); return; }
  const strip = document.createElement("div");
  strip.className = "sheet-strip";
  strip.append(
    stat(t("activity.sheet.proficiency"), signed(sheet.proficiencyBonus)),
    stat(t("activity.sheet.speed"), t("activity.sheet.feet", { n: sheet.speed })),
    stat(t("activity.sheet.initiative"), signed(sheet.initiative)),
    stat(t("activity.sheet.passive"), String(sheet.passivePerception)),
  );
  const scores = document.createElement("div");
  scores.className = "sheet-abilities";
  for (const entry of sheet.abilities) {
    const tile = document.createElement("div");
    tile.className = "sheet-ability";
    tile.append(
      Object.assign(document.createElement("span"), { textContent: abilityName(entry.ability) }),
      Object.assign(document.createElement("strong"), { textContent: signed(entry.modifier) }),
      Object.assign(document.createElement("small"), { textContent: String(entry.score) }),
    );
    scores.append(tile);
  }
  panel.replaceChildren(strip, block("activity.sheet.abilities", scores), skillsBlock(sheet), featuresBlock(sheet), ...(game.canSaveProgress ? [saveBlock()] : []));
}

// Other heroes and enemies expose public table details, rather than your private sheet.
export function renderPublicOverview(profile, status) {
  const strip = document.createElement("div");
  strip.className = "sheet-strip";
  strip.append(stat(t("activity.detail.status"), status));
  if (profile.zone) strip.append(stat(t("activity.detail.location"), profile.zone));
  document.querySelector("#hero-panel-overview").replaceChildren(strip);
}
