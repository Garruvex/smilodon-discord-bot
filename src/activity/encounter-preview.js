import { app } from "./state.js";
import { t } from "./i18n.js";
import { setArtwork, svgElement } from "./dom.js";
import { fightTags } from "./fight-status.js";
import { creatureKey, creatureOptions, menuElement, menuIsOpen, toggleMenu, zoneKey, zoneOptions } from "./board-actions.js";

// A zone board: placement inside an area is illustrative, not a movement grid.
export function encounterPreview(game, select) {
  const board = document.createElement("div");
  board.className = "encounter-board";
  const zones = game.map.zones;
  // Up to three areas stand side by side like a stage; more zigzag over two rows.
  const row = zones.length <= 3;
  board.dataset.layout = row ? "row" : "grid";
  const positions = new Map(zones.map((zone, index) => [zone.id, { x: (index + .5) * 1000 / zones.length, y: row ? 205 : index % 2 ? 475 : 190 }]));
  const paths = svgElement("svg", { viewBox: row ? "0 0 1000 440" : "0 0 1000 800", preserveAspectRatio: "none", class: "encounter-paths", "aria-label": t("activity.board.routes") });
  for (const edge of game.map.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    // Side by side, the areas touch and the distance is a pill on the border between them; the zigzag draws its routes.
    if (!row) {
      paths.append(svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: "encounter-path-stone" }));
      paths.append(svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: "encounter-path-line" }));
    }
    const middleX = (from.x + to.x) / 2;
    const x = row ? middleX : middleX + (middleX < 500 ? 55 : -55);
    const y = (from.y + to.y) / 2;
    // Between side-by-side rooms the distance is a dashed doorway across the gap, with the feet written above it.
    if (row) paths.append(svgElement("line", { x1: x - 24, y1: y, x2: x + 24, y2: y, class: "encounter-doorway" }));
    else paths.append(svgElement("rect", { x: x - 35, y: y - 15, width: 70, height: 30, rx: 15, class: "encounter-path-label" }));
    paths.append(svgElement("text", { x, y: row ? y - 8 : y + 5, "text-anchor": "middle" }, `${edge.feet} ft`));
  }
  board.append(paths);
  const roster = [
    ...game.party.map((entry) => ({ ...entry, side: "party" })),
    ...game.foes.map((entry) => ({ ...entry, side: "foes" })),
    ...game.allies.map((entry) => ({ ...entry, side: "allies" })),
  ];
  for (const [zoneIndex, zone] of zones.entries()) {
    const area = document.createElement("section");
    area.className = `encounter-area${zone.difficult ? " is-flooded" : ""}`;
    area.dataset.zone = zone.id;
    const moves = zoneOptions(game, zone);
    if (moves.length > 0) {
      area.classList.add("is-movable");
      area.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest(".encounter-token, .token-menu")) return;
        const wasOpen = menuIsOpen(zoneKey(zone));
        document.querySelectorAll(".token-menu").forEach((menu) => menu.remove());
        toggleMenu(zoneKey(zone));
        const menu = wasOpen ? null : menuElement(zoneKey(zone), moves, zone.name);
        if (menu) { area.append(menu); area.classList.add("has-menu"); }
      });
    }
    area.style.setProperty("--area-left", `${zoneIndex * 100 / zones.length + (row ? 3 : 1)}%`);
    area.style.setProperty("--area-width", `${100 / zones.length - (row ? 6 : 2)}%`);
    area.style.setProperty("--area-top", row ? (zoneIndex % 2 ? "15%" : "3%") : zoneIndex % 2 ? "47%" : "4%");
    const title = document.createElement("h3");
    title.textContent = zone.name;
    const terrain = document.createElement("p");
    terrain.className = "encounter-terrain";
    // Each fact about the room is its own small tag, so the line reads at a glance.
    const words = game.mapText ?? {};
    for (const [text, kind] of [[zone.lighting ? { bright: words.lightBright, dim: words.lightDim, dark: words.lightDark }[zone.lighting] ?? zone.lighting : null, "light"], [zone.cover ? { half: words.coverHalf, "three-quarters": words.coverThreeQuarters }[zone.cover] : words.openGround, "cover"], [zone.difficult ? words.difficult : null, "difficult"]]) {
      if (text) terrain.append(Object.assign(document.createElement("span"), { className: `terrain-tag is-${kind}`, textContent: text }));
    }
    area.append(title, terrain);
    const tokens = document.createElement("div");
    tokens.className = "encounter-tokens";
    for (const entry of roster.filter((creature) => creature.zone === zone.name)) {
      const active = game.order.some((turn) => turn.name === entry.name && turn.active);
      const selected = entry.side === "foes" ? app.selectedEnemyName === entry.name : !app.selectedEnemyName && entry.characterId === app.selectedPartyCharacterId;
      const token = document.createElement("div");
      token.className = `encounter-token side-${entry.side}${active ? " is-active" : ""}${selected ? " is-selected" : ""}`;
      token.dataset.creature = entry.name;
      const down = entry.down === true || entry.fallen === true;
      if (down) { token.classList.add("is-down"); token.classList.toggle("is-dead", entry.fallen === true); token.dataset.state = t("activity.board.down"); }
      if (entry.isYou) token.classList.add("is-you");
      token.dataset.area = zone.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "encounter-token-select";
      button.setAttribute("aria-label", t("activity.board.tokenLabel", { name: entry.name, hp: entry.hp, max: entry.maxHp, zone: zone.name }));
      button.title = `${entry.name} · ${entry.hp} / ${entry.maxHp} HP`;
      button.setAttribute("aria-pressed", String(selected));
      const options = creatureOptions(game, entry);
      if (options.length > 0) { token.classList.add("has-options"); token.dataset.act = t("activity.board.act"); }
      button.addEventListener("click", () => { toggleMenu(creatureKey(entry)); select(entry); });
      const sigil = document.createElement("span");
      sigil.className = "encounter-token-portrait";
      const fallback = document.createElement("span");
      fallback.textContent = entry.side === "foes" ? "☠" : entry.side === "allies" ? "✦" : [...entry.name][0];
      fallback.setAttribute("aria-hidden", "true");
      const image = document.createElement("img");
      image.alt = "";
      sigil.append(fallback, image);
      void setArtwork(image, fallback, entry.imageUrl, "");
      const copy = document.createElement("span");
      copy.className = "encounter-token-copy";
      const name = document.createElement("strong");
      name.textContent = entry.name;
      const hp = document.createElement("small");
      hp.textContent = `${entry.hp} / ${entry.maxHp} HP`;
      // Who the creature is to you: yourself, a boss or minion, or whose summon it is.
      const role = entry.isYou ? t("activity.board.you") : entry.side === "foes" && entry.rank && entry.rank !== "standard" ? t(`activity.board.${entry.rank}`) : entry.ownerName ? t("activity.board.ownedBy", { name: entry.ownerName }) : "";
      const roleLine = Object.assign(document.createElement("em"), { className: "token-role", textContent: role });
      if (!role) roleLine.hidden = true;
      if (entry.armorClass) {
        const armor = Object.assign(document.createElement("span"), { className: "token-ac", textContent: String(entry.armorClass), title: `AC ${entry.armorClass}` });
        armor.setAttribute("aria-hidden", "true");
        token.append(armor);
      }
      const bar = document.createElement("span");
      bar.className = "encounter-hp";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, entry.maxHp ? entry.hp / entry.maxHp * 100 : 0))}%`;
      bar.append(fill, Object.assign(document.createElement("b"), { textContent: `${entry.hp} / ${entry.maxHp}` }));
      bar.classList.toggle("is-low", entry.maxHp > 0 && entry.hp / entry.maxHp <= 0.25);
      sigil.append(bar);
      copy.append(name, roleLine, hp);
      button.append(sigil, copy);
      token.append(button);
      const tags = fightTags(entry);
      if (tags) token.append(tags);
      const details = document.createElement("div");
      details.className = "token-stats";
      details.append(Object.assign(document.createElement("strong"), { textContent: entry.name }));
      if (role) details.append(Object.assign(document.createElement("em"), { textContent: role }));
      details.append(Object.assign(document.createElement("span"), { textContent: `${entry.hp} / ${entry.maxHp} HP${entry.armorClass ? ` · AC ${entry.armorClass}` : ""}` }));
      const chips = fightTags(entry);
      if (chips) details.append(chips);
      const menu = menuElement(creatureKey(entry), options, entry.name, details);
      if (menu) { token.append(menu); area.classList.add("has-menu"); }
      if (entry.ownerName) token.title = t("activity.board.summonedBy", { name: entry.ownerName });
      tokens.append(token);
    }
    area.append(tokens);
    const routes = document.createElement("div");
    routes.className = "encounter-routes";
    for (const edge of game.map.edges.filter((link) => link.from === zone.id || link.to === zone.id)) {
      const destination = game.map.zones.find((other) => other.id === (edge.from === zone.id ? edge.to : edge.from));
      const route = document.createElement("span");
      route.textContent = `↔ ${destination?.name ?? "?"} · ${edge.feet} ft`;
      routes.append(route);
    }
    area.append(routes);
    board.append(area);
  }
  const note = document.createElement("p");
  note.className = "encounter-board-note";
  note.textContent = t("activity.board.note");
  board.append(note);
  requestAnimationFrame(fitBoards);
  return board;
}

// The board is drawn at one size and scaled to the room the screen leaves between the turn order and the hotbar, so all of it is in view at once.
export function fitBoards() {
  const small = window.matchMedia("(max-width: 700px)").matches;
  for (const board of document.querySelectorAll(".encounter-board")) {
    if (small) { board.style.zoom = ""; continue; }
    const dock = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--turn-bar-h")) || 0;
    const chain = document.querySelector(".turn-order")?.offsetHeight ?? 0;
    const natural = board.dataset.layout === "row" ? 440 : 790;
    const room = window.innerHeight - dock - chain - 100;
    // The room inside the panel's padding, so the board is centered with nothing spilling over.
    const host = board.parentElement;
    const hostStyle = host ? getComputedStyle(host) : null;
    const across = host && hostStyle ? host.clientWidth - Number.parseFloat(hostStyle.paddingLeft) - Number.parseFloat(hostStyle.paddingRight) : 1000;
    board.style.zoom = String(Math.max(.5, Math.min(across / 1000, room / natural, 1.15)));
  }
}
window.addEventListener("resize", fitBoards);

const centreOf = (token) => {
  const box = (token.querySelector(".encounter-token-portrait") ?? token).getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, top: box.top };
};

export function captureBattlefieldPositions() {
  return new Map([...document.querySelectorAll(".encounter-token")].map((token) => [token.dataset.creature, { area: token.dataset.area, rect: token.getBoundingClientRect() }]));
}

export function animateBattlefieldMovement(board, previous) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const token of board.querySelectorAll(".encounter-token")) {
    const old = previous.get(token.dataset.creature);
    if (!old || old.area === token.dataset.area) continue;
    const destination = token.getBoundingClientRect();
    // The board is drawn at a scale, and its styles hang off .encounter-board, so the flying copy rides in a stand-in board at the same scale.
    const scale = Number.parseFloat(board.style.zoom) || 1;
    const stage = document.createElement("div");
    stage.className = "encounter-board battle-move-ghost";
    stage.setAttribute("aria-hidden", "true");
    stage.inert = true;
    const ghost = token.cloneNode(true);
    ghost.querySelector(".token-menu")?.remove();
    stage.append(ghost);
    Object.assign(stage.style, { zoom: String(scale), left: `${old.rect.left / scale}px`, top: `${old.rect.top / scale}px`, width: `${old.rect.width / scale}px` });
    document.body.append(stage);
    token.style.visibility = "hidden";
    // It lifts, glides over and sets down: a short arc, a little larger in the air.
    const dx = (destination.left - old.rect.left) / scale;
    const dy = (destination.top - old.rect.top) / scale;
    const flight = stage.animate([
      { transform: "translate(0,0) scale(1)", filter: "drop-shadow(0 2px 3px #5d4a2e55)" },
      { transform: `translate(${dx * .5}px,${dy * .5 - 26}px) scale(1.12)`, filter: "drop-shadow(0 14px 10px #5d4a2e66)", offset: .5 },
      { transform: `translate(${dx}px,${dy}px) scale(1)`, filter: "drop-shadow(0 2px 3px #5d4a2e55)" },
    ], { duration: 720, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    const finish = () => { stage.remove(); token.style.visibility = ""; };
    flight.finished.then(finish, finish);
  }
}

let attackPlaying = false;
const tokenNamed = (board, name) => [...board.querySelectorAll(".encounter-token")].find((token) => token.dataset.creature === name);
export async function previewMelee(board, attackerName, targetName) {
  if (attackPlaying) return;
  const target = targetName === undefined ? board.querySelector(".encounter-token.side-foes") : tokenNamed(board, targetName);
  const area = target?.closest(".encounter-area");
  const attacker = attackerName === undefined ? area?.querySelector(".encounter-token.side-party") : tokenNamed(board, attackerName);
  if (!attacker || !target) return;
  attackPlaying = true;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const from = attacker.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const aim = centreOf(target);
  const slash = document.createElement("span");
  slash.className = "battle-melee-slash";
  slash.setAttribute("aria-hidden", "true");
  Object.assign(slash.style, { left: `${aim.x}px`, top: `${aim.y}px` });
  try {
    if (!reduced) await attacker.animate([
      { transform: "translate(0,0)" },
      { transform: `translate(${Math.sign(to.left - from.left) * 20}px,${Math.sign(to.top - from.top) * 8}px) scale(1.04)`, offset: .55 },
      { transform: "translate(0,0)" },
    ], { duration: 380, easing: "ease-in-out" }).finished;
    document.body.append(slash);
    if (!reduced) target.animate([
      { transform: "translateX(0)", filter: "brightness(1)" },
      { transform: "translateX(6px)", filter: "brightness(1.7)", offset: .25 },
      { transform: "translateX(-4px)", offset: .55 },
      { transform: "translateX(0)", filter: "brightness(1)" },
    ], { duration: 350 });
    await slash.animate(reduced ? [{ opacity: .8 }, { opacity: 0 }] : [
      { opacity: 0, transform: "translate(-50%,-50%) rotate(-35deg) scaleX(.2)" },
      { opacity: 1, transform: "translate(-50%,-50%) rotate(-35deg) scaleX(1)", offset: .25 },
      { opacity: 0, transform: "translate(-50%,-50%) rotate(-35deg) scaleX(1.3)" },
    ], { duration: 450, easing: "ease-out" }).finished;
  } finally { slash.remove(); attackPlaying = false; }
}
// A burst from the middle of the room: a soft flash, two rings of light spreading to the walls, and a few embers thrown outward.
function burst(effect) {
  const layer = (className) => effect.appendChild(Object.assign(document.createElement("i"), { className }));
  layer("burst-flash").animate([{ opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: .55, offset: .5 }, { opacity: 0 }], { duration: 900, easing: "ease-out", fill: "forwards" });
  [0, 170].forEach((delay) => layer("burst-ring").animate([
    { transform: "translate(-50%,-50%) scale(.1)", opacity: 0 },
    { opacity: 1, offset: .15 },
    { transform: "translate(-50%,-50%) scale(1)", opacity: 0 },
  ], { duration: 800, delay, easing: "cubic-bezier(.2,.7,.3,1)", fill: "both" }));
  for (let index = 0; index < 14; index += 1) {
    const angle = index / 14 * Math.PI * 2 + (index % 3) * .2;
    const reach = effect.clientWidth * (.28 + (index % 4) * .07);
    layer("burst-ember").animate([
      { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(angle) * reach}px),calc(-50% + ${Math.sin(angle) * reach * 1.15}px)) scale(.2)`, opacity: 0 },
    ], { duration: 700 + (index % 3) * 120, delay: 60 + (index % 5) * 30, easing: "ease-out", fill: "both" });
  }
}
export async function previewMagic(board, areaSpell = false, casterName, targetName) {
  if (attackPlaying) return;
  const caster = casterName === undefined ? board.querySelector('.encounter-token.side-party') : tokenNamed(board, casterName);
  const target = targetName === undefined ? board.querySelector('.encounter-token.side-foes') : tokenNamed(board, targetName);
  if (!caster || !target) return;
  attackPlaying = true;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const from = caster.getBoundingClientRect();
  const start = centreOf(caster);
  const aim = centreOf(target);
  const area = target.closest('.encounter-area');
  const to = (areaSpell ? area : target).getBoundingClientRect();
  const effect = document.createElement("span");
  effect.className = areaSpell ? "battle-spell-area" : "battle-spell-bolt";
  effect.setAttribute("aria-hidden", "true");
  effect.style.left = `${areaSpell ? to.left : start.x}px`;
  effect.style.top = `${areaSpell ? to.top : start.y}px`;
  if (areaSpell) Object.assign(effect.style, { width: `${to.width}px`, height: `${to.height}px`, borderRadius: `${(Number.parseFloat(getComputedStyle(area).borderTopLeftRadius) || 45) * (Number.parseFloat(board.style.zoom) || 1)}px` });
  document.body.append(effect);
  if (areaSpell && !reduced) burst(effect);
  try {
    await effect.animate(reduced ? [{ opacity: .6 }, { opacity: 0 }] : areaSpell ? [{ opacity: 1 }, { opacity: 1, offset: .9 }, { opacity: 0 }] : [
      { transform: "translate(0,0) scale(.4)", opacity: 0 },
      { opacity: 1, offset: .15 },
      { transform: `translate(${aim.x - start.x}px,${aim.y - start.y}px) scale(1.4)`, opacity: 1, offset: .8 },
      { transform: `translate(${aim.x - start.x}px,${aim.y - start.y}px) scale(2)`, opacity: 0 },
    ], { duration: areaSpell ? 1200 : 650, easing: "ease-out" }).finished;
    if (!reduced) for (const token of areaSpell ? area.querySelectorAll('.encounter-token') : [target]) {
      token.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.7)", offset: .25 }, { filter: "brightness(1)" }], { duration: 450 });
    }
  } finally { effect.remove(); attackPlaying = false; }
}
export async function previewAttack(board, attackerName, targetName, hit) {
  if (attackPlaying) return;
  const tokens = [...board.querySelectorAll(".encounter-token")];
  const attacker = tokens.find((token) => token.dataset.creature === attackerName);
  const target = tokens.find((token) => token.dataset.creature === targetName);
  if (!attacker || !target) return;
  attackPlaying = true;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start = centreOf(attacker);
  const aim = centreOf(target);
  const effect = document.createElement("span");
  effect.className = `battle-attack-effect${hit ? " is-hit" : " is-miss"}`;
  effect.setAttribute("role", "status");
  Object.assign(effect.style, { left: `${start.x}px`, top: `${start.y}px` });
  document.body.append(effect);
  try {
    if (!reduced) {
      effect.textContent = "✦";
      await effect.animate([
        { transform: "translate(-50%,-50%) scale(.6)", opacity: 0 },
        { opacity: 1, offset: .15 },
        { transform: `translate(calc(-50% + ${aim.x - start.x}px),calc(-50% + ${aim.y - start.y}px)) scale(1.3)`, opacity: 1 },
      ], { duration: 420, easing: "ease-in", fill: "forwards" }).finished;
      effect.getAnimations().forEach((animation) => animation.cancel());
      target.animate(hit ? [
        { transform: "translateX(0)", filter: "brightness(1)" },
        { transform: "translateX(-7px)", filter: "brightness(1.8)", offset: .2 },
        { transform: "translateX(6px)", offset: .4 },
        { transform: "translateX(-3px)", offset: .65 },
        { transform: "translateX(0)", filter: "brightness(1)" },
      ] : [
        { transform: "translateX(0)" },
        { transform: "translateX(16px) rotate(4deg)", offset: .4 },
        { transform: "translateX(0)" },
      ], { duration: 420, easing: "ease-out" });
    }
    Object.assign(effect.style, { left: `${aim.x}px`, top: `${aim.top + 8}px` });
    effect.textContent = hit ? "HIT" : "MISS";
    await effect.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [
      { transform: "translate(-50%,0) scale(1.2)", opacity: 1 },
      { transform: "translate(-50%,-38px) scale(1)", opacity: 0 },
    ], { duration: 1100, easing: "ease-out", fill: "forwards" }).finished;
  } finally { effect.remove(); attackPlaying = false; }
}

// A real attack from the story feed, played on the board: a sword swing when the two stand in one room, a flying spark when they do not, a bolt or a burst for a spell.
// Entries wait their turn, so a round of blows plays one after another; a pile-up (a tab left in the background) keeps only the latest few.
const playQueue = [];
let playing = false;
const playLimit = 4;
export function playCombatEntry(entry) {
  if (entry?.kind !== "combat" || document.hidden) return;
  playQueue.push(entry);
  if (playQueue.length > playLimit) playQueue.splice(0, playQueue.length - playLimit);
  void drain();
}
async function drain() {
  if (playing) return;
  playing = true;
  try {
    for (let entry = playQueue.shift(); entry !== undefined; entry = playQueue.shift()) await playOne(entry);
  } finally { playing = false; }
}
async function playOne(entry) {
  const board = document.querySelector("#live-enemies .encounter-board") ?? document.querySelector(".encounter-board:not(.battle-move-ghost)");
  const target = entry.targets?.[0];
  if (!board || !target || tokenNamed(board, entry.who) === undefined || tokenNamed(board, target.name) === undefined) return;
  // Healing and the like have nothing to strike.
  if (entry.targets.every((each) => each.damage === 0 && each.check === null)) return;
  const hit = entry.targets.some((each) => each.check !== "miss" && each.check !== "saved");
  const sameRoom = tokenNamed(board, entry.who).dataset.area === tokenNamed(board, target.name).dataset.area;
  while (attackPlaying) await new Promise((resolve) => setTimeout(resolve, 60));
  if (entry.source === "area" || (entry.source === "spell" && entry.targets.length > 1)) await previewMagic(board, true, entry.who, target.name);
  else if (entry.source === "spell") await previewMagic(board, false, entry.who, target.name);
  else if (sameRoom && hit) await previewMelee(board, entry.who, target.name);
  else await previewAttack(board, entry.who, target.name, hit);
}
