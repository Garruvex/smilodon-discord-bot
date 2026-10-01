import { DiscordSDK } from "@discord/embedded-app-sdk";

const gamesElement = document.querySelector("#lobby-games");
const messageElement = document.querySelector("#lobby-message");
const emptyElement = document.querySelector("#lobby-empty");
const errorElement = document.querySelector("#lobby-error");
const errorTitleElement = document.querySelector("#lobby-error-title");
const errorMessageElement = document.querySelector("#lobby-error-message");
const userElement = document.querySelector("#lobby-user");
const serverElement = document.querySelector("#server-label");
const lobbyScreen = document.querySelector("#lobby-screen");
const liveScreen = document.querySelector("#live-screen");
const liveActions = document.querySelector("#live-actions");
const liveParty = document.querySelector("#live-party");
const liveEnemies = document.querySelector("#live-enemies");
const liveMap = document.querySelector("#live-map");
let sessionToken = null;
let discordSdk = null;
let currentGameId = null;
let tableTimer = null;
let loadingTable = false;
let currentSnapshot = null;
let connectionStage = "Discord connection";
let discordConnected = false;
let lastRollPromptId = null;
let rollingCheck = false;
let uiLanguage = "en";
let discordLanguage = "en";
let activityStrings = {};
let selectedPartyCharacterId = null;
let selectedWorkspaceTab = "actions";
let selectedEnemyName = null;
let mapScale = 1;
let mapIdentity = "";
let mapBaseSize = null;
let mapOffset = { x: 0, y: 0 };
let mapPointers = new Map();
let mapDrag = null;
let pinchStart = null;
let suppressMapClick = false;

const lifecycleKeys = { lobby: "activity.lobby.status.open", active: "activity.lobby.status.live", paused: "activity.lobby.status.paused" };
const actionKeys = { join: "activity.lobby.action.join", continue: "activity.lobby.action.continue", request: "activity.lobby.action.request", requested: "activity.lobby.action.requested", invited: "activity.lobby.action.invited", full: "activity.lobby.action.full", resume: "activity.lobby.action.continue" };
const phaseKeys = { opening: "activity.phase.opening", readyCheck: "activity.status.gathering", collecting: "activity.phase.collecting", planning: "activity.phase.planning", awaitingRolls: "activity.phase.awaitingRolls", combat: "activity.phase.combat", waiting: "activity.phase.waiting", paused: "activity.phase.paused", safety: "activity.phase.safety", recovery: "activity.phase.recovery", archived: "activity.phase.archived" };
const apiErrorKeys = {
  activityAuthNotConfigured: "activity.connection.signInConfig", discordAuthorizationFailed: "activity.connection.discordAuthorize",
  discordIdentityFailed: "activity.connection.discordIdentity", notInLaunchGuild: "activity.connection.guildRequired",
  privateInviteOnly: "activity.error.privateInvite", full: "activity.error.full", gameFull: "activity.error.gameFull",
  heroTaken: "activity.error.heroTaken", unknownHero: "activity.error.unknownHero", notReady: "activity.error.notReady",
  notEnoughPlayers: "activity.error.notEnoughPlayers", unauthorized: "activity.connection.sessionExpired",
  notActive: "activity.error.notActive", notMember: "activity.error.notMember", joinNotAtBreak: "activity.error.joinNotAtBreak",
  joinNotApproved: "activity.error.joinNotApproved", notYourTurn: "activity.error.notYourTurn", invalidAction: "activity.status.actionAvailable",
};
const artIconPrefix = "/art-icons";

let classNames = {};

// A class as the game's language names it; an unknown class shows as written.
function classText(raw) {
  return raw ? classNames[raw.toLowerCase()] ?? raw : raw;
}

function t(key, values = {}) {
  const message = activityStrings[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (_, name) => values[name] === undefined ? `{${name}}` : String(values[name]));
}

function applyStaticTranslations() {
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  for (const element of document.querySelectorAll("[data-i18n-title]")) element.setAttribute("title", t(element.dataset.i18nTitle));
}

async function setLanguage(language) {
  const normalized = language === "zh-TW" ? "zh-TW" : "en";
  if (normalized === uiLanguage && Object.keys(activityStrings).length > 0) return;
  let response = await fetchWithTimeout(`/api/activity/i18n?language=${encodeURIComponent(normalized)}`, { cache: "no-store" });
  if (!response.ok) response = await fetchWithTimeout(`/i18n/${encodeURIComponent(normalized)}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(t("activity.connection.requestFailed"));
  activityStrings = await response.json();
  uiLanguage = normalized;
  applyStaticTranslations();
}

function languageFromDiscordLocale(locale) {
  return typeof locale === "string" && (/^zh-TW(?:$|-)/i.test(locale) || /^zh-Hant(?:$|-)/i.test(locale)) ? "zh-TW" : "en";
}

function setMessage(message) { messageElement.textContent = message; }
function setLiveMessage(message) { document.querySelector("#live-message").textContent = message; }

function withTimeout(promise, milliseconds, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function fetchWithTimeout(url, options = {}, milliseconds = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error(t("activity.connection.serverTimeout"));
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function showError(error) {
  gamesElement.replaceChildren();
  emptyElement.hidden = true;
  errorElement.hidden = false;
  errorTitleElement.textContent = connectionStage === "Discord connection"
    ? t("activity.lobby.error.connect")
    : connectionStage === "Discord authorization"
      ? t("activity.lobby.error.signIn")
      : connectionStage === "Account verification"
        ? t("activity.lobby.error.verify")
        : t("activity.lobby.error.load");
  errorMessageElement.textContent = error;
  userElement.textContent = t("activity.lobby.connectionAttention");
  serverElement.textContent = discordConnected ? t("activity.lobby.discordConnected") : t("activity.lobby.connectingDiscord");
  setMessage("");
}

function apiErrorMessage(code) { return t(apiErrorKeys[code] ?? "activity.connection.requestFailed"); }

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (sessionToken !== null) headers.set("Authorization", `Bearer ${sessionToken}`);
  const response = await fetchWithTimeout(url, { ...options, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? apiErrorMessage(payload.error) : t("activity.connection.unexpectedResponse", { status: response.status }));
  return payload;
}

const actionIcon = { attack: "attack", combatSpell: "spell", exploreSpell: "spell", healSpell: "heal", reviveSpell: "heal", useItem: "potion", combatItem: "potion", move: "move", moveScene: "move", dash: "dash", combatDodge: "dodge", withdraw: "withdraw", shield: "shield", wildShape: "shape", roll: "roll", ready: "play", begin: "play", continue: "play", details: "notice", submit: "attack", pass: "pause", shop: "coins", askNpc: "clue", feature: "shape", reaction: "shield", smite: "attack", opportunityAttack: "attack", teleport: "move", summonCompanion: "shape", acceptInvite: "play", joinHero: "play", chooseHero: "play", startLobby: "play" };
const classIcon = { wizard: "spell", sorcerer: "spell", warlock: "spell", cleric: "heal", druid: "shape", paladin: "shield", ranger: "ranged", rogue: "withdraw", fighter: "attack", barbarian: "attack", monk: "dodge", bard: "clue" };
const artworkCache = new Map();
const artworkMisses = new Map();

function iconImage(name, label = "") {
  const image = document.createElement("img");
  image.src = `${artIconPrefix}/${name}.svg`;
  image.alt = label;
  image.setAttribute("aria-hidden", label ? "false" : "true");
  return image;
}

function iconForClass(className) {
  const key = className?.toLocaleLowerCase().split(/\s+/)[0] ?? "";
  return classIcon[key] ?? "shape";
}

// A picture can be repainted under the same address (an organizer's redo), so ones that must stay current are re-checked now and then.
const artworkRecheckMs = 20000;
const artworkPending = new Set();

async function setArtwork(imageElement, fallbackElement, imageUrl, alt, revalidate = false) {
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    imageElement.removeAttribute("src");
    imageElement.dataset.source = "";
    imageElement.alt = "";
    imageElement.hidden = true;
    fallbackElement.hidden = false;
    return;
  }
  imageElement.alt = alt;
  // A picture that was not ready is asked for again after a while.
  if (Date.now() - (artworkMisses.get(imageUrl) ?? 0) < artworkRecheckMs) return;
  const changed = imageElement.dataset.source !== imageUrl;
  imageElement.dataset.source = imageUrl;
  const show = (objectUrl) => {
    if (imageElement.dataset.source !== imageUrl) return;
    if (imageElement.src !== objectUrl) imageElement.src = objectUrl;
    imageElement.hidden = false;
    fallbackElement.hidden = true;
  };
  const cached = artworkCache.get(imageUrl);
  if (cached !== undefined) {
    show(cached.objectUrl);
    if (!revalidate || Date.now() - cached.checkedAt < artworkRecheckMs) return;
  } else if (changed || imageElement.hidden) {
    imageElement.hidden = true;
    fallbackElement.hidden = false;
  }
  if (artworkPending.has(imageUrl)) return;
  artworkPending.add(imageUrl);
  try {
    const headers = { Authorization: `Bearer ${sessionToken}` };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const response = await fetchWithTimeout(imageUrl, { headers, cache: "no-store" });
    if (response.status === 304 && cached !== undefined) {
      cached.checkedAt = Date.now();
      return;
    }
    if (!response.ok) {
      if (response.status === 404) artworkMisses.set(imageUrl, Date.now());
      console.warn(`Picture could not be loaded (${response.status}).`, imageUrl);
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    artworkCache.set(imageUrl, { objectUrl, etag: response.headers.get("ETag"), checkedAt: Date.now() });
    show(objectUrl);
    if (cached !== undefined) setTimeout(() => URL.revokeObjectURL(cached.objectUrl), 2000);
  } catch {
    // Keep the class or scene illustration visible if art is not ready yet.
  } finally {
    artworkPending.delete(imageUrl);
  }
}

function makeButton(label, onClick, primary = false, iconName = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `live-action-choice${primary ? " primary" : ""}`;
  if (iconName) button.append(iconImage(iconName));
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  button.addEventListener("click", onClick);
  return button;
}

function createGameCard(game) {
  const card = document.createElement("article");
  card.className = "lobby-card";
  card.dataset.lifecycle = game.lifecycle;
  const art = document.createElement("div");
  art.className = "lobby-card-art";
  art.setAttribute("aria-hidden", "true");
  art.textContent = game.lifecycle === "active" ? "⚔" : game.lifecycle === "paused" ? "◷" : "✧";
  const copy = document.createElement("div");
  copy.className = "lobby-card-copy";
  const status = document.createElement("span");
  status.className = "lobby-card-status";
  status.textContent = t(lifecycleKeys[game.lifecycle] ?? "activity.lobby.status.campaign");
  const title = document.createElement("h3");
  title.textContent = game.name;
  const adventure = document.createElement("p");
  adventure.className = "lobby-card-adventure";
  adventure.textContent = game.adventureTitle;
  const players = document.createElement("p");
  players.className = "lobby-card-players";
  players.textContent = t("activity.lobby.players", { count: game.playerCount, max: game.maxPlayers });
  copy.append(status, title, adventure, players);
  const action = document.createElement("button");
  action.className = "lobby-card-action";
  action.type = "button";
  action.textContent = t(actionKeys[game.action] ?? "activity.lobby.action.view");
  action.disabled = game.action === "full";
  if (game.action === "requested") action.textContent = t("activity.lobby.action.withdraw");
  action.addEventListener("click", () => void selectGame(game, action));
  card.append(art, copy, action);
  return card;
}

async function loadGames() {
  errorElement.hidden = true;
  emptyElement.hidden = true;
  setMessage(t("activity.lobby.loading"));
  const payload = await requestJson("/api/activity/games");
  userElement.textContent = payload.user?.displayName ?? t("activity.lobby.connectedUser");
  gamesElement.replaceChildren(...(payload.games ?? []).map(createGameCard));
  emptyElement.hidden = (payload.games ?? []).length !== 0;
  setMessage(payload.games?.length ? t("activity.lobby.choose") : "");
}

async function selectGame(game, button) {
  if (game.action === "join" || game.action === "request" || game.action === "requested") {
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = game.action === "join" ? t("activity.lobby.action.joining") : game.action === "requested" ? t("activity.lobby.action.withdrawing") : t("activity.lobby.action.sending");
    try {
      await requestJson(`/api/activity/games/${encodeURIComponent(game.campaignId)}/${game.action === "requested" ? "withdraw" : game.action}`, { method: "POST" });
      if (game.action === "join") await openGame(game.campaignId);
      else {
        await loadGames();
        setMessage(game.action === "requested" ? t("activity.lobby.request.withdrawn") : t("activity.lobby.request.sent", { name: game.name }));
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = originalLabel;
      setMessage(error instanceof Error ? error.message : t("activity.connection.requestFailed"));
    }
    return;
  }
  if (["continue", "resume", "invited"].includes(game.action)) await openGame(game.campaignId);
  else if (game.action === "requested") setMessage(t("activity.lobby.request.waiting"));
}

async function openGame(campaignId) {
  lastRollPromptId = null;
  const diceDialog = document.querySelector("#dice-dialog");
  if (diceDialog.open) diceDialog.close();
  currentGameId = campaignId;
  lobbyScreen.hidden = true;
  liveScreen.hidden = false;
  liveActions.replaceChildren();
  setLiveMessage(t("activity.status.loadingCampaign"));
  await loadTable();
  clearInterval(tableTimer);
  tableTimer = setInterval(() => void loadTable().catch(() => {}), 5000);
}

async function loadTable() {
  if (currentGameId === null || loadingTable) return;
  loadingTable = true;
  try {
    const payload = await requestJson(`/api/activity/games/${encodeURIComponent(currentGameId)}/table`);
    currentSnapshot = payload.snapshot;
    await setLanguage(currentSnapshot.language ?? uiLanguage);
    renderGame(currentSnapshot);
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : t("activity.status.couldNotLoad"));
    if (error instanceof Error && error.message === apiErrorMessage("notActive")) {
      clearInterval(tableTimer);
      tableTimer = null;
    }
  } finally {
    loadingTable = false;
  }
}

function renderGame(game) {
  classNames = game.classNames ?? {};
  document.querySelector("#live-campaign").textContent = game.campaignName;
  document.querySelector("#live-adventure").textContent = game.adventureTitle.toLocaleUpperCase();
  document.querySelector("#live-scene-title").textContent = game.kind === "lobby" ? t("activity.scene.chooseHero") : game.scene.title;
  document.querySelector("#live-scene-description").textContent = game.kind === "lobby"
    ? t("activity.scene.chooseHeroDescription")
    : game.scene.description;
  document.querySelector(".live-scene").classList.toggle("has-enemies", game.kind === "table" && (game.foes?.length ?? 0) > 0);
  void setArtwork(document.querySelector("#live-scene-image"), document.querySelector(".scene-art-fallback"), game.kind === "table" ? game.scene.imageUrl : null, game.scene.title, true);
  if (game.kind === "lobby") {
    document.querySelector(".adventure-map-panel").hidden = true;
    renderLobby(game);
  } else {
    document.querySelector(".adventure-map-panel").hidden = false;
    renderMap(game.map, game.mapText);
    renderTable(game);
  }
}

// One entry of a map key: its colour swatch and its label.
function keyItem(swatchClass, label) {
  const item = document.createElement("span");
  const swatch = document.createElement("i");
  swatch.className = swatchClass;
  item.append(swatch, ` ${label}`);
  return item;
}

function mapFootprints(svg, from, to, padding = 40) {
  const ns = "http://www.w3.org/2000/svg";
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < padding * 2) return;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  for (let distance = padding; distance < length - padding; distance += 17) {
    const side = Math.floor(distance / 17) % 2 ? 4 : -4;
    const x = from.x + dx / length * distance - dy / length * side;
    const y = from.y + dy / length * distance + dx / length * side;
    const foot = document.createElementNS(ns, "path");
    foot.setAttribute("d", "M-4,-2 Q0,-3 4,-1 L4,1 Q0,3 -4,2 Z M-7,-2 L-5,-2 L-5,2 L-7,2 Z");
    foot.setAttribute("transform", `translate(${x} ${y}) rotate(${angle})`);
    foot.setAttribute("class", "map-footprint");
    svg.append(foot);
  }
}

function decorateMap(svg, width, height) {
  const ns = "http://www.w3.org/2000/svg";
  const scenery = document.createElementNS(ns, "g");
  scenery.setAttribute("class", "map-terrain"); scenery.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 5; i++) {
    const contour = document.createElementNS(ns, "path");
    contour.setAttribute("d", `M${width * .05},${height * .18 + i * 8} Q${width * .2},${-height * .15 + i * 13} ${width * .4},${height * .12 + i * 7} T${width * .93},${height * .22 + i * 7}`);
    scenery.append(contour);
  }
  const compass = document.createElementNS(ns, "text");
  compass.setAttribute("x", String(width - 28)); compass.setAttribute("y", String(height - 22)); compass.textContent = "✥"; compass.setAttribute("class", "map-compass"); scenery.append(compass);
  svg.append(scenery);
}

function renderMap(map, words) {
  liveMap.replaceChildren();
  const mapPanel = document.querySelector(".adventure-map-panel");
  const mapKind = map.kind === "battlefield" ? "battlefield" : "journey";
  if (mapPanel.dataset.mapKind !== mapKind) {
    mapPanel.open = true;
    mapPanel.dataset.mapKind = mapKind;
  }
  if (map.kind === "battlefield") {
    document.querySelector("#live-map-kind").textContent = words.tacticalKind;
    document.querySelector("#live-map-title").textContent = words.battlefield;
    document.querySelector(".map-key").replaceChildren(keyItem("current-key", words.keyParty), keyItem("foe-key", words.keyFoes));
    renderBattlefieldMap(map, words);
    prepareMapView("battlefield", document.querySelector(".battlefield-map-svg"));
    return;
  }
  document.querySelector("#live-map-kind").textContent = words.journeyKind;
  document.querySelector("#live-map-title").textContent = words.journeyTitle;
  document.querySelector(".map-key").replaceChildren(keyItem("current-key", words.keyHere), keyItem("reachable-key", words.keyOpen), keyItem("locked-key", words.keyLocked));
  if (map.nodes.length === 0) { liveMap.textContent = words.empty; document.querySelector("#map-toolbar").hidden = true; return; }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.classList.add("route-map-svg");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", words.routeLabel);
  const columns = new Map();
  for (const node of map.nodes) { if (!columns.has(node.column)) columns.set(node.column, []); columns.get(node.column).push(node); }
  const maxColumn = Math.max(...columns.keys());
  const maxRows = Math.max(...[...columns.values()].map((nodes) => nodes.length));
  const positions = new Map();
  for (const node of map.nodes) {
    const rowsInColumn = columns.get(node.column).length;
    positions.set(node.id, { x: 92 + node.column * 176, y: 48 + node.row * 78 + ((maxRows - rowsInColumn) * 39) });
  }
  const mapWidth = Math.max(210, 184 + maxColumn * 176);
  const mapHeight = Math.max(100, 84 + maxRows * 78);
  svg.setAttribute("viewBox", `0 0 ${mapWidth} ${mapHeight}`);
  svg.setAttribute("width", String(mapWidth)); svg.setAttribute("height", String(mapHeight));
  decorateMap(svg, mapWidth, mapHeight);
  const defs = document.createElementNS(ns, "defs");
  const marker = document.createElementNS(ns, "marker");
  marker.setAttribute("id", "route-arrow"); marker.setAttribute("markerWidth", "8"); marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "6"); marker.setAttribute("refY", "4"); marker.setAttribute("orient", "auto"); marker.setAttribute("markerUnits", "strokeWidth");
  const arrow = document.createElementNS(ns, "path"); arrow.setAttribute("d", "M0,0 L8,4 L0,8 z"); arrow.setAttribute("fill", "#9aa1a9"); marker.append(arrow); defs.append(marker); svg.append(defs);
  for (const route of map.routes) {
    const from = positions.get(route.from); const to = positions.get(route.to); if (!from || !to) continue;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(from.x + 68)); line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x - 68)); line.setAttribute("y2", String(to.y));
    line.setAttribute("class", route.oneWay ? "route-line one-way" : "route-line");
    line.setAttribute("marker-end", "url(#route-arrow)"); svg.append(line);
    mapFootprints(svg, from, to, 72);
    if (route.oneWay) {
      const bar = document.createElementNS(ns, "line");
      const middleX = (from.x + to.x) / 2; const middleY = (from.y + to.y) / 2;
      bar.setAttribute("x1", String(middleX)); bar.setAttribute("y1", String(middleY - 7));
      bar.setAttribute("x2", String(middleX)); bar.setAttribute("y2", String(middleY + 7));
      bar.setAttribute("class", "route-one-way-mark"); svg.append(bar);
    }
  }
  for (const node of map.nodes) {
    const point = positions.get(node.id); const group = document.createElementNS(ns, "g");
    group.setAttribute("class", `route-node ${node.status}`);
    if (node.canTravel) {
      group.setAttribute("role", "button"); group.setAttribute("tabindex", "0");
      group.addEventListener("click", () => void performAction({ kind: "moveScene", sceneId: node.id }));
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void performAction({ kind: "moveScene", sceneId: node.id }); } });
    }
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", String(point.x - 68)); rect.setAttribute("y", String(point.y - 23)); rect.setAttribute("width", "136"); rect.setAttribute("height", "46"); rect.setAttribute("rx", "9");
    const title = document.createElementNS(ns, "text");
    title.setAttribute("x", String(point.x)); title.setAttribute("y", String(point.y + 4)); title.setAttribute("text-anchor", "middle"); title.textContent = node.title;
    const subtitle = document.createElementNS(ns, "text");
    subtitle.setAttribute("x", String(point.x)); subtitle.setAttribute("y", String(point.y + 18)); subtitle.setAttribute("text-anchor", "middle"); subtitle.setAttribute("class", "route-subtitle");
    subtitle.textContent = node.status === "current" ? words.here : node.deadEnd ? words.deadEnd : node.status === "visited" ? words.visited : node.status === "locked" ? words.locked : node.status === "known" ? words.mapped : words.openRoute;
    group.append(rect, title, subtitle); svg.append(group);
  }
  liveMap.append(svg);
  prepareMapView("journey", svg);
}

function prepareMapView(kind, svg) {
  const toolbar = document.querySelector("#map-toolbar");
  toolbar.hidden = !svg;
  if (!svg) return;
  const viewport = document.querySelector("#live-map-viewport");
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const nextIdentity = `${currentGameId ?? "preview"}:${kind}`;
  if (mapIdentity !== nextIdentity) {
    mapIdentity = nextIdentity;
    mapBaseSize = { width, height };
    mapScale = 1;
    mapOffset = { x: 0, y: 0 };
    requestAnimationFrame(() => fitMap());
  } else {
    mapBaseSize = { width, height };
    requestAnimationFrame(() => applyMapScale());
  }
}

function applyMapScale(focal = null, previousScale = mapScale) {
  const svg = liveMap.querySelector("svg");
  const viewport = document.querySelector("#live-map-viewport");
  if (!svg || !mapBaseSize) return;
  const oldWidth = Number(svg.getAttribute("width"));
  const oldHeight = Number(svg.getAttribute("height"));
  const center = focal ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  // The SVG is rebuilt from base dimensions on each live refresh; mapScale is
  // therefore the currently displayed scale even when its fresh attributes are 1x.
  const mapX = (center.x - mapOffset.x) / previousScale;
  const mapY = (center.y - mapOffset.y) / previousScale;
  const ratioX = mapBaseSize.width ? mapX / mapBaseSize.width : .5;
  const ratioY = mapBaseSize.height ? mapY / mapBaseSize.height : .5;
  svg.setAttribute("width", String(Math.round(mapBaseSize.width * mapScale)));
  svg.setAttribute("height", String(Math.round(mapBaseSize.height * mapScale)));
  svg.style.width = `${Math.round(mapBaseSize.width * mapScale)}px`;
  svg.style.height = `${Math.round(mapBaseSize.height * mapScale)}px`;
  document.querySelector("#map-zoom-level").textContent = `${Math.round(mapScale * 100)}%`;
  requestAnimationFrame(() => {
    mapOffset.x = center.x - ratioX * svg.clientWidth;
    mapOffset.y = center.y - ratioY * svg.clientHeight;
    applyMapOffset();
  });
}

function applyMapOffset() {
  const svg = liveMap.querySelector("svg");
  if (!svg) return;
  const viewport = document.querySelector("#live-map-viewport");
  const minX = Math.min(0, viewport.clientWidth - svg.clientWidth);
  const minY = Math.min(0, viewport.clientHeight - svg.clientHeight);
  mapOffset.x = Math.max(minX, Math.min(0, mapOffset.x));
  mapOffset.y = Math.max(minY, Math.min(0, mapOffset.y));
  svg.style.transform = `translate(${mapOffset.x}px, ${mapOffset.y}px)`;
}

function zoomMap(delta, focal = null) {
  const previousScale = mapScale;
  mapScale = Math.max(.35, Math.min(2.5, Math.round((mapScale + delta) * 100) / 100));
  applyMapScale(focal, previousScale);
}

function fitMap() {
  if (!mapBaseSize) return;
  const viewport = document.querySelector("#live-map-viewport");
  const previousScale = mapScale;
  mapScale = Math.min(1, (viewport.clientWidth - 24) / mapBaseSize.width, (viewport.clientHeight - 24) / mapBaseSize.height);
  mapScale = Math.max(.2, mapScale);
  mapOffset = { x: 0, y: 0 };
  applyMapScale({ x: 0, y: 0 }, previousScale);
}

function bindMapControls() {
  const viewport = document.querySelector("#live-map-viewport");
  const toggle = document.querySelector("#map-pan-toggle");
  document.querySelector("#map-zoom-in").addEventListener("click", () => zoomMap(.2));
  document.querySelector("#map-zoom-out").addEventListener("click", () => zoomMap(-.2));
  document.querySelector("#map-fit").addEventListener("click", fitMap);
  toggle.addEventListener("click", () => {
    const enabled = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.textContent = t(enabled ? "activity.map.moving" : "activity.map.move");
    viewport.classList.toggle("is-moving", enabled);
  });
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoomMap(event.deltaY < 0 ? .12 : -.12, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  viewport.addEventListener("keydown", (event) => {
    if (event.target !== viewport) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomMap(.2); }
    else if (event.key === "-") { event.preventDefault(); zoomMap(-.2); }
    else if (event.key === "0") { event.preventDefault(); fitMap(); }
    else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const amount = event.shiftKey ? 120 : 48;
      mapOffset.x += event.key === "ArrowLeft" ? amount : event.key === "ArrowRight" ? -amount : 0;
      mapOffset.y += event.key === "ArrowUp" ? amount : event.key === "ArrowDown" ? -amount : 0;
      applyMapOffset();
    }
  });
  viewport.addEventListener("pointerdown", (event) => {
    mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (mapPointers.size === 2) {
      const points = [...mapPointers.values()];
      pinchStart = { distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), scale: mapScale };
      mapDrag = null;
      return;
    }
    const panEnabled = toggle.getAttribute("aria-pressed") === "true";
    if (!panEnabled || event.button !== 0) return;
    mapDrag = { x: event.clientX, y: event.clientY, left: mapOffset.x, top: mapOffset.y, moved: false };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!mapPointers.has(event.pointerId)) return;
    mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (mapPointers.size >= 2 && pinchStart) {
      const points = [...mapPointers.values()];
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (pinchStart.distance > 0 && distance > 0) {
        const previousScale = mapScale;
        mapScale = Math.max(.35, Math.min(2.5, pinchStart.scale * distance / pinchStart.distance));
        applyMapScale({ x: (points[0].x + points[1].x) / 2 - viewport.getBoundingClientRect().left, y: (points[0].y + points[1].y) / 2 - viewport.getBoundingClientRect().top }, previousScale);
      }
      return;
    }
    if (!mapDrag) return;
    const dx = event.clientX - mapDrag.x, dy = event.clientY - mapDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) mapDrag.moved = true;
    if (mapDrag.moved) { mapOffset.x = mapDrag.left + dx; mapOffset.y = mapDrag.top + dy; applyMapOffset(); }
  });
  const finishPointer = (event) => {
    if (mapDrag?.moved) suppressMapClick = true;
    mapPointers.delete(event.pointerId);
    if (mapPointers.size < 2) pinchStart = null;
    mapDrag = null;
  };
  viewport.addEventListener("pointerup", finishPointer);
  viewport.addEventListener("pointercancel", finishPointer);
  viewport.addEventListener("click", (event) => {
    if (!suppressMapClick) return;
    suppressMapClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
}

function renderBattlefieldMap(map, words) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.classList.add("battlefield-map-svg");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", words.battlefield);
  const positions = new Map(map.zones.map((zone, index) => [zone.id, { x: 95 + index * 220, y: 105 + (index % 2 === 0 ? -18 : 18) }]));
  const width = Math.max(210, 190 + (map.zones.length - 1) * 220);
  svg.setAttribute("viewBox", `0 0 ${width} 245`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", "245");
  decorateMap(svg, width, 245);

  for (const edge of map.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const line = document.createElementNS(ns, "line");
    const dx = to.x - from.x; const dy = to.y - from.y; const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length; const uy = dy / length;
    line.setAttribute("x1", String(from.x + ux * 39)); line.setAttribute("y1", String(from.y + uy * 39));
    line.setAttribute("x2", String(to.x - ux * 39)); line.setAttribute("y2", String(to.y - uy * 39));
    line.setAttribute("class", "battlefield-edge");
    svg.append(line);
    mapFootprints(svg, from, to);
    const distance = document.createElementNS(ns, "text");
    distance.setAttribute("x", String((from.x + to.x) / 2));
    distance.setAttribute("y", String((from.y + to.y) / 2 - 7));
    distance.setAttribute("class", "battlefield-distance");
    distance.setAttribute("text-anchor", "middle");
    distance.textContent = `${edge.feet} ft`;
    svg.append(distance);
  }

  for (const zone of map.zones) {
    const point = positions.get(zone.id);
    const active = zone.occupants.some((occupant) => occupant.active);
    const group = document.createElementNS(ns, "g");
    group.setAttribute("class", `battle-zone-node${zone.canMove ? " can-move" : ""}${active ? " has-active" : ""}${zone.occupants.some((occupant) => occupant.side === "foes") ? " has-foe" : ""}`);
    group.setAttribute("aria-label", `${zone.name}${zone.occupants.length ? `: ${zone.occupants.map((occupant) => occupant.name).join(", ")}` : ""}`);
    if (zone.canMove) {
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `${zone.name}. ${words.moveHere}`);
      const move = () => void performAction({ kind: "move", zoneId: zone.id });
      group.addEventListener("click", move);
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); move(); } });
    }
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(point.x)); circle.setAttribute("cy", String(point.y));
    circle.setAttribute("r", "37");
    group.append(circle);
    const marker = document.createElementNS(ns, "text");
    marker.setAttribute("x", String(point.x)); marker.setAttribute("y", String(point.y + 7));
    marker.setAttribute("class", "battle-zone-marker"); marker.setAttribute("text-anchor", "middle");
    marker.textContent = zone.occupants.length > 2 ? String(zone.occupants.length) : zone.occupants.length ? zone.occupants.map((occupant) => occupant.name.slice(0, 1)).join(" / ") : "◇";
    group.append(marker);

    const title = document.createElementNS(ns, "text");
    title.setAttribute("x", String(point.x)); title.setAttribute("y", String(point.y + 59));
    title.setAttribute("class", "battle-zone-title"); title.setAttribute("text-anchor", "middle");
    title.textContent = zone.name;
    group.append(title);
    const terrain = [zone.lighting ? { bright: words.lightBright, dim: words.lightDim, dark: words.lightDark }[zone.lighting] : "", zone.cover ? { half: words.coverHalf, "three-quarters": words.coverThreeQuarters }[zone.cover] : "", zone.difficult ? words.difficult : ""].filter(Boolean).join(" / ") || words.openGround;
    const detail = document.createElementNS(ns, "text");
    detail.setAttribute("x", String(point.x)); detail.setAttribute("y", String(point.y + 77));
    detail.setAttribute("class", "battle-zone-detail"); detail.setAttribute("text-anchor", "middle");
    detail.textContent = terrain;
    group.append(detail);
    const occupants = document.createElementNS(ns, "text");
    occupants.setAttribute("x", String(point.x)); occupants.setAttribute("y", String(point.y + 94));
    occupants.setAttribute("class", "battle-zone-occupants"); occupants.setAttribute("text-anchor", "middle");
    occupants.textContent = zone.occupants.map((occupant) => occupant.name).join(", ") || words.openGround;
    group.append(occupants);
    svg.append(group);
  }
  liveMap.append(svg);
}

function renderLobby(game) {
  document.querySelector("#hero-workspace-tabs").hidden = true;
  document.querySelectorAll(".hero-tab-panel").forEach((panel) => { panel.hidden = panel.id !== "hero-panel-actions"; });
  document.querySelector("#live-phase").textContent = t("activity.status.openTable");
  document.querySelector("#live-round").textContent = t("activity.status.seats", { count: game.playerCount, max: game.maxPlayers });
  document.querySelector(".live-phase").dataset.mode = "lobby";
  document.querySelector("#table-status-title").textContent = t("activity.status.gathering");
  document.querySelector("#table-status-subtitle").textContent = game.selectedHeroId ? t("activity.status.heroReady") : t("activity.status.chooseHero");
  document.querySelector(".table-status").dataset.mode = "lobby";
  document.querySelector("#live-turn").textContent = game.selectedHeroId ? t("activity.hero.ready") : t("activity.status.chooseHero");
  document.querySelector("#live-turn").classList.remove("is-active");
  document.querySelector("#live-hero-name").textContent = game.selectedHeroName ?? t("activity.hero.name");
  document.querySelector("#live-hero-subtitle").textContent = classText(game.selectedHeroClass) ?? t("activity.hero.chooseAvailable");
  document.querySelector("#live-hero-hp").textContent = t("activity.hero.preGame");
  document.querySelector("#live-hero-ac").textContent = "";
  document.querySelector("#live-hero-health").style.width = "0%";
  document.querySelector("#live-hero-class").textContent = t("activity.hero.choose");
  setHeroWatermark(null);
  document.querySelector("#live-hero-sigil").replaceChildren(iconImage("shape"));
  void setArtwork(document.querySelector("#live-hero-image"), document.querySelector("#live-hero-sigil"), null, "");
  document.querySelector("#live-resources").replaceChildren();
  document.querySelector("#live-equipment").replaceChildren();
  liveEnemies.replaceChildren();
  liveActions.replaceChildren();
  for (const hero of game.heroChoices) {
    const button = makeButton(t("activity.action.chooseHero", { name: hero.name, class: classText(hero.className) }) + (hero.available ? "" : t("activity.action.chosen")), () => void performAction({ kind: "chooseHero", heroId: hero.id }), hero.id === game.selectedHeroId);
    button.disabled = !hero.available;
    liveActions.append(button);
  }
  if (game.joinRequestStatus === "requested") liveActions.append(makeButton(t("activity.action.withdrawJoin"), () => void performAction({ kind: "withdrawJoin" })));
  if (game.canStart) liveActions.append(makeButton(t("activity.action.startAdventure"), () => void performAction({ kind: "startLobby" }), true));
  renderParty(game.members.map((member, index) => ({
    characterId: `member-${index}`,
    name: member.heroName,
    className: member.className,
    level: null,
    hp: null,
    maxHp: null,
    armorClass: null,
    presence: member.ready ? "ready" : "choosing",
    down: false,
    fallen: false,
    conditions: [],
    isYou: member.isYou,
    tableStatus: member.ready ? "submitted" : "waiting",
  })));
  document.querySelector("#live-party-count").textContent = t("activity.lobby.players", { count: game.playerCount, max: game.maxPlayers });
  setLiveMessage(game.startBlockReason === "notEnoughPlayers" ? t("activity.status.waitingPlayers") : game.startBlockReason === "notReady" ? t("activity.status.waitingReady") : game.selectedHeroId ? t("activity.status.readyOrganizer") : t("activity.status.chooseReserve"));
}

function renderTable(game) {
  const phase = t(phaseKeys[game.mode] ?? "activity.phase.adventure");
  document.querySelector("#live-phase").textContent = phase;
  document.querySelector("#live-round").textContent = game.roundNumber === null ? "" : t("activity.status.round", { round: game.roundNumber });
  document.querySelector(".live-phase").dataset.mode = game.mode;
  const turn = document.querySelector("#live-turn");
  const ownStatus = game.submission === "action" ? t("activity.status.actionSubmitted") : game.submission === "pass" ? t("activity.status.passedRound") : game.pendingRoll ? t("activity.status.rollNeeded") : t("activity.status.waitTurn");
  turn.textContent = game.yourTurn ? game.turn?.busy ? t("activity.status.resolvingAction") : t("activity.hero.turn") : game.mode === "collecting" && game.myHero ? ownStatus : game.activeName ? t("activity.status.activeTurnPossessive", { name: game.activeName }) : t("activity.status.waitTable");
  turn.classList.toggle("is-active", game.yourTurn);
  const status = document.querySelector(".table-status");
  status.dataset.mode = game.mode;
  let statusTitle = t("activity.status.adventureContinues");
  let statusSubtitle = t("activity.status.tableUpdated");
  if (game.mode === "combat") {
    statusTitle = game.activeName ? game.yourTurn && game.turn?.busy ? t("activity.status.activeResolving", { name: game.activeName }) : t("activity.status.activeTurn", { name: game.activeName }) : t("activity.status.combatResolving");
    statusSubtitle = game.yourTurn ? game.turn?.busy ? t("activity.status.yourActionResolving") : t("activity.status.heroActive") : t("activity.status.watchTurn");
  } else if (game.mode === "collecting") {
    statusTitle = t("activity.status.partyChoosing");
    statusSubtitle = t("activity.status.submittedCount", { count: game.submittedCount, total: game.participantCount });
  } else if (game.mode === "awaitingRolls") {
    statusTitle = game.pendingRollCount === 1 ? t("activity.status.oneRollNeeded") : t("activity.status.manyRollsNeeded", { count: game.pendingRollCount });
    statusSubtitle = game.pendingRoll ? t("activity.status.rollReady") : t("activity.status.waitRolls");
  } else if (game.mode === "planning") {
    statusTitle = t("activity.status.dmResolving");
    statusSubtitle = t("activity.status.storyReady");
  } else if (game.mode === "readyCheck") {
    statusTitle = t("activity.status.partyReady");
    statusSubtitle = t("activity.status.confirmSeat");
  } else if (game.mode === "paused" || game.mode === "safety") {
    statusTitle = t("activity.status.paused");
    statusSubtitle = t("activity.status.resumeOrganizer");
  }
  document.querySelector("#table-status-title").textContent = statusTitle;
  document.querySelector("#table-status-subtitle").textContent = statusSubtitle;
  const hero = game.myHero;
  document.querySelector("#live-hero-name").textContent = hero?.name ?? t("activity.hero.notSelected");
  document.querySelector("#live-hero-subtitle").textContent = hero ? `${hero.raceName ?? t("activity.hero.adventurer")} ${classText(hero.className) ?? t("activity.hero.heroClass")} ${hero.level}` : t("activity.hero.joinToChoose");
  document.querySelector("#live-hero-class").textContent = (classText(hero?.className) ?? t("activity.hero.adventurerCaps")).toLocaleUpperCase();
  const classSigil = document.querySelector("#live-hero-sigil");
  classSigil.replaceChildren(iconImage(iconForClass(hero?.className)));
  void setArtwork(document.querySelector("#live-hero-image"), classSigil, hero?.imageUrl, t("activity.hero.portraitAlt", { name: hero?.name ?? t("activity.hero.heroClass") }));
  document.querySelector("#live-hero-hp").textContent = hero ? t("activity.hero.hp", { hp: hero.hp, max: hero.maxHp }) : "";
  document.querySelector("#live-hero-ac").textContent = hero ? t("activity.hero.ac", { value: hero.armorClass }) : "";
  document.querySelector("#live-hero-health").style.width = hero ? `${Math.max(0, Math.min(100, (hero.hp / Math.max(1, hero.maxHp)) * 100))}%` : "0%";
  const resources = document.querySelector("#live-resources");
  resources.replaceChildren();
  if (hero) {
    for (const slot of [...hero.slots, ...hero.pactSlots]) {
      const resource = document.createElement("span");
      resource.className = "resource";
      resource.textContent = t("activity.hero.slot", { level: slot.level, left: slot.left, max: slot.max });
      resources.append(resource);
    }
    renderEquipment(hero);
  } else {
    document.querySelector("#live-equipment").replaceChildren();
  }
  document.querySelector("#live-party-count").textContent = t("activity.party.count", { count: game.party.length });
  renderTableActions(game);
  renderCharacterWorkspace(game);
  renderEnemies(game.foes);
  renderParty(game.party);
  setLiveMessage(game.submission === "action" ? t("activity.status.actionIn") : game.submission === "pass" ? t("activity.status.youPassed") : "");
  updateRollPrompt(game.pendingRoll);
}

function makeEnemy(enemy) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `live-party-card live-enemy${enemy.active ? " is-active" : ""}${enemy.name === selectedEnemyName ? " is-selected" : ""}`;
  card.classList.toggle("is-active", enemy.active);
  card.setAttribute("aria-label", `${enemy.name}. ${t(`activity.band.${enemy.band}`)}, ${enemy.zone}`);
  card.setAttribute("aria-pressed", String(enemy.name === selectedEnemyName));
  card.addEventListener("click", () => { selectedEnemyName = enemy.name; if (currentSnapshot?.kind === "table") { renderParty(currentSnapshot.party); renderCharacterWorkspace(currentSnapshot); renderEnemies(currentSnapshot.foes); } });
  const sigil = document.createElement("span"); sigil.className = "live-party-sigil enemy-sigil"; sigil.setAttribute("aria-hidden", "true");
  sigil.append(iconImage("attack")); card.append(sigil);
  const copy = document.createElement("span"); copy.className = "live-party-copy enemy-copy";
  const name = document.createElement("strong");
  name.textContent = enemy.name;
  const health = document.createElement("span");
  health.textContent = t("activity.hero.enemyHealth", { band: t(`activity.band.${enemy.band}`), zone: enemy.zone });
  const track = document.createElement("span");
  track.className = "party-health live-party-health";
  const fill = document.createElement("i");
  fill.style.width = `${{ unhurt: 100, hurt: 66, bloodied: 33, down: 0 }[enemy.band] ?? 100}%`;
  track.append(fill);
  copy.append(name, health);
  card.append(copy);
  if (enemy.active) {
    const turn = document.createElement("span");
    turn.className = "live-party-status enemy-turn-label";
    turn.textContent = t("activity.party.turnNow");
    copy.append(turn);
  }
  copy.append(track);
  return card;
}

function renderEnemies(enemies) { liveEnemies.replaceChildren(...(enemies.length ? [Object.assign(document.createElement("span"), { className: "live-enemies-heading", textContent: t("activity.scene.encounter") }), ...enemies.map(makeEnemy)] : [])); }

function renderEquipment(hero) {
  const target = document.querySelector("#live-equipment");
  const equipped = [...(hero.worn ?? []).map((name) => ({ name, icon: "shield" })), ...(hero.weapons ?? []).map((name) => ({ name, icon: "attack" }))].slice(0, 4);
  target.replaceChildren();
  if (equipped.length === 0) return;
  const label = document.createElement("span");
  label.className = "equipment-label";
  label.textContent = t("activity.hero.equipped");
  target.append(label);
  for (const item of equipped) {
    const chip = document.createElement("span");
    chip.className = "equipment-chip";
    chip.title = item.name;
    chip.append(iconImage(item.icon));
    const name = document.createElement("span");
    name.textContent = item.name;
    chip.append(name);
    target.append(chip);
  }
}

function renderParty(members) {
  liveParty.replaceChildren(...members.map((hero) => {
    const card = document.createElement(hero.hp !== null && hero.maxHp !== null ? "button" : "div");
    card.className = `live-party-card${hero.isYou ? " is-you" : ""}${!selectedEnemyName && hero.characterId === selectedPartyCharacterId ? " is-selected" : ""}`;
    card.dataset.status = hero.tableStatus ?? (hero.presence === "away" ? "away" : "waiting");
    if (hero.hp !== null && hero.maxHp !== null) {
      card.type = "button";
      card.setAttribute("aria-label", t("activity.party.inspect", { name: hero.name }));
      card.setAttribute("aria-pressed", String(!selectedEnemyName && hero.characterId === selectedPartyCharacterId));
      card.addEventListener("click", () => {
        selectedEnemyName = null;
        const page = document.querySelector(".live-hero");
        if (selectedPartyCharacterId !== hero.characterId && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          page.getAnimations().forEach((animation) => animation.cancel());
          page.animate([{ transform: "perspective(1200px) rotateY(-9deg)", opacity: .55 }, { transform: "perspective(1200px) rotateY(0deg)", opacity: 1 }], { duration: 360, easing: "ease-out" });
        }
        selectedPartyCharacterId = hero.characterId;
        selectedWorkspaceTab = hero.isYou ? "actions" : "overview";
        if (currentSnapshot?.kind === "table") {
          renderParty(currentSnapshot.party);
          renderCharacterWorkspace(currentSnapshot);
          renderEnemies(currentSnapshot.foes);
        }
      });
    }
    const sigil = document.createElement("span");
    sigil.className = "live-party-sigil";
    sigil.setAttribute("aria-hidden", "true");
    const classGlyph = iconImage(iconForClass(hero.className));
    classGlyph.className = "party-class-glyph";
    const portrait = document.createElement("img");
    portrait.className = "party-portrait";
    portrait.alt = "";
    sigil.append(classGlyph, portrait);
    void setArtwork(portrait, classGlyph, hero.imageUrl, t("activity.hero.portraitAlt", { name: hero.name }));
    const copy = document.createElement("span");
    copy.className = "live-party-copy";
    const name = document.createElement("strong");
    name.textContent = hero.name;
    if (hero.isYou) {
      const you = document.createElement("small");
      you.textContent = t("activity.party.you");
      name.append(you);
    }
    const subtitle = document.createElement("span");
    subtitle.textContent = hero.level === null ? classText(hero.className) ?? t(`activity.party.presence.${hero.presence}`) : `${hero.raceName ?? ""} ${classText(hero.className) ?? t("activity.hero.heroClass")} ${hero.level}`.trim();
    copy.append(name, subtitle);
    const status = document.createElement("span");
    status.className = "live-party-status";
    const statusWords = { acting: t("activity.party.turnNow"), submitted: hero.presence === "ready" ? t("activity.party.ready") : t("activity.party.actionIn"), passed: t("activity.party.passed"), missed: t("activity.party.missed"), away: t("activity.party.away"), waiting: t("activity.party.waiting") };
    if (hero.tableStatus === "acting") status.append(iconImage("attack"));
    status.append(document.createTextNode(statusWords[hero.tableStatus] ?? statusWords.waiting));
    copy.append(status);
    if (hero.hp !== null && hero.maxHp !== null) {
      const track = document.createElement("span");
      track.className = "party-health live-party-health";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, hero.hp / Math.max(1, hero.maxHp) * 100))}%`;
      track.append(fill);
      const hp = document.createElement("span");
      hp.textContent = t("activity.hero.hp", { hp: hero.hp, max: hero.maxHp });
      copy.append(track, hp);
    } else {
      const status = document.createElement("span");
      status.textContent = hero.presence === "ready" ? t("activity.party.characterSelected") : t("activity.party.choosingCharacter");
      copy.append(status);
    }
    card.append(sigil, copy);
    return card;
  }));
}

// The class emblem sits faintly in the corner of the hero page; it is the backdrop, not a mark on the portrait.
function setHeroWatermark(className) {
  const mark = document.querySelector("#hero-watermark");
  if (!className) {
    mark.hidden = true;
    return;
  }
  mark.src = `${artIconPrefix}/${iconForClass(className)}.svg`;
  mark.hidden = false;
}

function renderCharacterWorkspace(game) {
  const enemy = game.foes.find((foe) => foe.name === selectedEnemyName);
  if (enemy) {
    document.querySelector("#live-turn").textContent = enemy.active ? t("activity.party.turnNow") : "";
    document.querySelector("#live-turn").classList.toggle("is-active", enemy.active);
    document.querySelector("#hero-workspace-label").textContent = t("activity.scene.encounter");
    document.querySelector("#live-hero-name").textContent = enemy.name;
    document.querySelector("#live-hero-subtitle").textContent = enemy.zone;
    document.querySelector("#live-hero-class").textContent = enemy.band;
    setHeroWatermark(null);
    document.querySelector("#live-hero-hp").textContent = t(`activity.band.${enemy.band}`);
    document.querySelector("#live-hero-ac").textContent = "";
    document.querySelector("#live-hero-health").style.width = `${{ unhurt: 100, hurt: 66, bloodied: 33, down: 0 }[enemy.band] ?? 100}%`;
    const sigil = document.querySelector("#live-hero-sigil"); sigil.replaceChildren(iconImage("attack"));
    void setArtwork(document.querySelector("#live-hero-image"), sigil, null, enemy.name);
    const tabs = document.querySelector("#hero-workspace-tabs"); tabs.hidden = false; tabs.replaceChildren();
    const overview = document.createElement("button"); overview.type = "button"; overview.textContent = t("activity.tab.overview"); overview.setAttribute("role", "tab"); overview.setAttribute("aria-selected", "true"); overview.id = "hero-tab-overview"; tabs.append(overview);
    if (game.myHero) tabs.append(makeButton(t("activity.tab.actions"), () => { selectedEnemyName = null; selectedPartyCharacterId = game.myHero.characterId; selectedWorkspaceTab = "actions"; renderCharacterWorkspace(game); renderParty(game.party); renderEnemies(game.foes); }));
    document.querySelectorAll(".hero-tab-panel").forEach((panel) => { panel.hidden = panel.id !== "hero-panel-overview"; });
    document.querySelector("#live-resources").textContent = enemy.band;
    document.querySelector("#live-equipment").replaceChildren();
    document.querySelector("#hero-action-dock").hidden = !game.myHero;
    if (game.myHero) document.querySelector("#hero-action-dock").append(liveActions);
    return;
  }
  selectedEnemyName = null;
  const ownHero = game.myHero;
  if (selectedPartyCharacterId === null || !game.party.some((member) => member.characterId === selectedPartyCharacterId)) {
    selectedPartyCharacterId = ownHero?.characterId ?? game.party.find((member) => member.isYou)?.characterId ?? game.party[0]?.characterId ?? null;
    selectedWorkspaceTab = "actions";
  }
  const selected = game.party.find((member) => member.characterId === selectedPartyCharacterId) ?? game.party.find((member) => member.isYou) ?? null;
  const viewingOwn = selected?.isYou === true && ownHero !== null;
  document.querySelector("#hero-action-dock").hidden = viewingOwn;
  if (viewingOwn) document.querySelector("#hero-panel-actions").append(liveActions);
  else document.querySelector("#hero-action-dock").append(liveActions);
  const profile = viewingOwn ? ownHero : selected;
  if (!profile) return;
  const turnLabel = document.querySelector("#live-turn");
  turnLabel.classList.toggle("is-active", selected.tableStatus === "acting");
  turnLabel.textContent = selected.tableStatus === "acting" ? viewingOwn ? t("activity.hero.turn") : t("activity.party.turnNow") : selected.tableStatus === "submitted" ? t("activity.party.actionIn") : selected.tableStatus === "passed" ? t("activity.party.passed") : t("activity.party.waiting");
  document.querySelector("#hero-workspace-label").textContent = viewingOwn ? t("activity.hero.label") : t("activity.hero.viewingMember");
  document.querySelector("#live-hero-name").textContent = profile.name;
  document.querySelector("#live-hero-subtitle").textContent = `${profile.raceName ?? t("activity.hero.adventurer")} ${classText(profile.className) ?? t("activity.hero.heroClass")} ${profile.level}`;
  document.querySelector("#live-hero-class").textContent = (classText(profile.className) ?? t("activity.hero.adventurerCaps")).toLocaleUpperCase();
  const sigil = document.querySelector("#live-hero-sigil");
  sigil.replaceChildren(iconImage(iconForClass(profile.className)));
  void setArtwork(document.querySelector("#live-hero-image"), sigil, profile.imageUrl, t("activity.hero.portraitAlt", { name: profile.name }));
  setHeroWatermark(profile.className);
  document.querySelector("#live-hero-hp").textContent = t("activity.hero.hp", { hp: profile.hp, max: profile.maxHp });
  document.querySelector("#live-hero-ac").textContent = t("activity.hero.ac", { value: profile.armorClass });
  document.querySelector("#live-hero-health").style.width = `${Math.max(0, Math.min(100, profile.hp / Math.max(1, profile.maxHp) * 100))}%`;

  const tabs = viewingOwn
    ? [["overview", "activity.tab.overview"], ["actions", "activity.tab.actions"], ["spells", "activity.tab.spells"], ["inventory", "activity.tab.inventory"], ["trade", "activity.tab.trade"]]
    : [["overview", "activity.tab.overview"], ["trade", "activity.tab.trade"]];
  if (!tabs.some(([id]) => id === selectedWorkspaceTab)) selectedWorkspaceTab = viewingOwn ? "actions" : "overview";
  const tablist = document.querySelector("#hero-workspace-tabs");
  tablist.hidden = false;
  tablist.replaceChildren(...tabs.map(([id, key]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "tab";
    button.id = `hero-tab-${id}`;
    button.setAttribute("aria-selected", String(selectedWorkspaceTab === id));
    button.setAttribute("aria-controls", `hero-panel-${id}`);
    button.tabIndex = selectedWorkspaceTab === id ? 0 : -1;
    button.textContent = t(key);
    button.addEventListener("click", () => { selectedWorkspaceTab = id; renderCharacterWorkspace(game); });
    return button;
  }));
  for (const [id] of [["overview"], ["actions"], ["spells"], ["inventory"], ["trade"]]) {
    const panel = document.querySelector(`#hero-panel-${id}`);
    panel.hidden = !tabs.some(([tabId]) => tabId === id) || selectedWorkspaceTab !== id;
  }

  const resources = document.querySelector("#live-resources");
  const equipment = document.querySelector("#live-equipment");
  resources.replaceChildren();
  equipment.replaceChildren();
  if (viewingOwn) {
    for (const slot of [...ownHero.slots, ...ownHero.pactSlots]) {
      const resource = document.createElement("span"); resource.className = "resource";
      resource.textContent = t("activity.hero.slot", { level: slot.level, left: slot.left, max: slot.max }); resources.append(resource);
    }
    renderEquipment(ownHero);
    renderSpellbook(ownHero);
    renderInventory(ownHero);
  } else {
    for (const condition of selected.conditions ?? []) {
      const chip = document.createElement("span"); chip.className = "resource"; chip.textContent = condition; resources.append(chip);
    }
    if (resources.childElementCount === 0) resources.textContent = t("activity.party.noConditions");
    document.querySelector("#live-spellbook").replaceChildren();
    document.querySelector("#live-inventory").replaceChildren();
  }
  renderTrade(game, viewingOwn ? null : selected);
}

function renderSpellbook(hero) {
  const target = document.querySelector("#live-spellbook");
  target.replaceChildren();
  const addGroup = (labelKey, spells) => {
    if (!spells.length) return;
    const group = document.createElement("section"); group.className = "workspace-list-group";
    const heading = document.createElement("h3"); heading.textContent = t(labelKey); group.append(heading);
    const list = document.createElement("div"); list.className = "workspace-chip-list";
    for (const spell of spells) { const chip = document.createElement("span"); chip.className = "resource"; chip.append(iconImage("spell"), document.createTextNode(spell)); list.append(chip); }
    group.append(list); target.append(group);
  };
  addGroup("activity.spell.cantrips", hero.cantrips ?? []);
  addGroup("activity.spell.prepared", hero.prepared ?? []);
  if (!target.childElementCount) target.textContent = t("activity.spell.noSpells");
}

function renderInventory(hero) {
  const target = document.querySelector("#live-inventory");
  target.replaceChildren();
  const heading = document.createElement("h3"); heading.textContent = t("activity.detail.inventory"); target.append(heading);
  for (const item of hero.inventoryChoices ?? []) {
    const row = document.createElement("div"); row.className = "workspace-item-row";
    const label = document.createElement("span"); label.textContent = `${item.name} ${t("activity.inventory.count", { count: item.count })}${item.worn ? t("activity.detail.equipped") : ""}`; row.append(label);
    if (item.wearable) row.append(makeButton(t(item.worn ? "activity.action.remove" : "activity.action.equip"), () => void performAction({ kind: item.worn ? "removeItem" : "wearItem", itemId: item.id })));
    row.append(makeButton(t("activity.action.stash"), () => void performAction({ kind: "stashItem", itemId: item.id })));
    target.append(row);
  }
  if (!(hero.inventoryChoices ?? []).length) { const empty = document.createElement("p"); empty.textContent = t("activity.inventory.noItems"); target.append(empty); }
  const stashHeading = document.createElement("h3"); stashHeading.textContent = t("activity.detail.partyStash"); target.append(stashHeading);
  for (const item of hero.stash ?? []) {
    const row = document.createElement("div"); row.className = "workspace-item-row";
    const label = document.createElement("span"); label.textContent = `${item.name} ${t("activity.inventory.count", { count: item.count })}`;
    row.append(label, makeButton(t("activity.action.take"), () => void performAction({ kind: "takeFromStash", itemId: item.id }))); target.append(row);
  }
}

function renderTrade(game, fixedTarget) {
  const target = document.querySelector("#live-trade");
  target.replaceChildren();
  const recipients = game.party.filter((member) => !member.isYou);
  const recipient = fixedTarget ?? recipients.find((member) => member.characterId === target.dataset.recipient) ?? recipients[0];
  if (recipient) {
    const form = document.createElement("div"); form.className = "workspace-trade-form";
    const heading = document.createElement("h3"); heading.textContent = t("activity.trade.recipient", { name: recipient.name }); form.append(heading);
    if (!fixedTarget && recipients.length > 1) {
      const chooser = document.createElement("select"); chooser.setAttribute("aria-label", t("activity.trade.target"));
      for (const member of recipients) { const option = document.createElement("option"); option.value = member.characterId; option.textContent = member.name; option.selected = member.characterId === recipient.characterId; chooser.append(option); }
      chooser.addEventListener("change", () => { target.dataset.recipient = chooser.value; renderTrade(game, null); }); form.append(chooser);
    }
    const items = (game.myHero?.inventoryChoices ?? []).filter((item) => item.count > 0);
    if (items.length) {
      const chooser = document.createElement("select"); chooser.setAttribute("aria-label", t("activity.trade.item"));
      for (const item of items) { const option = document.createElement("option"); option.value = item.id; option.textContent = `${item.name} ×${item.count}`; chooser.append(option); }
      form.append(chooser, makeButton(t("activity.trade.send"), () => void performAction({ kind: "giveItem", itemId: chooser.value, toCharacterId: recipient.characterId }), true));
    } else { const empty = document.createElement("p"); empty.textContent = t("activity.trade.noItems"); form.append(empty); }
    target.append(form);
  }
  const offers = game.offers ?? [];
  const relevant = fixedTarget ? offers.filter((offer) => offer.direction === "outgoing" ? offer.toCharacterId === fixedTarget.characterId : offer.fromCharacterId === fixedTarget.characterId) : offers;
  for (const offer of relevant) {
    const row = document.createElement("div"); row.className = "workspace-offer-row";
    const label = document.createElement("span"); label.textContent = t(offer.direction === "incoming" ? "activity.trade.incoming" : "activity.trade.outgoing", offer.direction === "incoming" ? { name: offer.fromName, item: offer.itemName } : { name: offer.toName, item: offer.itemName }); row.append(label);
    if (offer.direction === "incoming") row.append(makeButton(t("activity.trade.accept"), () => void performAction({ kind: "offerResponse", offerId: offer.id, answer: "accept" }), true), makeButton(t("activity.trade.decline"), () => void performAction({ kind: "offerResponse", offerId: offer.id, answer: "decline" })));
    else row.append(makeButton(t("activity.trade.cancel"), () => void performAction({ kind: "offerResponse", offerId: offer.id, answer: "cancel" })));
    target.append(row);
  }
  if (!recipient && !relevant.length) target.textContent = t("activity.trade.none");
}

// Where each kind of action is shown: urgent decisions on top, the round composer, a category list, or the closing button.
const actionPlacement = { acceptInvite: "top", joinHero: "top", reaction: "top", smite: "top", opportunityAttack: "top", ready: "top", begin: "top", continue: "top", submit: "composer", pass: "composer", endTurn: "bottom" };
const actionCategoryOf = { attack: "attack", combatSpell: "spells", exploreSpell: "spells", healSpell: "spells", reviveSpell: "spells", summonCompanion: "spells", move: "move", moveScene: "move", teleport: "move", engage: "move", withdraw: "move", dash: "move", useItem: "items", combatItem: "items", shield: "items", shop: "items", askNpc: "talk", pressNpc: "talk", feature: "other", wildShape: "other", combatDodge: "other" };
const actionCategoryOrder = ["attack", "spells", "move", "items", "talk", "other"];
const actionCategoryIcon = { attack: "attack", spells: "spell", move: "move", items: "potion", talk: "clue", other: "shape" };
let selectedActionCategory = null;
const drafts = { action: "", ask: "" };

function draftInput(element, draftKey, label, placeholder) {
  element.className = "live-action-input";
  element.placeholder = placeholder;
  element.setAttribute("aria-label", label);
  element.value = drafts[draftKey];
  element.addEventListener("input", () => { drafts[draftKey] = element.value; });
  return element;
}

function renderTableActions(game) {
  liveActions.replaceChildren();
  const top = [], composer = [], bottom = [];
  const groups = new Map(actionCategoryOrder.map((category) => [category, []]));
  const addAction = (label, action, primary = false) => {
    const button = makeButton(label, () => void performAction(action), primary, actionIcon[action.kind] ?? "notice");
    const place = actionPlacement[action.kind];
    (place === "top" ? top : place === "composer" ? composer : place === "bottom" ? bottom : groups.get(actionCategoryOf[action.kind] ?? "other")).push(button);
  };
  if (game.canAcceptInvite) addAction(t("activity.action.acceptInvite"), { kind: "acceptInvite" }, true);
  for (const hero of game.joinChoices) addAction(t("activity.action.joinAs", { name: hero.name, class: classText(hero.className) }), { kind: "joinHero", heroRef: hero.id }, true);
  for (const hero of game.savedHeroChoices ?? []) addAction(t("activity.action.joinWith", { name: hero.name, class: classText(hero.className) }), { kind: "joinHero", heroRef: hero.id }, true);
  if (game.reactionIsYours && game.reaction) {
    addAction(t("activity.action.declineReaction", { name: game.reaction.attackerName }), { kind: "reaction", spellId: null, slotLevel: null }, true);
    for (const spell of [...new Map(game.reaction.options.map((option) => [option.spellId, option])).values()]) addAction(t("activity.action.cast", { name: spell.spellName }), { kind: "reaction", spellId: spell.spellId, slotLevel: spell.slotLevel });
  }
  if (game.smiteIsYours && game.smite) {
    addAction(t("activity.action.skipSmite", { name: game.smite.targetName }), { kind: "smite", slotLevel: null }, true);
    for (const option of game.smite.options) addAction(t("activity.action.divineSmite", { level: option.slotLevel }), { kind: "smite", slotLevel: option.slotLevel });
  }
  if (game.opportunityAttackIsYours && game.opportunityAttack) {
    addAction(t("activity.action.holdReaction", { name: game.opportunityAttack.moverName }), { kind: "opportunityAttack", accept: false }, true);
    addAction(t("activity.action.opportunityAttack", { name: game.opportunityAttack.moverName }), { kind: "opportunityAttack", accept: true });
  }
  if (game.mode === "readyCheck") {
    addAction(t("activity.action.ready"), { kind: "ready" }, true);
    if (game.canBegin) addAction(t("activity.action.beginAdventure"), { kind: "begin" });
  } else if (game.mode === "paused" && game.canBegin) addAction(t("activity.action.resumeGame"), { kind: "continue" }, true);

  let note = null;
  if (game.mode === "collecting" && game.submission !== null) {
    note = document.createElement("span");
    note.className = "live-action-note status-note";
    note.textContent = game.submission === "action" ? t("activity.status.submittedFollow") : game.submission === "pass" ? t("activity.status.passedFollow") : t("activity.status.roundMovedOn");
  }

  if (game.turn && !game.turn.busy) {
    for (const attack of game.turn.attacks) {
      const offHand = attack.weapon.startsWith("offhand:");
      const nonlethal = attack.weapon.startsWith("nonlethal:");
      const weaponId = attack.weapon.replace(/^(offhand:|nonlethal:)/, "");
      for (const target of attack.targets) {
        addAction(t("activity.action.attack", { name: target.name, weapon: weaponId.replace(/^item:/, "") }), { kind: "attack", weaponId, targetId: target.id, offHand, nonlethal }, true);
      }
    }
    for (const spell of game.turn.spells) {
      const target = spell.targets[0];
      if (target) addAction(t("activity.action.castOn", { spell: spell.spellId.replace(/^spell:/, ""), name: target.name }), { kind: "combatSpell", spellId: spell.spellId, slotLevel: spell.slotLevel, targetIds: [target.id] });
    }
    for (const feature of game.turn.features) addAction(t("activity.action.useFeature", { name: feature.id.replace(/^feature:/, "").replaceAll("-", " ") }), { kind: "feature", featureId: feature.id });
    for (const potion of game.turn.potions) addAction(t("activity.action.usePotion", { name: potion.id.replace(/^item:/, "").replaceAll("-", " "), count: potion.count }), { kind: "combatItem", itemId: potion.id });
    for (const shield of game.turn.shields) addAction(t(shield.on ? "activity.action.shieldStow" : "activity.action.shieldRaise"), { kind: "shield", itemId: shield.id, on: !shield.on });
    for (const move of game.turn.moves) addAction(t("activity.action.moveTo", { name: move.zone }), { kind: "move", zoneId: move.zoneId });
    for (const target of game.turn.engage) addAction(t("activity.action.engage", { name: target.name }), { kind: "engage", targetId: target.id });
    for (const teleport of game.turn.teleports) addAction(t("activity.action.teleport", { name: teleport.zone }), { kind: "teleport", spellId: teleport.spellId, slotLevel: teleport.slotLevel, zoneId: teleport.zoneId });
    for (const monsterId of game.turn.wildShapes) addAction(t("activity.action.wildShape", { name: monsterId.replace(/^monster:/, "").replaceAll("-", " ") }), { kind: "wildShape", monsterId });
    if (game.turn.canRevertShape) addAction(t("activity.action.returnForm"), { kind: "wildShape", monsterId: null });
    if (game.turn.canWithdraw) addAction(t("activity.action.withdrawSafely"), { kind: "withdraw" });
    if (game.turn.canDashOrDisengage) addAction(t("activity.action.dash"), { kind: "dash" });
    if (game.turn.canDodge) addAction(t("activity.action.dodge"), { kind: "combatDodge" });
    addAction(t("activity.action.endTurn"), { kind: "endTurn" });
  } else if (game.mode === "collecting" && game.submission === null && game.myHero !== null) {
    const input = draftInput(document.createElement("textarea"), "action", t("activity.action.submit"), t("activity.action.inputPlaceholder"));
    input.maxLength = 1500;
    input.rows = 2;
    composer.push(input);
    addAction(t("activity.action.submit"), { kind: "submit", text: () => input.value }, true);
    addAction(t("activity.action.pass"), { kind: "pass" });
  }
  if (game.explore && game.myHero) {
    if (game.explore.npcs.length) {
      const question = draftInput(document.createElement("input"), "ask", t("activity.category.talk"), t("activity.action.askPlaceholder"));
      question.maxLength = 500;
      groups.get("talk").push(question);
      for (const npc of game.explore.npcs) {
        addAction(t("activity.action.ask", { name: npc.name }), { kind: "askNpc", npcId: npc.id, question: () => question.value }, true);
        if (!npc.secretKnown) for (const skill of ["insight", "persuasion", "deception", "intimidation"]) addAction(t("activity.action.pressNpc", { name: npc.name, skill: t(`activity.skill.${skill}`) }), { kind: "pressNpc", npcId: npc.id, skill });
      }
    }
    for (const shop of game.explore.shops ?? []) {
      for (const item of shop.buy) addAction(t("activity.action.buy", { name: item.name, price: item.price }), { kind: "shop", npcId: shop.npc.id, itemId: item.itemId, direction: "buy" });
      for (const item of shop.sell) addAction(t("activity.action.sell", { name: item.name, price: item.price }), { kind: "shop", npcId: shop.npc.id, itemId: item.itemId, direction: "sell" });
    }
    for (const spell of game.explore.spells) addAction(t("activity.action.cast", { name: spell.name }), { kind: "exploreSpell", spellId: spell.id });
    for (const potion of game.myHero.usablePotions ?? []) addAction(t("activity.action.drink", { name: potion.name, count: potion.count }), { kind: "useItem", itemId: potion.id });
    for (const spell of game.explore.healing) for (const slot of spell.slots) for (const target of game.explore.hurt) addAction(t("activity.action.heal", { target: target.name, spell: spell.name, level: slot.level }), { kind: "healSpell", spellId: spell.id, slotLevel: slot.level, targetId: target.id });
    for (const spell of game.explore.reviving) for (const slot of spell.slots) for (const target of game.explore.fallen) addAction(t("activity.action.revive", { target: target.name, spell: spell.name, level: slot.level }), { kind: "reviveSpell", spellId: spell.id, slotLevel: slot.level, targetId: target.id });
    for (const spell of game.explore.conjuring) for (const slot of spell.slots) addAction(t("activity.action.summon", { spell: spell.name, level: slot.level }), { kind: "summonCompanion", spellId: spell.id, slotLevel: slot.level });
    for (const place of game.explore.places) addAction(t("activity.action.travel", { name: place.title }), { kind: "moveScene", sceneId: place.id });
  }

  const row = (className, nodes) => {
    const element = document.createElement("div");
    element.className = className;
    element.append(...nodes);
    return element;
  };
  if (top.length) liveActions.append(row("action-row action-urgent", top));
  if (composer.length) liveActions.append(row("action-composer", composer));
  if (note) liveActions.append(note);
  const choiceCount = (category) => groups.get(category).filter((node) => node instanceof HTMLButtonElement).length;
  const categories = actionCategoryOrder.filter((category) => choiceCount(category) > 0);
  if (categories.length) {
    if (!categories.includes(selectedActionCategory)) selectedActionCategory = categories[0];
    const chips = document.createElement("div");
    chips.className = "action-chips";
    chips.setAttribute("role", "tablist");
    const lists = new Map();
    const select = (category) => {
      selectedActionCategory = category;
      for (const [id, list] of lists) list.hidden = id !== category;
      for (const chip of chips.children) chip.setAttribute("aria-selected", String(chip.dataset.category === category));
    };
    for (const category of categories) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.role = "tab";
      chip.dataset.category = category;
      const badge = document.createElement("b");
      badge.textContent = String(choiceCount(category));
      chip.append(iconImage(actionCategoryIcon[category]), document.createTextNode(t(`activity.category.${category}`)), badge);
      chip.addEventListener("click", () => select(category));
      chips.append(chip);
      const list = row("action-list", groups.get(category));
      list.setAttribute("role", "tabpanel");
      lists.set(category, list);
    }
    liveActions.append(chips, ...lists.values());
    select(selectedActionCategory);
  }
  if (bottom.length) liveActions.append(row("action-row action-end", bottom));
  if (liveActions.childElementCount === 0) {
    const empty = document.createElement("span");
    empty.className = "live-action-note";
    empty.textContent = t("activity.status.waitUpdate");
    liveActions.append(empty);
  }
}

async function performAction(action) {
  if (currentGameId === null) return;
  if (action.kind === "details") return openDetails();
  const body = { ...action };
  for (const [key, value] of Object.entries(body)) if (typeof value === "function") body[key] = value();
  setLiveMessage(t("activity.status.sendingAction"));
  try {
    const payload = await requestJson(`/api/activity/games/${encodeURIComponent(currentGameId)}/action`, { method: "POST", body: JSON.stringify(body) });
    currentSnapshot = payload.snapshot;
    renderGame(currentSnapshot);
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : t("activity.status.actionFailed"));
    await loadTable();
  }
}

function humanizeRuleName(value) {
  return String(value ?? "check").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function rollLabel(test) {
  if (!test) return t("activity.dice.abilityCheck");
  const key = String(test.kind === "skill" ? test.skill : test.ability).toLocaleLowerCase();
  const name = t(`activity.rule.${key}`);
  return test.kind === "save" ? t("activity.dice.save", { ability: name }) : test.kind === "skill" ? t("activity.dice.skill", { skill: name }) : t("activity.dice.ability", { ability: name });
}

function updateRollPrompt(pendingRoll) {
  const dialog = document.querySelector("#dice-dialog");
  if (pendingRoll === null) {
    if (!rollingCheck && dialog.open) dialog.close();
    if (!rollingCheck) lastRollPromptId = null;
    return;
  }
  if (pendingRoll.checkId === lastRollPromptId) return;
  lastRollPromptId = pendingRoll.checkId;
  document.querySelector("#dice-test").textContent = rollLabel(pendingRoll.test);
  document.querySelector("#dice-action").textContent = pendingRoll.action?.trim() || t("activity.dice.waiting");
  document.querySelector("#dice-title").textContent = t("activity.dice.title");
  document.querySelector("#dice-description").textContent = t("activity.dice.description");
  document.querySelector("#dice-roll-button span").textContent = t("activity.dice.rollD20");
  document.querySelector("#dice-roll-button").disabled = false;
  if (!dialog.open) dialog.showModal();
}

async function rollPendingCheck() {
  if (currentGameId === null || rollingCheck) return;
  const dialog = document.querySelector("#dice-dialog");
  const button = document.querySelector("#dice-roll-button");
  rollingCheck = true;
  button.disabled = true;
  button.querySelector("span").textContent = t("activity.dice.rolling");
  dialog.classList.add("is-rolling");
  document.querySelector("#dice-title").textContent = t("activity.dice.rollingTitle");
  document.querySelector("#dice-description").textContent = t("activity.dice.sending");
  const startedAt = Date.now();
  try {
    const response = await requestJson(`/api/activity/games/${encodeURIComponent(currentGameId)}/action`, {
      method: "POST",
      body: JSON.stringify({ kind: "roll" }),
    });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1150 - (Date.now() - startedAt))));
    currentSnapshot = response.snapshot;
    renderGame(currentSnapshot);
    document.querySelector("#dice-title").textContent = t("activity.dice.sent");
    document.querySelector("#dice-description").textContent = t("activity.dice.applying");
    button.querySelector("span").textContent = t("activity.dice.done");
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (dialog.open) dialog.close();
  } catch (error) {
    document.querySelector("#dice-title").textContent = t("activity.dice.failed");
    document.querySelector("#dice-description").textContent = error instanceof Error ? error.message : t("activity.dice.tryAgain");
    button.disabled = false;
    button.querySelector("span").textContent = t("activity.dice.tryAgain");
    lastRollPromptId = null;
  } finally {
    rollingCheck = false;
    dialog.classList.remove("is-rolling");
  }
}

document.querySelector("#dice-roll-button").addEventListener("click", () => void rollPendingCheck());
document.querySelector("#dice-close").addEventListener("click", () => document.querySelector("#dice-dialog").close());

function openDetails() {
  const hero = currentSnapshot?.kind === "table" ? currentSnapshot.myHero : null;
  if (!hero) return;
  document.querySelector("#detail-dialog > .eyebrow").textContent = t("activity.detail.character");
  document.querySelectorAll(".detail-private").forEach((element) => { element.hidden = false; });
  document.querySelector("#detail-name").textContent = hero.name;
  document.querySelector("#detail-subtitle").textContent = `${hero.raceName ?? t("activity.hero.adventurer")} ${classText(hero.className) ?? t("activity.hero.heroClass")} ${hero.level}`;
  document.querySelector("#detail-hp").textContent = `${hero.hp} / ${hero.maxHp}`;
  document.querySelector("#detail-ac").textContent = String(hero.armorClass);
  document.querySelector("#detail-gold").textContent = String(hero.gold + hero.partyGold);
  document.querySelector("#detail-spells").textContent = [...hero.cantrips, ...hero.prepared, ...hero.slots.map((slot) => t("activity.detail.levelSlots", slot)), ...hero.pactSlots.map((slot) => t("activity.detail.pactSlots", slot)), ...hero.uses.map((use) => t("activity.detail.uses", use))].join(", ") || t("activity.detail.emptySpells");
  const inventory = document.querySelector("#detail-inventory");
  inventory.replaceChildren();
  for (const item of hero.inventoryChoices ?? []) {
    const row = document.createElement("div");
    row.className = "detail-item-row";
    const label = document.createElement("span");
    label.textContent = `${item.name} ×${item.count}${item.worn ? t("activity.detail.equipped") : ""}`;
    row.append(label);
    if (item.wearable) {
      const wear = makeButton(t(item.worn ? "activity.action.remove" : "activity.action.equip"), () => {
        document.querySelector("#detail-dialog").close();
        void performAction({ kind: item.worn ? "removeItem" : "wearItem", itemId: item.id });
      });
      row.append(wear);
    }
    const stash = makeButton(t("activity.action.stash"), () => {
      document.querySelector("#detail-dialog").close();
      void performAction({ kind: "stashItem", itemId: item.id });
    });
    row.append(stash);
    inventory.append(row);
  }
  if (inventory.childElementCount === 0) inventory.textContent = t("activity.detail.emptyInventory");
  const stash = document.querySelector("#detail-stash");
  stash.replaceChildren();
  for (const item of hero.stash ?? []) {
    const row = document.createElement("div");
    row.className = "detail-item-row";
    const label = document.createElement("span");
    label.textContent = `${item.name} ×${item.count}`;
    row.append(label, makeButton(t("activity.action.take"), () => {
      document.querySelector("#detail-dialog").close();
      void performAction({ kind: "takeFromStash", itemId: item.id });
    }));
    stash.append(row);
  }
  if (stash.childElementCount === 0) stash.textContent = t("activity.detail.emptyStash");
  document.querySelector("#detail-dialog").showModal();
}

function openPublicDetails(hero) {
  document.querySelector("#detail-dialog > .eyebrow").textContent = t("activity.party.publicDetails");
  document.querySelectorAll(".detail-private").forEach((element) => { element.hidden = true; });
  document.querySelector("#detail-name").textContent = hero.name;
  document.querySelector("#detail-subtitle").textContent = `${hero.raceName ?? t("activity.hero.adventurer")} ${classText(hero.className) ?? t("activity.hero.heroClass")} ${hero.level ?? ""}`.trim();
  document.querySelector("#detail-hp").textContent = `${hero.hp} / ${hero.maxHp}`;
  document.querySelector("#detail-ac").textContent = hero.armorClass === null ? t("activity.detail.unknown") : String(hero.armorClass);
  document.querySelector("#detail-dialog").showModal();
}

document.querySelector("#back-to-lobby").addEventListener("click", () => {
  clearInterval(tableTimer);
  tableTimer = null;
  currentGameId = null;
  currentSnapshot = null;
  liveScreen.hidden = true;
  lobbyScreen.hidden = false;
  void setLanguage(discordLanguage).then(() => loadGames()).catch((error) => showError(error instanceof Error ? error.message : t("activity.status.couldNotLoad")));
});
document.querySelector("#lobby-retry").addEventListener("click", () => {
  errorElement.hidden = true;
  void authenticate().catch((error) => showError(error instanceof Error ? error.message : t("activity.connection.signInFailed")));
});

async function authenticate() {
  await setLanguage("en");
  connectionStage = "Activity setup";
  discordConnected = false;
  errorElement.hidden = true;
  userElement.textContent = t("activity.lobby.connectingDiscord");
  serverElement.textContent = t("activity.lobby.connectingDiscord");
  setMessage(t("activity.connection.connectingActivity"));
  const configResponse = await fetchWithTimeout("/activity-config.json", { cache: "no-store" });
  if (!configResponse.ok) throw new Error(t("activity.connection.activityConfig"));
  const config = await configResponse.json();
  if (typeof config.applicationId !== "string" || config.applicationId.length === 0) throw new Error(t("activity.connection.appId"));
  discordSdk = new DiscordSDK(config.applicationId);
  connectionStage = "Discord connection";
  setMessage(t("activity.connection.waitDiscord"));
  await withTimeout(discordSdk.ready(), 12000, t("activity.connection.discordTimeout"));
  const localeResult = await discordSdk.commands.userSettingsGetLocale().catch(() => ({ locale: "en" }));
  discordLanguage = languageFromDiscordLocale(localeResult.locale);
  await setLanguage(discordLanguage);
  discordConnected = true;
  // Let the picture-in-picture window take clicks; without this it only shows the table. A refusal must not stop the sign-in.
  void discordSdk.commands.setConfig({ use_interactive_pip: true }).catch((error) => console.warn("Interactive picture-in-picture was not enabled.", error));
  if (!discordSdk.guildId) throw new Error(t("activity.connection.guildRequired"));
  serverElement.textContent = t("activity.lobby.connected");
  connectionStage = "Discord authorization";
  setMessage(t("activity.connection.authStart"));
  const authorization = await withTimeout(discordSdk.commands.authorize({
    client_id: config.applicationId,
    response_type: "code",
    state: crypto.randomUUID(),
    prompt: "none",
    scope: ["identify", "guilds.members.read"],
  }), 20000, t("activity.connection.authTimeout"));
  connectionStage = "Account verification";
  setMessage(t("activity.connection.verify"));
  const session = await requestJson("/api/activity/session", {
    method: "POST",
    body: JSON.stringify({ code: authorization.code, guildId: discordSdk.guildId, channelId: discordSdk.channelId }),
  });
  sessionToken = session.session_token;
  if (typeof session.access_token !== "string" || typeof sessionToken !== "string") throw new Error(t("activity.connection.invalidSession"));
  const identity = await discordSdk.commands.authenticate({ access_token: session.access_token });
  userElement.textContent = identity.user.global_name || identity.user.username;
  serverElement.textContent = t("activity.connection.thisServer");
  connectionStage = "Loading games";
  if (typeof session.launchCampaignId === "string") await openGame(session.launchCampaignId);
  else await loadGames();
}

bindMapControls();

if (new URLSearchParams(window.location.search).has("design-preview")) {
  lobbyScreen.hidden = true;
  liveScreen.hidden = false;
  const preview = designPreviewSnapshot();
  currentSnapshot = preview;
  if (new URLSearchParams(window.location.search).has("roll")) {
    preview.mode = "awaitingRolls";
    preview.yourTurn = false;
    preview.activeName = null;
    preview.pendingRoll = { checkId: "preview-check", test: { kind: "skill", skill: "arcana" }, action: "Identify the runes before the sentinel moves." };
    preview.pendingRollCount = 1;
    preview.party = preview.party.map((hero) => ({ ...hero, tableStatus: "waiting" }));
  }
  const previewLanguage = new URLSearchParams(window.location.search).get("language") === "zh-TW" ? "zh-TW" : "en";
  void setLanguage(previewLanguage).then(() => renderGame(preview));
} else {
  void authenticate().catch((error) => {
    console.warn(`Discord Activity failed during ${connectionStage}.`, error);
    showError(error instanceof Error ? error.message : t("activity.connection.signInFailed"));
  });
}

function designPreviewSnapshot() {
  const hero = (characterId, name, className, raceName, hp, maxHp, isYou = false) => ({
    characterId, name, className, raceName, level: 5, hp, maxHp, armorClass: 15, presence: "present",
    down: false, fallen: false, conditions: [], isYou,
  });
  return {
    classNames: new URLSearchParams(window.location.search).get("language") === "zh-TW" ? { wizard: "法師", paladin: "聖騎士", ranger: "遊俠", rogue: "盜賊", cleric: "牧師", bard: "吟遊詩人" } : {},
    kind: "table", campaignId: "local-preview", campaignName: "The Lantern Company", adventureTitle: "Moonlit Ruins",
    mode: "combat", roundNumber: 4, scene: { title: "The Drowned Observatory", description: "Cold moonlight spills through the broken dome. Something stirs beneath the flooded floor.", imageUrl: null },
    map: new URLSearchParams(window.location.search).has("journey") ? { kind: "journey", nodes: [
      { id: "entrance", title: "The Old Hall", column: 0, row: 1, status: "visited", canTravel: false, deadEnd: false },
      { id: "current", title: "The Drowned Observatory", column: 1, row: 1, status: "current", canTravel: false, deadEnd: false },
      { id: "gallery", title: "Broken Gallery", column: 2, row: 0, status: "reachable", canTravel: true, deadEnd: false },
      { id: "vault", title: "The Lower Vault", column: 2, row: 1, status: "known", canTravel: false, deadEnd: false },
      { id: "sanctum", title: "Moonlit Sanctum", column: 2, row: 2, status: "reachable", canTravel: true, deadEnd: true },
      { id: "unknown", title: "???", column: 3, row: 1, status: "locked", canTravel: false, deadEnd: false },
    ], routes: [{ from: "entrance", to: "current", oneWay: false }, { from: "current", to: "gallery", oneWay: false }, { from: "current", to: "vault", oneWay: false }, { from: "current", to: "sanctum", oneWay: true }, { from: "vault", to: "unknown", oneWay: false }] } : { kind: "battlefield", edges: [{ from: "shattered-dais", to: "flooded-floor", feet: 30 }, { from: "flooded-floor", to: "broken-gallery", feet: 25 }], zones: [
      { id: "shattered-dais", name: "Shattered dais", lighting: "Moonlit", cover: "half", difficult: false, canMove: true, occupants: [{ name: "Aria", side: "party", active: true, hp: 27, maxHp: 34 }] },
      { id: "flooded-floor", name: "Flooded floor", lighting: "Dim", cover: null, difficult: true, canMove: false, occupants: [{ name: "Hollow Sentinel", side: "foes", active: true, hp: 18, maxHp: 36 }] },
      { id: "broken-gallery", name: "Broken gallery", lighting: "Dark", cover: "three-quarters", difficult: false, canMove: true, occupants: [{ name: "Thorne", side: "party", active: false, hp: 38, maxHp: 42 }] },
    ] },
    mapText: { journeyKind: "THE JOURNEY", journeyTitle: "Adventure map", tacticalKind: "TACTICAL VIEW", battlefield: "Battlefield", keyParty: "Party", keyFoes: "Foes", keyHere: "Here", keyOpen: "Open route", keyLocked: "Locked", empty: "No mapped routes are known yet.", routeLabel: "Route", here: "You are here", deadEnd: "Dead end", locked: "Locked", visited: "Visited", mapped: "Mapped", openRoute: "Open route", openGround: "Open ground", difficult: "Difficult terrain", coverHalf: "Half cover", coverThreeQuarters: "Three-quarters cover", lightBright: "Bright", lightDim: "Dim", lightDark: "Dark", moveHere: "Move here" },
    yourTurn: true, canBegin: false, activeName: "Aria Vell",
    party: [
      { ...hero("aria", "Aria Vell", "Wizard", "High Elf", 27, 34, true), tableStatus: "acting" },
      { ...hero("thorne", "Thorne Oakshield", "Paladin", "Hill Dwarf", 38, 42), tableStatus: "submitted" },
      { ...hero("mira", "Mira Fen", "Ranger", "Wood Elf", 22, 31), tableStatus: "submitted" },
      { ...hero("pip", "Pip Underbough", "Rogue", "Lightfoot Halfling", 19, 28), tableStatus: "waiting" },
      { ...hero("sable", "Sable Dusk", "Cleric", "Tiefling", 29, 33), tableStatus: "waiting" },
      { ...hero("kestrel", "Kestrel Vale", "Bard", "Human", 25, 30), tableStatus: "waiting" },
    ],
    foes: [{ name: "Hollow Sentinel", hp: 18, maxHp: 36, band: "bloodied", zone: "Flooded floor", active: false }],
    myHero: { ...hero("aria", "Aria Vell", "Wizard", "High Elf", 27, 34, true), imageUrl: null, gold: 18, partyGold: 42, weapons: ["Quarterstaff"], worn: ["Traveler's robe"], pack: [], stash: [], inventoryChoices: [], usablePotions: [], cantrips: ["Fire Bolt", "Ray of Frost"], prepared: ["Shield", "Magic Missile"], slots: [{ level: 1, left: 2, max: 3 }, { level: 2, left: 1, max: 2 }], pactSlots: [], uses: [] },
    turn: { busy: false, attacks: [{ weapon: "Quarterstaff", targets: [{ id: "sentinel", name: "Hollow Sentinel" }] }], spells: [], features: [], potions: [], shields: [], moves: [], engage: [], teleports: [], wildShapes: [], canRevertShape: false, canWithdraw: false, canDashOrDisengage: true, canDodge: true },
    explore: null, pendingRoll: null, pendingRollCount: 0, submittedCount: 2, participantCount: 6, submission: null, canAcceptInvite: false, joinChoices: [], joinRequestStatus: null,
    savedHeroChoices: [], reaction: null, reactionIsYours: false, smite: null, smiteIsYours: false, opportunityAttack: null, opportunityAttackIsYours: false,
  };
}
