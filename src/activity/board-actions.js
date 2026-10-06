import { t } from "./i18n.js";
import { makeButton } from "./dom.js";
import { performAction, openActionPicker } from "./actions.js";
import { attackChoice } from "./turn-choices.js";

// Tapping a creature or an area on the battlefield board offers what your turn can do there. Every entry is one the turn already lists
// (the same attacks, spells, moves and engages as the Actions tab), so the board only shortens the way to them.
let openKey = null;

const yourTurn = (game) => game.mode === "combat" && game.yourTurn === true && game.turn && !game.turn.busy;

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}

export function creatureOptions(game, entry) {
  if (!yourTurn(game) || entry.side === "allies") return [];
  const turn = game.turn;
  const options = [];
  for (const attack of turn.attacks) {
    const target = attack.targets.find((candidate) => candidate.name === entry.name);
    if (target) options.push(attackChoice(attack, target));
  }
  for (const [spellId, entries] of groupBy(turn.spells, (spell) => spell.spellId)) {
    const target = entries.flatMap((spell) => spell.targets).find((candidate) => candidate.name === entry.name);
    if (!target) continue;
    const name = entries[0].spellName;
    const single = entries[0].affectedByTarget === undefined && entries.length === 1 && (entries[0].maxTargets ?? 1) === 1;
    options.push(single
      ? { label: t("activity.action.castOn", { spell: name, name: entry.name }), action: { kind: "combatSpell", spellId, slotLevel: entries[0].slotLevel, targetIds: [target.id] } }
      : { label: t("activity.action.castOpen", { name }), picker: { key: `spell:${spellId}`, targetId: target.id } });
  }
  const engage = turn.engage.find((candidate) => candidate.name === entry.name);
  if (engage) options.push({ label: t("activity.action.engage", { name: entry.name }), action: { kind: "engage", targetId: engage.id } });
  return options;
}

export function zoneOptions(game, zone) {
  if (!yourTurn(game)) return [];
  return game.turn.moves.filter((move) => move.zone === zone.name).map((move) => ({ label: t("activity.action.moveTo", { name: move.zone }), action: { kind: "move", zoneId: move.zoneId } }));
}

export const creatureKey = (entry) => `c:${entry.name}`;
export const zoneKey = (zone) => `z:${zone.id}`;
export const menuIsOpen = (key) => openKey === key;
export const toggleMenu = (key) => { openKey = openKey === key ? null : key; };

export function closeMenus() {
  openKey = null;
  document.querySelectorAll(".token-menu").forEach((menu) => menu.remove());
  document.querySelectorAll(".encounter-area.has-menu").forEach((area) => area.classList.remove("has-menu"));
}

// The menu for a creature or area, or null while it is closed or there is nothing to offer.
export function menuElement(key, options, label, details = null) {
  if (openKey !== key || (options.length === 0 && details === null)) return null;
  const menu = document.createElement("div");
  menu.className = "token-menu";
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", t("activity.board.menu", { name: label }));
  if (details !== null) menu.append(details);
  for (const [index, option] of options.entries()) {
    menu.append(makeButton(option.label, () => {
      closeMenus();
      if (option.picker) openActionPicker(option.picker.key, option.picker.targetId);
      else void performAction(option.action);
    }, index === 0, null));
  }
  return menu;
}

document.addEventListener("click", (event) => {
  if (openKey !== null && !(event.target instanceof Element && event.target.closest(".token-menu, .encounter-token-select, .encounter-area.is-movable"))) closeMenus();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && openKey !== null) closeMenus(); });
