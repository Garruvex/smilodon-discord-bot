import { t } from "./i18n.js";
import { iconImage, makeButton } from "./dom.js";

// The hotbar along the bottom of the screen during your turn in a fight: what is left of the turn, one slot per kind of action,
// and End turn. A slot opens a short list above it. Display and shortcuts only: every button is one the Actions tab already offers.
let bar = null;
let watcher = null;
let openCategory = null;
let last = null;

const gem = (key, left) => {
  const pip = document.createElement("span");
  pip.className = `hotbar-pip pip-${key}${left ? "" : " is-spent"}`;
  pip.title = `${t(`activity.fight.${key}`)} · ${t(left ? "activity.fight.available" : "activity.fight.used")}`;
  pip.append(Object.assign(document.createElement("i"), { className: "hotbar-gem" }), Object.assign(document.createElement("small"), { textContent: t(`activity.fight.${key}`) }));
  return pip;
};

function openActions() {
  document.querySelector("#hero-tab-actions")?.click();
  document.querySelector("#hero-panel-actions")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function closePopover() {
  if (openCategory === null) return;
  openCategory = null;
  if (last !== null) draw(true);
}

function draw(force) {
  const { game, performAction, groups, meta } = last;
  const budget = game.turn.budget;
  const next = document.createElement("div");
  next.id = "turn-bar";
  next.setAttribute("role", "region");
  next.setAttribute("aria-label", t("activity.turnbar.title"));
  const pips = document.createElement("div");
  pips.className = "hotbar-pips";
  pips.append(gem("action", budget.action), gem("bonusAction", budget.bonusAction), gem("reaction", budget.reaction));
  pips.append(Object.assign(document.createElement("span"), { className: "hotbar-move", textContent: t("activity.fight.movement", { feet: budget.movement }) }));
  if (budget.attacksLeft > 1) pips.append(Object.assign(document.createElement("span"), { className: "hotbar-move", textContent: t("activity.fight.attacksLeft", { count: budget.attacksLeft }) }));
  const slots = document.createElement("div");
  slots.className = "hotbar-slots";
  const choicesOf = (category) => (groups.get(category) ?? []).filter((node) => node instanceof HTMLButtonElement);
  const categories = meta.order.filter((category) => category !== "talk" && choicesOf(category).length > 0);
  if (!categories.includes(openCategory)) openCategory = null;
  for (const category of categories) {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "hotbar-slot ui-control";
    slot.dataset.category = category;
    slot.setAttribute("aria-expanded", String(openCategory === category));
    const count = Object.assign(document.createElement("b"), { textContent: String(choicesOf(category).length) });
    slot.append(iconImage(meta.icon[category]), Object.assign(document.createElement("span"), { textContent: t(`activity.category.${category}`) }), count);
    slot.addEventListener("click", () => { openCategory = openCategory === category ? null : category; draw(true); });
    slots.append(slot);
  }
  const end = makeButton(t("activity.action.endTurn"), () => { openCategory = null; void performAction({ kind: "endTurn" }); }, true, null);
  end.classList.add("hotbar-end");
  next.append(pips, slots, end);
  if (openCategory !== null) {
    const popover = document.createElement("div");
    popover.className = "hotbar-popover";
    popover.setAttribute("role", "group");
    popover.setAttribute("aria-label", t(`activity.category.${openCategory}`));
    popover.append(...choicesOf(openCategory));
    // A choice made in steps (a spell with levels) opens its card in the Actions tab, so the view goes there; a plain press just closes the list.
    popover.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button === null) return;
      const steps = button.hasAttribute("aria-expanded");
      openCategory = null;
      draw(true);
      if (steps) openActions();
    });
    next.prepend(popover);
  }
  // Rebuilt only when it would read differently, so a press is not lost to a refresh.
  if (!force && bar !== null && bar.innerHTML === next.innerHTML) return;
  bar?.remove();
  bar = next;
  document.body.append(bar);
  watcher?.disconnect();
  watcher = new ResizeObserver(() => {
    document.documentElement.style.setProperty("--turn-bar-h", `${bar.offsetHeight}px`);
    window.dispatchEvent(new Event("resize"));
  });
  watcher.observe(bar);
}

// groups: the buttons by kind of action, built for this bar alone (a button can sit in one place). meta: the kinds in order, with their icons.
export function renderTurnBar(game, performAction, groups, meta) {
  const show = game.mode === "combat" && game.yourTurn === true && game.turn && !game.turn.busy && game.turn.budget !== undefined && groups !== null;
  document.body.classList.toggle("has-turn-bar", Boolean(show));
  if (!show) { bar?.remove(); bar = null; last = null; openCategory = null; watcher?.disconnect(); return; }
  const starting = bar === null;
  last = { game, performAction, groups, meta };
  draw(false);
  // When your turn comes round the view goes to the stage: the turn order on top, the battlefield below, the hotbar under it.
  if (starting) setTimeout(() => document.querySelector(".turn-order")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), 350);
}

document.addEventListener("click", (event) => {
  if (openCategory !== null && !(event.target instanceof Element && event.target.closest("#turn-bar"))) closePopover();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePopover(); });
