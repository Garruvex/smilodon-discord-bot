import { app } from "./state.js";
import { classText, t } from "./i18n.js";
import { performAction } from "./actions.js";

// A player whose hero has fallen takes a new one: a banner on the hero page, and a dialog that lists the heroes, lets them say how the new one
// arrives, and sends the choice. The server decides who may be taken; the page only shows what the game offers.
const draft = { heroRef: null, entrance: "" };

function dialog() {
  let box = document.querySelector("#replace-hero");
  if (box !== null) return box;
  box = document.createElement("dialog");
  box.id = "replace-hero";
  box.className = "level-up-dialog";
  box.setAttribute("aria-labelledby", "replace-hero-title");
  box.addEventListener("click", (event) => { if (event.target === box) box.close(); });
  document.body.append(box);
  return box;
}

function heroButton(hero, group) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "level-up-class";
  row.setAttribute("aria-pressed", String(draft.heroRef === hero.id));
  row.append(
    Object.assign(document.createElement("strong"), { textContent: hero.name }),
    Object.assign(document.createElement("small"), { textContent: `${classText(hero.className) ?? ""}${group === "saved" ? ` · ${t("activity.replace.saved")}` : ""}` }),
  );
  row.addEventListener("click", () => { draft.heroRef = hero.id; paint(app.currentSnapshot); });
  return row;
}

function paint(game) {
  const box = dialog();
  const replacement = game?.replacement;
  if (replacement === null || replacement === undefined) { if (box.open) box.close(); return; }
  const everyone = [...replacement.options, ...replacement.saved];
  if (draft.heroRef !== null && !everyone.some((hero) => hero.id === draft.heroRef)) draft.heroRef = null;
  const head = document.createElement("header");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ui-control";
  close.textContent = "×";
  close.setAttribute("aria-label", t("activity.rules.close"));
  close.addEventListener("click", () => box.close());
  head.append(Object.assign(document.createElement("h2"), { id: "replace-hero-title", textContent: t("activity.replace.title") }), close);

  const list = document.createElement("div");
  list.className = "level-up-classes";
  for (const hero of replacement.options) list.append(heroButton(hero, "preset"));
  for (const hero of replacement.saved) list.append(heroButton(hero, "saved"));
  if (everyone.length === 0) list.append(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.replace.none") }));

  const entrance = document.createElement("textarea");
  entrance.className = "live-action-input";
  entrance.rows = 2;
  entrance.maxLength = 500;
  entrance.value = draft.entrance;
  entrance.placeholder = t("activity.replace.entrancePlaceholder");
  entrance.setAttribute("aria-label", t("activity.replace.entrance"));
  entrance.addEventListener("input", () => { draft.entrance = entrance.value; });

  const status = Object.assign(document.createElement("p"), { id: "replace-hero-status", className: "level-up-status", role: "status" });
  const join = document.createElement("button");
  join.type = "button";
  join.className = "ui-control primary";
  const chosen = everyone.find((hero) => hero.id === draft.heroRef);
  join.textContent = chosen === undefined ? t("activity.replace.choose") : t("activity.replace.join", { name: chosen.name });
  join.disabled = chosen === undefined;
  join.addEventListener("click", async () => {
    const ok = await performAction({ kind: "replaceHero", heroRef: draft.heroRef, entrance: draft.entrance.trim() });
    status.textContent = document.querySelector("#live-message")?.textContent ?? "";
    status.dataset.state = ok ? "ok" : "error";
    if (ok) { draft.heroRef = null; draft.entrance = ""; box.close(); }
  });

  const body = document.createElement("section");
  body.className = "level-up-section";
  body.append(
    Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.replace.intro", { name: replacement.fallenName }) }),
    list,
    Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t(replacement.saved.some((hero) => hero.id === draft.heroRef) ? "activity.replace.termsSaved" : "activity.replace.terms", { level: replacement.partyLevel, name: replacement.fallenName }) }),
    entrance,
    join,
  );
  const notes = [replacement.fightOn ? t("activity.replace.fightOn") : null, t("activity.replace.revive")].filter(Boolean);
  const hint = Object.assign(document.createElement("p"), { className: "sheet-note", textContent: notes.join(" ") });
  box.replaceChildren(head, body, Object.assign(document.createElement("section"), { className: "level-up-section" }), status);
  box.children[2].append(hint);
}

export function openReplacement() {
  const box = dialog();
  paint(app.currentSnapshot);
  if (!box.open && app.currentSnapshot?.replacement) box.showModal();
}

// The strip across the top of the hero page for a player whose hero has fallen. An open dialog is refreshed only while nobody is typing in it.
export function renderReplacementBanner(game) {
  let banner = document.querySelector("#replace-banner");
  if (banner === null) {
    banner = document.createElement("div");
    banner.id = "replace-banner";
    banner.className = "level-up-banner";
    document.querySelector(".hero-body").before(banner);
  }
  const replacement = game.replacement;
  banner.hidden = replacement === null || replacement === undefined;
  if (banner.hidden) { banner.replaceChildren(); return; }
  const open = document.createElement("button");
  open.type = "button";
  open.className = "ui-control primary";
  open.textContent = t("activity.replace.open");
  open.addEventListener("click", () => openReplacement());
  banner.replaceChildren(Object.assign(document.createElement("span"), { textContent: t("activity.replace.banner", { name: replacement.fallenName }) }), open);
  const box = document.querySelector("#replace-hero");
  if (box?.open && !box.contains(document.activeElement)) paint(game);
}
