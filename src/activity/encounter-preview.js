import { app } from "./state.js";
import { setArtwork, svgElement } from "./dom.js";
import { fightTags } from "./fight-status.js";

// A zone board: placement inside an area is illustrative, not a movement grid.
export function encounterPreview(game, select) {
  const board = document.createElement("div");
  board.className = "encounter-board";
  const zones = game.map.zones;
  const positions = new Map(zones.map((zone, index) => [zone.id, { x: (index + .5) * 1000 / zones.length, y: index % 2 ? 475 : 190 }]));
  const paths = svgElement("svg", { viewBox: "0 0 1000 800", preserveAspectRatio: "none", class: "encounter-paths", "aria-label": "Routes between combat areas" });
  for (const edge of game.map.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    paths.append(svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: "encounter-path-stone" }));
    paths.append(svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: "encounter-path-line" }));
    const middleX = (from.x + to.x) / 2;
    const x = middleX + (middleX < 500 ? 55 : -55);
    const y = (from.y + to.y) / 2;
    paths.append(svgElement("rect", { x: x - 35, y: y - 15, width: 70, height: 30, rx: 15, class: "encounter-path-label" }));
    paths.append(svgElement("text", { x, y: y + 5, "text-anchor": "middle" }, `${edge.feet} ft`));
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
    area.style.setProperty("--area-left", `${zoneIndex * 100 / zones.length + 1}%`);
    area.style.setProperty("--area-width", `${100 / zones.length - 2}%`);
    area.style.setProperty("--area-top", zoneIndex % 2 ? "47%" : "4%");
    const title = document.createElement("h3");
    title.textContent = zone.name;
    const terrain = document.createElement("p");
    terrain.className = "encounter-terrain";
    terrain.textContent = [zone.lighting, zone.cover ? `${zone.cover === "half" ? "Half" : "Three-quarters"} cover` : "Open ground", zone.difficult ? "Difficult terrain" : null].filter(Boolean).join(" · ");
    area.append(title, terrain);
    const tokens = document.createElement("div");
    tokens.className = "encounter-tokens";
    for (const entry of roster.filter((creature) => creature.zone === zone.name)) {
      const active = game.order.some((turn) => turn.name === entry.name && turn.active);
      const selected = entry.side === "foes" ? app.selectedEnemyName === entry.name : !app.selectedEnemyName && entry.characterId === app.selectedPartyCharacterId;
      const token = document.createElement("div");
      token.className = `encounter-token side-${entry.side}${active ? " is-active" : ""}${selected ? " is-selected" : ""}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "encounter-token-select";
      button.setAttribute("aria-label", `${entry.name}, ${entry.hp} / ${entry.maxHp} HP, at ${zone.name}`);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => select(entry));
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
      hp.textContent = `${entry.hp} / ${entry.maxHp} HP${entry.armorClass ? ` · AC ${entry.armorClass}` : ""}`;
      const bar = document.createElement("span");
      bar.className = "encounter-hp";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, entry.maxHp ? entry.hp / entry.maxHp * 100 : 0))}%`;
      bar.append(fill);
      copy.append(name, hp, bar);
      button.append(sigil, copy);
      token.append(button);
      const tags = fightTags(entry);
      if (tags) token.append(tags);
      if (entry.ownerName) token.title = `Summoned by ${entry.ownerName}`;
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
  note.textContent = "Creatures inside the same boundary share an area. Paths show travel distance; marker spacing is illustrative.";
  board.append(note);
  return board;
}
