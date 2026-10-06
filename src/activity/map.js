import { app } from "./state.js";
import { performAction } from "./actions.js";
import { artIconPrefix, liveMap, svgElement } from "./dom.js";
import { t } from "./i18n.js";
import { enemyRankIcon } from "./party.js";

// One entry of a map key: its colour swatch and its label.
export function keyItem(swatchClass, label) {
  const item = document.createElement("span");
  const swatch = document.createElement("i");
  swatch.className = swatchClass;
  item.append(swatch, ` ${label}`);
  return item;
}


// Wide characters (Chinese) take about twice the room of Latin ones, so a name's box is sized from its letters.
export function labelWidth(text, size = 13) {
  return [...text].reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? size * 1.05 : size * .56), 0);
}


export function clipLabel(text, size, limit) {
  if (labelWidth(text, size) <= limit) return text;
  let shown = "";
  for (const character of text) {
    if (labelWidth(`${shown}${character}…`, size) > limit) break;
    shown += character;
  }
  return `${shown}…`;
}


// Where a line from one box's centre toward another leaves the first box's edge.
export function edgePoint(from, toward, halfWidth, halfHeight) {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (dx === 0 && dy === 0) return { ...from };
  const scale = Math.min(dx === 0 ? Infinity : halfWidth / Math.abs(dx), dy === 0 ? Infinity : halfHeight / Math.abs(dy));
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}


export function setMapPick(on) {
  app.mapPick = on;
  if (app.currentSnapshot?.kind === "table") renderMap(app.currentSnapshot.map, app.currentSnapshot.mapText);
}


export function updateMapGo(targetCount) {
  if (targetCount === 0) app.mapPick = false;
  const button = document.querySelector("#map-go");
  const hint = document.querySelector("#map-go-hint");
  button.hidden = targetCount === 0;
  document.querySelector("#map-toolbar").hidden = targetCount === 0;
  button.textContent = t(app.mapPick ? "activity.map.goCancel" : "activity.map.go");
  button.setAttribute("aria-pressed", String(app.mapPick));
  hint.hidden = !app.mapPick;
  hint.textContent = t("activity.map.goHint");
}


export function renderMap(map, words) {
  liveMap.replaceChildren();
  const mapPanel = document.querySelector(".adventure-map-panel");
  const mapKind = map.kind === "battlefield" ? "battlefield" : "journey";
  if (mapPanel.dataset.mapKind !== mapKind) {
    mapPanel.open = true;
    mapPanel.dataset.mapKind = mapKind;
    app.mapPick = false;
  }
  if (map.kind === "battlefield") {
    document.querySelector("#live-map-kind").textContent = words.tacticalKind;
    document.querySelector("#live-map-title").textContent = words.battlefield;
    document.querySelector(".map-key").replaceChildren(keyItem("party-key", words.keyParty), keyItem("foe-key", words.keyFoes));
    updateMapGo(map.zones.filter((zone) => zone.canMove).length);
    const svg = renderBattlefieldMap(map, words);
    liveMap.append(svg);
    prepareMapView("battlefield", svg);
    return;
  }
  document.querySelector("#live-map-kind").textContent = words.journeyKind;
  document.querySelector("#live-map-title").textContent = words.journeyTitle;
  document.querySelector(".map-key").replaceChildren(keyItem("current-key", words.keyHere), keyItem("visited-key", words.visited), keyItem("reachable-key", words.keyOpen), keyItem("locked-key", words.keyLocked));
  updateMapGo(map.nodes.filter((node) => node.canTravel).length);
  if (map.nodes.length === 0) { liveMap.textContent = words.empty; return; }
  const svg = renderJourneyMap(map, words);
  liveMap.append(svg);
  prepareMapView("journey", svg);
}


export function renderJourneyMap(map, words) {
  const svg = svgElement("svg", { role: "group", "aria-label": words.routeLabel });
  svg.classList.add("route-map-svg");
  const subtitleOf = (node) => node.status === "current" ? words.here : node.deadEnd ? words.deadEnd : node.status === "visited" ? words.visited : node.status === "locked" ? words.locked : node.status === "known" ? words.mapped : words.openRoute;
  const boxHeight = 54;
  const widths = new Map(map.nodes.map((node) => [node.id, Math.max(132, Math.min(240, 44 + labelWidth(node.title)))]));
  const widest = Math.max(...widths.values());
  const columns = new Map();
  for (const node of map.nodes) { if (!columns.has(node.column)) columns.set(node.column, []); columns.get(node.column).push(node); }
  const maxColumn = Math.max(...columns.keys());
  const maxRows = Math.max(...[...columns.values()].map((nodes) => nodes.length));
  const columnStep = widest + 70;
  const rowStep = boxHeight + 34;
  const positions = new Map();
  for (const node of map.nodes) {
    const rowsInColumn = columns.get(node.column).length;
    positions.set(node.id, { x: 32 + widest / 2 + node.column * columnStep, y: 32 + boxHeight / 2 + node.row * rowStep + ((maxRows - rowsInColumn) * rowStep) / 2 });
  }
  const width = 64 + widest + maxColumn * columnStep;
  const height = 64 + boxHeight + (maxRows - 1) * rowStep;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const defs = svgElement("defs");
  const marker = svgElement("marker", { id: "route-arrow", markerWidth: 9, markerHeight: 9, refX: 8, refY: 4.5, orient: "auto", markerUnits: "userSpaceOnUse" });
  marker.append(svgElement("path", { d: "M0,0 L9,4.5 L0,9 z", class: "jr-arrow" }));
  defs.append(marker);
  svg.append(defs);
  for (const route of map.routes) {
    const from = positions.get(route.from);
    const to = positions.get(route.to);
    if (!from || !to) continue;
    const start = edgePoint(from, to, widths.get(route.from) / 2, boxHeight / 2);
    const end = edgePoint(to, from, widths.get(route.to) / 2, boxHeight / 2);
    // A way that can be walked back is a plain line; only a one-way route has a direction.
    const line = svgElement("line", { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: route.oneWay ? "jr-line one-way" : "jr-line" });
    if (route.oneWay) line.setAttribute("marker-end", "url(#route-arrow)");
    svg.append(line);
  }
  for (const node of map.nodes) {
    const point = positions.get(node.id);
    const boxWidth = widths.get(node.id);
    const pickable = app.mapPick && node.canTravel === true;
    const group = svgElement("g", { class: `jr-node ${node.status}${app.currentSnapshot?.pendingMove?.sceneId === node.id ? " is-heading" : ""}${pickable ? " is-target" : ""}${app.mapPick && !pickable && node.status !== "current" ? " is-dim" : ""}` });
    if (pickable) {
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `${node.title}. ${words.moveHere}`);
      const go = () => { app.mapPick = false; void performAction({ kind: "moveScene", sceneId: node.id }); };
      group.addEventListener("click", go);
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } });
    }
    group.append(
      svgElement("rect", { x: point.x - boxWidth / 2, y: point.y - boxHeight / 2, width: boxWidth, height: boxHeight, rx: 9 }),
      svgElement("circle", { cx: point.x - boxWidth / 2 + 15, cy: point.y, r: 5, class: "jr-dot" }),
      svgElement("text", { x: point.x + 7, y: point.y - 3, "text-anchor": "middle", class: "jr-title" }, node.title),
      svgElement("text", { x: point.x + 7, y: point.y + 14, "text-anchor": "middle", class: "jr-sub" }, pickable ? words.moveHere : subtitleOf(node)),
    );
    svg.append(group);
  }
  return svg;
}


export function renderBattlefieldMap(map, words) {
  const svg = svgElement("svg", { role: "group", "aria-label": words.battlefield });
  svg.classList.add("battlefield-map-svg");
  const zoneWidth = 188;
  const zoneHeight = 116;
  const perRow = 4;
  const stepX = zoneWidth + 56;
  const stepY = zoneHeight + 52;
  const columnsUsed = Math.min(perRow, map.zones.length);
  const rows = Math.ceil(map.zones.length / perRow);
  const positions = new Map(map.zones.map((zone, index) => [zone.id, { x: 32 + zoneWidth / 2 + (index % perRow) * stepX, y: 32 + zoneHeight / 2 + Math.floor(index / perRow) * stepY }]));
  const width = 64 + zoneWidth + (columnsUsed - 1) * stepX;
  const height = 64 + zoneHeight + (rows - 1) * stepY;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  for (const edge of map.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const start = edgePoint(from, to, zoneWidth / 2, zoneHeight / 2);
    const end = edgePoint(to, from, zoneWidth / 2, zoneHeight / 2);
    svg.append(svgElement("line", { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: "bf-edge" }));
    const label = `${edge.feet} ft`;
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const pill = labelWidth(label, 11) + 14;
    svg.append(svgElement("rect", { x: middle.x - pill / 2, y: middle.y - 10, width: pill, height: 20, rx: 10, class: "bf-distance-bg" }), svgElement("text", { x: middle.x, y: middle.y + 4, class: "bf-distance" }, label));
  }
  for (const zone of map.zones) {
    const point = positions.get(zone.id);
    const hasFoe = zone.occupants.some((occupant) => occupant.side === "foes");
    const active = zone.occupants.some((occupant) => occupant.active);
    const pickable = app.mapPick && zone.canMove === true;
    const group = svgElement("g", { class: `bf-zone${active ? " has-active" : ""}${hasFoe ? " has-foe" : ""}${pickable ? " is-target" : ""}${app.mapPick && !pickable && !active ? " is-dim" : ""}` });
    group.setAttribute("aria-label", `${zone.name}${zone.occupants.length ? `: ${zone.occupants.map((occupant) => occupant.name).join(", ")}` : ""}`);
    if (pickable) {
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `${zone.name}. ${words.moveHere}`);
      const go = () => { app.mapPick = false; void performAction({ kind: "move", zoneId: zone.id }); };
      group.addEventListener("click", go);
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } });
    }
    const left = point.x - zoneWidth / 2;
    const top = point.y - zoneHeight / 2;
    group.append(svgElement("rect", { x: left, y: top, width: zoneWidth, height: zoneHeight, rx: 14, class: "bf-area" }));
    group.append(svgElement("text", { x: point.x, y: top + 24, class: "bf-title" }, clipLabel(zone.name, 14, zoneWidth - 20)));
    const terrain = [zone.lighting ? { bright: words.lightBright, dim: words.lightDim, dark: words.lightDark }[zone.lighting] : "", zone.cover ? { half: words.coverHalf, "three-quarters": words.coverThreeQuarters }[zone.cover] : "", zone.difficult ? words.difficult : ""].filter(Boolean).join(" · ") || words.openGround;
    group.append(svgElement("text", { x: point.x, y: top + 41, class: "bf-terrain" }, clipLabel(terrain, 11, zoneWidth - 20)));
    const shown = zone.occupants.slice(0, 4);
    const tokenStep = 38;
    shown.forEach((occupant, index) => {
      const cx = point.x + (index - (shown.length - 1) / 2) * tokenStep;
      const token = svgElement("g", { class: `bf-token ${occupant.side === "foes" ? "foe" : "party"}${occupant.active ? " is-active" : ""}` });
      const rank = occupant.side === "foes" ? occupant.rank ?? "standard" : "party";
      token.classList.add(`rank-${rank}`);
      token.setAttribute("aria-label", `${occupant.name}${occupant.side === "foes" ? ` · ${t(`activity.enemyRank.${rank}`)}` : ""}`);
      token.append(svgElement("circle", { cx, cy: top + 70, r: 16 }));
      if (occupant.side === "foes") {
        token.append(svgElement("image", { x: cx - 10, y: top + 60, width: 20, height: 20, href: `${artIconPrefix}/${enemyRankIcon(rank)}.svg`, class: "bf-enemy-icon" }));
      } else token.append(svgElement("text", { x: cx, y: top + 75, class: "bf-initial" }, [...occupant.name][0]?.toLocaleUpperCase() ?? "?"));
      group.append(token);
    });
    if (zone.occupants.length > shown.length) group.append(svgElement("text", { x: left + zoneWidth - 14, y: top + 75, class: "bf-more", "text-anchor": "end" }, `+${zone.occupants.length - shown.length}`));
    const footer = pickable ? words.moveHere : zone.occupants.map((occupant) => occupant.name).join(", ");
    if (footer) group.append(svgElement("text", { x: point.x, y: top + 105, class: pickable ? "bf-go" : "bf-names" }, clipLabel(footer, 10, zoneWidth - 20)));
    svg.append(group);
  }
  return svg;
}


export function prepareMapView(kind, svg) {
  if (!svg) return;
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const nextIdentity = `${app.currentGameId ?? "preview"}:${kind}`;
  if (app.mapIdentity !== nextIdentity) {
    app.mapIdentity = nextIdentity;
    app.mapBaseSize = { width, height };
    app.mapScale = 1;
    app.mapOffset = { x: 0, y: 0 };
    requestAnimationFrame(() => fitMap());
  } else {
    app.mapBaseSize = { width, height };
    requestAnimationFrame(() => applyMapScale());
  }
}


export function applyMapScale(focal = null, previousScale = app.mapScale) {
  const svg = liveMap.querySelector("svg");
  const viewport = document.querySelector("#live-map-viewport");
  if (!svg || !app.mapBaseSize) return;
  const center = focal ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  // The SVG is rebuilt from base dimensions on each live refresh; app.mapScale is
  // therefore the currently displayed scale even when its fresh attributes are 1x.
  const mapX = (center.x - app.mapOffset.x) / previousScale;
  const mapY = (center.y - app.mapOffset.y) / previousScale;
  const ratioX = app.mapBaseSize.width ? mapX / app.mapBaseSize.width : .5;
  const ratioY = app.mapBaseSize.height ? mapY / app.mapBaseSize.height : .5;
  svg.setAttribute("width", String(Math.round(app.mapBaseSize.width * app.mapScale)));
  svg.setAttribute("height", String(Math.round(app.mapBaseSize.height * app.mapScale)));
  svg.style.width = `${Math.round(app.mapBaseSize.width * app.mapScale)}px`;
  svg.style.height = `${Math.round(app.mapBaseSize.height * app.mapScale)}px`;
  requestAnimationFrame(() => {
    app.mapOffset.x = center.x - ratioX * svg.clientWidth;
    app.mapOffset.y = center.y - ratioY * svg.clientHeight;
    applyMapOffset();
  });
}


export function applyMapOffset() {
  const svg = liveMap.querySelector("svg");
  if (!svg) return;
  const viewport = document.querySelector("#live-map-viewport");
  // A map smaller than the window sits in the middle of it; a larger one can be dragged but not off its edges.
  const spareX = viewport.clientWidth - svg.clientWidth;
  const spareY = viewport.clientHeight - svg.clientHeight;
  app.mapOffset.x = spareX >= 0 ? spareX / 2 : Math.max(spareX, Math.min(0, app.mapOffset.x));
  app.mapOffset.y = spareY >= 0 ? spareY / 2 : Math.max(spareY, Math.min(0, app.mapOffset.y));
  svg.style.transform = `translate(${app.mapOffset.x}px, ${app.mapOffset.y}px)`;
}


export function zoomMap(delta, focal = null) {
  const previousScale = app.mapScale;
  app.mapScale = Math.max(.35, Math.min(2.5, Math.round((app.mapScale + delta) * 100) / 100));
  applyMapScale(focal, previousScale);
}


export function fitMap() {
  if (!app.mapBaseSize) return;
  const viewport = document.querySelector("#live-map-viewport");
  const previousScale = app.mapScale;
  app.mapScale = Math.min(2.2, (viewport.clientWidth - 24) / app.mapBaseSize.width, (viewport.clientHeight - 24) / app.mapBaseSize.height);
  app.mapScale = Math.max(.2, app.mapScale);
  app.mapOffset = { x: 0, y: 0 };
  applyMapScale({ x: 0, y: 0 }, previousScale);
}


// The map can always be zoomed (wheel or pinch) and dragged; a double click fits it to the window again.
export const mapPointers = new Map();

export function bindMapControls() {
  const viewport = document.querySelector("#live-map-viewport");
  document.querySelector("#map-go").addEventListener("click", () => setMapPick(!app.mapPick));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && app.mapPick) setMapPick(false); });
  // The map always fits its window to begin with, so it is refitted whenever the window changes size.
  new ResizeObserver(() => { if (app.mapBaseSize) fitMap(); }).observe(viewport);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoomMap(event.deltaY < 0 ? .12 : -.12, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  viewport.addEventListener("dblclick", fitMap);
  viewport.addEventListener("pointerdown", (event) => {
    app.suppressMapClick = false;
    mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (mapPointers.size === 2) {
      const points = [...mapPointers.values()];
      app.pinchStart = { distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), scale: app.mapScale };
      app.mapDrag = null;
      return;
    }
    if (event.button !== 0) return;
    app.mapDrag = { x: event.clientX, y: event.clientY, left: app.mapOffset.x, top: app.mapOffset.y, moved: false };
  });
  // Listening on the window (not capturing the pointer) keeps a plain click reaching the place that was clicked.
  window.addEventListener("pointermove", (event) => {
    if (!mapPointers.has(event.pointerId)) return;
    mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (mapPointers.size >= 2 && app.pinchStart) {
      const points = [...mapPointers.values()];
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (app.pinchStart.distance > 0 && distance > 0) {
        const previousScale = app.mapScale;
        app.mapScale = Math.max(.35, Math.min(2.5, app.pinchStart.scale * distance / app.pinchStart.distance));
        const rect = viewport.getBoundingClientRect();
        applyMapScale({ x: (points[0].x + points[1].x) / 2 - rect.left, y: (points[0].y + points[1].y) / 2 - rect.top }, previousScale);
      }
      return;
    }
    if (!app.mapDrag) return;
    const dx = event.clientX - app.mapDrag.x;
    const dy = event.clientY - app.mapDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) app.mapDrag.moved = true;
    if (app.mapDrag.moved) { app.mapOffset.x = app.mapDrag.left + dx; app.mapOffset.y = app.mapDrag.top + dy; applyMapOffset(); }
  });
  const finishPointer = (event) => {
    if (app.mapDrag?.moved) app.suppressMapClick = true;
    mapPointers.delete(event.pointerId);
    if (mapPointers.size < 2) app.pinchStart = null;
    app.mapDrag = null;
  };
  window.addEventListener("pointerup", finishPointer);
  window.addEventListener("pointercancel", finishPointer);
  // A drag that ends over a place is not a click on it.
  viewport.addEventListener("click", (event) => {
    if (!app.suppressMapClick) return;
    app.suppressMapClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

