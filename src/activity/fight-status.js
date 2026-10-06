import { t } from "./i18n.js";
import { openRules } from "./rules-book.js";
import { setArtwork } from "./dom.js";

let previousPreviewTurn = null;
let previousPreviewOrder = [];
let initiativeObserver = null;

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
  // A fight with a battlefield shows its turn order as portraits with health, the same as its board; otherwise it stays a plain row of names.
  const portraitPreview = snapshot?.map?.kind === "battlefield";
  if (portraitPreview) bar.classList.add("turn-order-portraits");
  const activeName = order.find((entry) => entry.active)?.name ?? null;
  const changed = previousPreviewTurn !== null && previousPreviewTurn !== activeName;
  const activeIndex = order.findIndex((entry) => entry.active);
  const displayOrder = portraitPreview && activeIndex > 0 ? [...order.slice(activeIndex), ...order.slice(0, activeIndex)] : order;
  const oldOrder = previousPreviewOrder;
  const firstRender = previousPreviewTurn === null;
  bar.setAttribute("aria-label", t("activity.fight.order"));
  for (const entry of displayOrder) {
    const item = document.createElement("li");
    item.className = `turn-order-item side-${entry.side}${entry.active ? " is-active" : ""}${entry.down || entry.fallen ? " is-down" : ""}${entry.fallen ? " is-dead" : ""}`;
    item.textContent = entry.name;
    if (portraitPreview) {
      const creature = (entry.side === "foes" ? snapshot.foes : [...snapshot.party, ...snapshot.allies]).find((actor) => actor.name === entry.name);
      const portrait = document.createElement("span");
      portrait.className = "encounter-token-portrait";
      const fallback = document.createElement("span");
      fallback.textContent = entry.side === "foes" ? "☠" : [...entry.name][0];
      fallback.setAttribute("aria-hidden", "true");
      const image = document.createElement("img");
      image.alt = "";
      portrait.append(fallback, image);
      void setArtwork(image, fallback, creature?.imageUrl, "");
      // Health runs along the bottom of the portrait.
      if (creature && creature.maxHp > 0) {
        const track = document.createElement("span");
        track.className = "turn-order-hp";
        const fill = document.createElement("i");
        fill.style.width = `${Math.max(0, Math.min(100, creature.hp / creature.maxHp * 100))}%`;
        // One color for everyone; it changes only when health is low, at a quarter or less.
        track.classList.toggle("is-low", creature.hp / creature.maxHp <= 0.25);
        track.append(fill);
        portrait.append(track);
        item.title = `${entry.name} · ${creature.hp} / ${creature.maxHp}`;
      }
      // A downed creature is grayed out by its is-down class.
      const name = document.createElement("span");
      name.className = "turn-order-name";
      name.textContent = entry.name;
      item.replaceChildren(portrait, name);
    }
    item.title ||= entry.name;
    if (entry.active) item.setAttribute("aria-current", "true");
    bar.append(item);
  }
  if (portraitPreview) {
    previousPreviewTurn = activeName;
    previousPreviewOrder = displayOrder.map((entry) => entry.name);
    requestAnimationFrame(() => {
      if (!bar.isConnected) return;
      const fade = () => {
        bar.classList.toggle("has-more-right", bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 2);
        bar.classList.toggle("has-more-left", bar.scrollLeft > 2);
      };
      bar.addEventListener("scroll", fade, { passive: true });
      initiativeObserver?.disconnect();
      initiativeObserver = new ResizeObserver(fade);
      initiativeObserver.observe(bar);
      fade();
      const active = bar.querySelector(".is-active .encounter-token-portrait");
      if ((!changed && !firstRender) || !active) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.querySelector(".initiative-turn-popup")?.remove();
      if (snapshot.party.some((hero) => hero.isYou && hero.name === activeName)) {
      const popup = document.createElement("div");
      popup.className = "initiative-turn-popup";
      popup.setAttribute("role", "status");
      popup.setAttribute("aria-live", "polite");
      popup.textContent = "YOUR TURN";
      document.body.append(popup);
      if (!reduced) popup.animate([
        { opacity: 0, transform: "translate(-50%, -50%) scale(1.55)", filter: "blur(8px)" },
        { opacity: 1, transform: "translate(-50%, -50%) scale(.97)", filter: "blur(0)", offset: .07 },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1.02)", offset: .1 },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: .14 },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: .75 },
        { opacity: 0, transform: "translate(-50%, -50%) scale(1.08)" },
      ], { duration: 3000, easing: "ease-out", fill: "forwards" });
      setTimeout(() => popup.remove(), 3000);
      }
      if (changed && !reduced) {
        const items = [...bar.children];
        const pitch = items.length > 1 ? items[1].offsetLeft - items[0].offsetLeft : 100;
        items.forEach((item, index) => {
          const oldIndex = oldOrder.indexOf(displayOrder[index].name);
          if (oldIndex < 0) return;
          const wrapped = oldIndex < index;
          item.animate(wrapped ? [
            { opacity: 0, transform: "scale(.85)" },
            { opacity: 1, transform: "scale(1)" },
          ] : [
            { transform: `translateX(${(oldIndex - index) * pitch}px)` },
            { transform: "translateX(0)" },
          ], { duration: 450, easing: "cubic-bezier(.2,.7,.2,1)" });
        });
      }
      bar.scrollTo({ left: 0, behavior: "instant" });
    });
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
