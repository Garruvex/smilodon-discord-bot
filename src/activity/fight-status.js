import { t } from "./i18n.js";
import { openRules } from "./rules-book.js";

// What the fight shows beyond health: who is holding a spell, who is dying, what is on each creature, the order of turns, and what your own turn has left.
// All of it is read from the game; nothing here works out a rule.
const chip = (className, text, title = text) => Object.assign(document.createElement("span"), { className: `fight-chip ${className}`, textContent: text, title });

// The pips for a downed hero: three for saves made, three for saves failed.
function savePips(saves) {
  const group = document.createElement("span");
  group.className = "death-saves";
  const label = saves.stable ? t("activity.fight.stable") : t("activity.fight.deathSaves", { successes: saves.successes, failures: saves.failures });
  group.title = label;
  group.setAttribute("role", "img");
  group.setAttribute("aria-label", label);
  if (saves.stable) { group.append(chip("fight-stable", t("activity.fight.stable"))); return group; }
  for (const [kind, count] of [["success", saves.successes], ["failure", saves.failures]]) {
    const row = document.createElement("span");
    row.className = `save-row save-${kind}`;
    for (let index = 0; index < 3; index += 1) row.append(Object.assign(document.createElement("i"), { className: index < count ? "is-filled" : "" }));
    group.append(row);
  }
  return group;
}

// The line of small marks under a creature's health: concentration, death saves, then conditions and lasting spells. Null when there is nothing to show.
export function fightTags(entry) {
  const marks = [];
  if (entry.deathSaves) marks.push(savePips(entry.deathSaves));
  if (entry.concentration) {
    const held = chip("fight-concentration", `◎ ${entry.concentration}`, t("activity.fight.concentrating", { spell: entry.concentration }));
    held.tabIndex = 0;
    held.setAttribute("role", "button");
    held.addEventListener("click", (event) => { event.stopPropagation(); openRules("concentration"); });
    marks.push(held);
  }
  for (const status of entry.statuses ?? []) marks.push(chip("fight-status", status));
  if (marks.length === 0) return null;
  const line = document.createElement("span");
  line.className = "fight-tags";
  line.append(...marks);
  return line;
}

// Turn order across the top of the fight, starting with whoever is up. Downed creatures are dimmed.
export function turnOrderBar(snapshot) {
  const order = snapshot?.order ?? [];
  if (order.length === 0) return null;
  const bar = document.createElement("ol");
  bar.className = "turn-order";
  bar.setAttribute("aria-label", t("activity.fight.order"));
  bar.append(Object.assign(document.createElement("li"), { className: "turn-order-round", textContent: t("activity.fight.round", { round: snapshot.roundNumber ?? 1 }) }));
  for (const entry of order) {
    const item = document.createElement("li");
    item.className = `turn-order-item side-${entry.side}${entry.active ? " is-active" : ""}${entry.down ? " is-down" : ""}`;
    item.textContent = entry.name;
    item.title = entry.name;
    if (entry.active) item.setAttribute("aria-current", "true");
    bar.append(item);
  }
  return bar;
}

// Your own turn: what is left of the action, bonus action, reaction and movement, and who you are in melee with. Display only; the buttons below are already the legal ones.
export function turnStrip(turn) {
  if (turn === null || turn === undefined || turn.budget === undefined) return null;
  const budget = turn.budget;
  const strip = document.createElement("div");
  strip.className = "turn-strip";
  strip.setAttribute("aria-label", t("activity.fight.yourTurn"));
  const pip = (key, left) => chip(`turn-pip${left ? "" : " is-spent"}`, t(`activity.fight.${key}`), `${t(`activity.fight.${key}`)} · ${t(left ? "activity.fight.available" : "activity.fight.used")}`);
  strip.append(pip("action", budget.action), pip("bonusAction", budget.bonusAction), pip("reaction", budget.reaction), chip("turn-pip", t("activity.fight.movement", { feet: budget.movement })));
  if (budget.attacksLeft > 1) strip.append(chip("turn-pip", t("activity.fight.attacksLeft", { count: budget.attacksLeft })));
  if (turn.engagedWith.length > 0) strip.append(Object.assign(document.createElement("span"), { className: "turn-melee", textContent: t("activity.fight.engaged", { names: turn.engagedWith.join(", ") }) }));
  return strip;
}
