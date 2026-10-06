import { t } from "./i18n.js";

// The Journal tab: the same things the Discord journal and recap tell, kept at hand while you play. Public story only; the game decides what is in it.
const section = (titleKey, ...content) => {
  const box = document.createElement("section");
  box.className = "sheet-block";
  box.append(Object.assign(document.createElement("h3"), { textContent: t(titleKey) }), ...content);
  return box;
};
const list = (items) => {
  const ul = document.createElement("ul");
  ul.className = "journal-list";
  for (const item of items) ul.append(Object.assign(document.createElement("li"), { textContent: item }));
  return ul;
};

export function renderJournal(game) {
  let panel = document.querySelector("#hero-panel-journal");
  if (panel === null) {
    panel = document.createElement("section");
    panel.className = "hero-tab-panel";
    panel.id = "hero-panel-journal";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "hero-tab-journal");
    panel.hidden = true;
    document.querySelector(".hero-body").append(panel);
  }
  const data = game.journal;
  if (!data) { panel.replaceChildren(); return; }
  const { journal, places, recap } = data;
  const blocks = [];
  if (journal.sceneTitle !== null) blocks.push(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.journal.where", { scene: journal.sceneTitle }) }));
  if (recap.latestChapter !== null || recap.recent.length > 0) {
    blocks.push(section("activity.journal.recap", ...(recap.latestChapter === null ? [] : [Object.assign(document.createElement("p"), { textContent: recap.latestChapter })]), ...(recap.recent.length === 0 ? [] : [list(recap.recent.map((told) => told.replace(/\n+/g, " ")))])));
  }
  if (journal.chapters.length > 0) blocks.push(section("activity.journal.chapters", list(journal.chapters.map((chapter) => t("activity.journal.chapter", { from: chapter.fromRound, through: chapter.throughRound, text: chapter.text })))));
  if (places.length > 0) {
    blocks.push(section("activity.journal.places", list(places.map((place) => [
      place.throughRound === null ? t("activity.journal.placeHere", { scene: place.sceneTitle, from: place.fromRound }) : t("activity.journal.placeRounds", { scene: place.sceneTitle, from: place.fromRound, through: place.throughRound }),
      place.cluesFound === 0 && place.fights === 0 ? null : t("activity.journal.placeFacts", { clues: place.cluesFound, fights: place.fights }),
      place.cluesLeft === 0 ? null : t("activity.journal.placeLeft", { count: place.cluesLeft }),
    ].filter(Boolean).join(" · ")))));
  }
  if (journal.people.length > 0) blocks.push(section("activity.journal.people", list(journal.people.map((person) => person.name + ": " + person.facts.join(" ")))));
  if (journal.clues.length > 0) blocks.push(section("activity.journal.clues", list(journal.clues)));
  if (blocks.length <= 1) blocks.push(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.journal.nothingYet") }));
  panel.replaceChildren(...blocks);
}
