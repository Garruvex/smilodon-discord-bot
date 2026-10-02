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
let tableRefreshFailures = 0;
let lastTableRefreshAt = 0;
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

const lifecycleKeys = { lobby: "activity.lobby.status.open", active: "activity.lobby.status.live", paused: "activity.lobby.status.paused" };
const actionKeys = { join: "activity.lobby.action.join", continue: "activity.lobby.action.continue", request: "activity.lobby.action.request", requested: "activity.lobby.action.requested", invited: "activity.lobby.action.invited", full: "activity.lobby.action.full", resume: "activity.lobby.action.continue" };
const phaseKeys = { opening: "activity.phase.opening", readyCheck: "activity.status.gathering", collecting: "activity.phase.collecting", planning: "activity.phase.planning", awaitingRolls: "activity.phase.awaitingRolls", combat: "activity.phase.combat", waiting: "activity.phase.waiting", paused: "activity.phase.paused", safety: "activity.phase.safety", recovery: "activity.phase.recovery", archived: "activity.phase.archived" };
const apiErrorKeys = {
  ...Object.fromEntries(["actionTooLong", "emptyAction", "invalidAction", "heroFallen", "moveDecisionPending", "roundNotCollecting", "memberAway", "campaignWaiting", "staleRound"].map((code) => [code, `activity.error.${code}`])),
  noOpenRound: "activity.error.roundNotCollecting",
  activityAuthNotConfigured: "activity.connection.signInConfig", discordAuthorizationFailed: "activity.connection.discordAuthorize",
  discordIdentityFailed: "activity.connection.discordIdentity", notInLaunchGuild: "activity.connection.guildRequired",
  privateInviteOnly: "activity.error.privateInvite", full: "activity.error.full", gameFull: "activity.error.gameFull",
  heroTaken: "activity.error.heroTaken", unknownHero: "activity.error.unknownHero", notReady: "activity.error.notReady",
  notEnoughPlayers: "activity.error.notEnoughPlayers", unauthorized: "activity.connection.sessionExpired",
  notActive: "activity.error.notActive", notMember: "activity.error.notMember", campaignPaused: "activity.error.campaignPaused", joinNotAtBreak: "activity.error.joinNotAtBreak",
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
  } catch (error) {
    console.warn("Picture request failed; showing the illustration fallback.", imageUrl, error);
  } finally {
    artworkPending.delete(imageUrl);
  }
}

function makeButton(label, onClick, primary = false, iconName = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `live-action-choice ui-control${primary ? " primary" : ""}`;
  if (iconName) button.append(iconImage(iconName));
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  button.addEventListener("click", onClick);
  return button;
}

function createGameCard(game) {
  const card = document.createElement("article");
  card.className = "lobby-card ui-card";
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
  action.className = "lobby-card-action ui-control";
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
  resetPaint();
  setTableConnectionState("connecting");
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
    tableRefreshFailures = 0;
    lastTableRefreshAt = Date.now();
    await setLanguage(currentSnapshot.language ?? uiLanguage);
    setTableConnectionState("live");
    renderGame(currentSnapshot);
  } catch (error) {
    tableRefreshFailures += 1;
    setTableConnectionState(tableRefreshFailures >= 3 || Date.now() - lastTableRefreshAt >= 15000 ? "offline" : "delayed");
    setLiveMessage(error instanceof Error ? error.message : t("activity.status.couldNotLoad"));
    if (error instanceof Error && error.message === apiErrorMessage("notActive")) {
      clearInterval(tableTimer);
      tableTimer = null;
    }
  } finally {
    loadingTable = false;
  }
}

function setTableConnectionState(state) {
  const dot = document.querySelector("#table-connection-dot");
  if (!dot) return;
  const key = ({ live: "activity.connection.live", delayed: "activity.connection.delayed", offline: "activity.connection.offline", connecting: "activity.connection.connecting" })[state] ?? "activity.connection.connecting";
  dot.dataset.state = state;
  dot.title = t(key);
  dot.setAttribute("aria-label", t(key));
}

// The table is fetched every few seconds. A fetch that brings nothing new repaints nothing, and a changed one repaints only the parts whose data changed.
let lastGameSignature = "";
const paintedSections = new Map();

function resetPaint() {
  lastGameSignature = "";
  actionsSignature = "";
  paintedSections.clear();
}

function paintSection(name, inputs, paint) {
  const signature = JSON.stringify(inputs);
  if (paintedSections.get(name) === signature) return;
  paint();
  paintedSections.set(name, signature);
}

function renderGame(game) {
  const signature = JSON.stringify([uiLanguage, game, selectedPartyCharacterId, selectedEnemyName, selectedWorkspaceTab, mapPick]);
  if (signature === lastGameSignature) return;
  paintGame(game);
  lastGameSignature = signature;
}

function paintGame(game) {
  classNames = game.classNames ?? {};
  document.querySelector("#live-campaign").textContent = game.campaignName;
  document.querySelector("#live-adventure").textContent = game.adventureTitle.toLocaleUpperCase();
  document.querySelector("#live-scene-title").textContent = game.kind === "lobby" ? t("activity.scene.chooseHero") : game.scene.title;
  document.querySelector("#live-scene-description").textContent = game.kind === "lobby"
    ? t("activity.scene.chooseHeroDescription")
    : game.scene.description;
  renderMoveNotice(game.kind === "table" ? game.pendingMove : null);
  document.querySelector(".live-scene").classList.toggle("has-enemies", game.kind === "table" && (game.foes?.length ?? 0) > 0);
  void setArtwork(document.querySelector("#live-scene-image"), document.querySelector(".scene-art-fallback"), game.kind === "table" ? game.scene.imageUrl : null, game.scene.title, true);
  if (game.kind === "lobby") {
    document.querySelector(".adventure-map-panel").hidden = true;
    renderLobby(game);
  } else {
    document.querySelector(".adventure-map-panel").hidden = false;
    paintSection("map", [game.map, game.mapText, mapPick, uiLanguage], () => renderMap(game.map, game.mapText));
    renderTable(game);
  }
}

// The scene change waiting for the table: where to, how many want to stay and how many are needed, and when the window closes.
let moveCountdown = null;

let movePainted = "";

function renderMoveNotice(move) {
  const notice = document.querySelector("#live-scene-move");
  const key = JSON.stringify([move, uiLanguage]);
  if (key === movePainted) return;
  movePainted = key;
  if (moveCountdown !== null) clearInterval(moveCountdown);
  moveCountdown = null;
  notice.hidden = !move;
  if (!move) {
    notice.replaceChildren();
    return;
  }
  const line = (className, text) => { const item = document.createElement("span"); item.className = className; item.textContent = text; return item; };
  const heading = line("move-heading", t("activity.move.heading", { scene: move.sceneTitle }));
  const tally = line("move-tally", t("activity.move.tally", { count: move.staying.length, present: move.present, needed: move.needed }));
  const names = move.staying.length ? line("move-names", t("activity.move.staying", { names: move.staying.join(", ") })) : null;
  const clock = line("move-clock", "");
  notice.replaceChildren(heading, line("move-paused", t("activity.move.paused")), tally, ...(names ? [names] : []), clock);
  const tick = () => {
    const left = Math.max(0, Math.ceil((move.closesAt - Date.now()) / 1000));
    clock.textContent = left === 0 ? t("activity.move.deciding") : t("activity.move.countdown", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` });
  };
  clock.hidden = move.closesAt === null;
  if (move.closesAt !== null) {
    tick();
    moveCountdown = setInterval(tick, 1000);
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

const svgNs = "http://www.w3.org/2000/svg";

function svgElement(name, attributes = {}, text = null) {
  const element = document.createElementNS(svgNs, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== null) element.textContent = text;
  return element;
}

// Wide characters (Chinese) take about twice the room of Latin ones, so a name's box is sized from its letters.
function labelWidth(text, size = 13) {
  return [...text].reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? size * 1.05 : size * .56), 0);
}

function clipLabel(text, size, limit) {
  if (labelWidth(text, size) <= limit) return text;
  let shown = "";
  for (const character of text) {
    if (labelWidth(`${shown}${character}…`, size) > limit) break;
    shown += character;
  }
  return `${shown}…`;
}

// Where a line from one box's centre toward another leaves the first box's edge.
function edgePoint(from, toward, halfWidth, halfHeight) {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (dx === 0 && dy === 0) return { ...from };
  const scale = Math.min(dx === 0 ? Infinity : halfWidth / Math.abs(dx), dy === 0 ? Infinity : halfHeight / Math.abs(dy));
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

// Moving is a choice made in two steps: the button turns on "pick a place", the map shows where the party may go, and one click on it sends the move.
let mapPick = false;

function setMapPick(on) {
  mapPick = on;
  if (currentSnapshot?.kind === "table") renderMap(currentSnapshot.map, currentSnapshot.mapText);
}

function updateMapGo(targetCount) {
  if (targetCount === 0) mapPick = false;
  const button = document.querySelector("#map-go");
  const hint = document.querySelector("#map-go-hint");
  button.hidden = targetCount === 0;
  document.querySelector("#map-toolbar").hidden = targetCount === 0;
  button.textContent = t(mapPick ? "activity.map.goCancel" : "activity.map.go");
  button.setAttribute("aria-pressed", String(mapPick));
  hint.hidden = !mapPick;
  hint.textContent = t("activity.map.goHint");
}

function renderMap(map, words) {
  liveMap.replaceChildren();
  const mapPanel = document.querySelector(".adventure-map-panel");
  const mapKind = map.kind === "battlefield" ? "battlefield" : "journey";
  if (mapPanel.dataset.mapKind !== mapKind) {
    mapPanel.open = true;
    mapPanel.dataset.mapKind = mapKind;
    mapPick = false;
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

function renderJourneyMap(map, words) {
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
    const pickable = mapPick && node.canTravel === true;
    const group = svgElement("g", { class: `jr-node ${node.status}${currentSnapshot?.pendingMove?.sceneId === node.id ? " is-heading" : ""}${pickable ? " is-target" : ""}${mapPick && !pickable && node.status !== "current" ? " is-dim" : ""}` });
    if (pickable) {
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `${node.title}. ${words.moveHere}`);
      const go = () => { mapPick = false; void performAction({ kind: "moveScene", sceneId: node.id }); };
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

function renderBattlefieldMap(map, words) {
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
    const pickable = mapPick && zone.canMove === true;
    const group = svgElement("g", { class: `bf-zone${active ? " has-active" : ""}${hasFoe ? " has-foe" : ""}${pickable ? " is-target" : ""}${mapPick && !pickable && !active ? " is-dim" : ""}` });
    group.setAttribute("aria-label", `${zone.name}${zone.occupants.length ? `: ${zone.occupants.map((occupant) => occupant.name).join(", ")}` : ""}`);
    if (pickable) {
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `${zone.name}. ${words.moveHere}`);
      const go = () => { mapPick = false; void performAction({ kind: "move", zoneId: zone.id }); };
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
      token.append(svgElement("circle", { cx, cy: top + 70, r: 16 }), svgElement("text", { x: cx, y: top + 75, class: "bf-initial" }, [...occupant.name][0]?.toLocaleUpperCase() ?? "?"));
      group.append(token);
    });
    if (zone.occupants.length > shown.length) group.append(svgElement("text", { x: left + zoneWidth - 14, y: top + 75, class: "bf-more", "text-anchor": "end" }, `+${zone.occupants.length - shown.length}`));
    const footer = pickable ? words.moveHere : zone.occupants.map((occupant) => occupant.name).join(", ");
    if (footer) group.append(svgElement("text", { x: point.x, y: top + 105, class: pickable ? "bf-go" : "bf-names" }, clipLabel(footer, 10, zoneWidth - 20)));
    svg.append(group);
  }
  return svg;
}

function prepareMapView(kind, svg) {
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
  // A map smaller than the window sits in the middle of it; a larger one can be dragged but not off its edges.
  const spareX = viewport.clientWidth - svg.clientWidth;
  const spareY = viewport.clientHeight - svg.clientHeight;
  mapOffset.x = spareX >= 0 ? spareX / 2 : Math.max(spareX, Math.min(0, mapOffset.x));
  mapOffset.y = spareY >= 0 ? spareY / 2 : Math.max(spareY, Math.min(0, mapOffset.y));
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
  mapScale = Math.min(1.5, (viewport.clientWidth - 24) / mapBaseSize.width, (viewport.clientHeight - 24) / mapBaseSize.height);
  mapScale = Math.max(.2, mapScale);
  mapOffset = { x: 0, y: 0 };
  applyMapScale({ x: 0, y: 0 }, previousScale);
}

// The map can always be zoomed (wheel or pinch) and dragged; a double click fits it to the window again.
const mapPointers = new Map();
let mapDrag = null;
let pinchStart = null;
let suppressMapClick = false;

function bindMapControls() {
  const viewport = document.querySelector("#live-map-viewport");
  document.querySelector("#map-go").addEventListener("click", () => setMapPick(!mapPick));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && mapPick) setMapPick(false); });
  // The map always fits its window to begin with, so it is refitted whenever the window changes size.
  new ResizeObserver(() => { if (mapBaseSize) fitMap(); }).observe(viewport);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoomMap(event.deltaY < 0 ? .12 : -.12, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  viewport.addEventListener("dblclick", fitMap);
  viewport.addEventListener("pointerdown", (event) => {
    suppressMapClick = false;
    mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (mapPointers.size === 2) {
      const points = [...mapPointers.values()];
      pinchStart = { distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), scale: mapScale };
      mapDrag = null;
      return;
    }
    if (event.button !== 0) return;
    mapDrag = { x: event.clientX, y: event.clientY, left: mapOffset.x, top: mapOffset.y, moved: false };
  });
  // Listening on the window (not capturing the pointer) keeps a plain click reaching the place that was clicked.
  window.addEventListener("pointermove", (event) => {
    if (!mapPointers.has(event.pointerId)) return;
    mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (mapPointers.size >= 2 && pinchStart) {
      const points = [...mapPointers.values()];
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (pinchStart.distance > 0 && distance > 0) {
        const previousScale = mapScale;
        mapScale = Math.max(.35, Math.min(2.5, pinchStart.scale * distance / pinchStart.distance));
        const rect = viewport.getBoundingClientRect();
        applyMapScale({ x: (points[0].x + points[1].x) / 2 - rect.left, y: (points[0].y + points[1].y) / 2 - rect.top }, previousScale);
      }
      return;
    }
    if (!mapDrag) return;
    const dx = event.clientX - mapDrag.x;
    const dy = event.clientY - mapDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) mapDrag.moved = true;
    if (mapDrag.moved) { mapOffset.x = mapDrag.left + dx; mapOffset.y = mapDrag.top + dy; applyMapOffset(); }
  });
  const finishPointer = (event) => {
    if (mapDrag?.moved) suppressMapClick = true;
    mapPointers.delete(event.pointerId);
    if (mapPointers.size < 2) pinchStart = null;
    mapDrag = null;
  };
  window.addEventListener("pointerup", finishPointer);
  window.addEventListener("pointercancel", finishPointer);
  // A drag that ends over a place is not a click on it.
  viewport.addEventListener("click", (event) => {
    if (!suppressMapClick) return;
    suppressMapClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function renderLobby(game) {
  document.querySelector("#hero-workspace-tabs").hidden = true;
  document.querySelectorAll(".hero-tab-panel").forEach((panel) => { panel.hidden = panel.id !== "hero-panel-actions"; });
  document.querySelector("#live-phase").textContent = t("activity.status.openTable");
  document.querySelector("#live-round").textContent = t("activity.status.seats", { count: game.playerCount, max: game.maxPlayers });
  document.querySelector(".live-phase").dataset.mode = "lobby";
  document.querySelector("#live-turn").textContent = game.selectedHeroId ? t("activity.hero.ready") : t("activity.status.chooseHero");
  document.querySelector("#live-turn").classList.remove("is-active");
  document.querySelector("#live-hero-name").textContent = game.selectedHeroName ?? t("activity.hero.name");
  document.querySelector("#live-hero-subtitle").textContent = classText(game.selectedHeroClass) ?? t("activity.hero.chooseAvailable");
  document.querySelector("#live-hero-hp").textContent = t("activity.hero.preGame");
  document.querySelector("#live-hero-ac").textContent = "";
  updateHealthMeter(0, 1);
  document.querySelector("#member-overview").hidden = true;
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
  document.querySelector("#live-screen").dataset.mode = game.mode;
  renderCombatTurn(game);
  const turn = document.querySelector("#live-turn");
  const ownStatus = game.submission === "action" ? t("activity.status.actionSubmitted") : game.submission === "pass" ? t("activity.status.passedRound") : game.pendingRoll ? t("activity.status.rollNeeded") : t("activity.status.waitTurn");
  turn.textContent = game.pendingMove ? t("activity.status.moveDecision") : game.yourTurn ? game.turn?.busy ? t("activity.status.resolvingAction") : t("activity.hero.turn") : game.mode === "collecting" && game.myHero ? ownStatus : game.activeName ? t("activity.status.activeTurnPossessive", { name: game.activeName }) : t("activity.status.waitTable");
  turn.classList.toggle("is-active", game.yourTurn);
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
  paintSection("enemies", [game.foes, selectedEnemyName, uiLanguage], () => renderEnemies(game.foes));
  paintSection("party", [game.party, selectedPartyCharacterId, selectedEnemyName, uiLanguage], () => renderParty(game.party));
  setLiveMessage(game.submission === "action" ? t("activity.status.actionIn") : game.submission === "pass" ? t("activity.status.youPassed") : "");
  updateRollPrompt(["paused", "safety", "recovery"].includes(game.mode) ? null : game.pendingRoll);
}

function renderCombatTurn(game) {
  const strip = document.querySelector("#combat-turn-strip");
  const visible = game.mode === "combat";
  strip.hidden = !visible;
  if (!visible) return;
  document.querySelector("#combat-active-name").textContent = game.activeName ?? t("activity.phase.waiting");
  const upcoming = document.querySelector("#combat-upcoming");
  upcoming.replaceChildren(...(game.upcomingNames ?? []).slice(0, 1).map((name, index) => {
    const item = document.createElement("span");
    item.className = "initiative-next-name";
    item.dataset.position = String(index + 1);
    item.textContent = name;
    return item;
  }));
  if (!upcoming.childElementCount) upcoming.textContent = t("activity.combat.noUpcoming");
}

function makeEnemy(enemy) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `live-party-card live-enemy ui-card${enemy.active ? " is-active" : ""}${enemy.name === selectedEnemyName ? " is-selected" : ""}`;
  card.classList.toggle("is-active", enemy.active);
  const hpText = t("activity.hero.enemyHealth", { hp: enemy.hp, max: enemy.maxHp, band: t(`activity.band.${enemy.band}`), zone: enemy.zone });
  card.setAttribute("aria-label", `${enemy.name}. ${hpText}`);
  card.setAttribute("aria-pressed", String(enemy.name === selectedEnemyName));
  card.addEventListener("click", () => { selectedEnemyName = enemy.name; if (currentSnapshot?.kind === "table") { renderParty(currentSnapshot.party); renderCharacterWorkspace(currentSnapshot); renderEnemies(currentSnapshot.foes); } });
  const sigil = document.createElement("span"); sigil.className = "live-party-sigil enemy-sigil"; sigil.setAttribute("aria-hidden", "true");
  sigil.append(iconImage("attack")); card.append(sigil);
  const copy = document.createElement("span"); copy.className = "live-party-copy enemy-copy";
  const name = document.createElement("strong");
  name.textContent = enemy.name;
  const health = document.createElement("span");
  health.textContent = hpText;
  const track = document.createElement("span");
  track.className = "party-health live-party-health ui-meter";
  const fill = document.createElement("i");
  fill.style.width = `${enemy.maxHp > 0 ? Math.max(0, Math.min(100, Math.round((enemy.hp / enemy.maxHp) * 100))) : 0}%`;
  track.append(fill);
  copy.append(name, health);
  card.append(copy);
  if (enemy.active) {
    const turn = document.createElement("span");
    turn.className = "live-party-status ui-status enemy-turn-label";
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
    card.className = `live-party-card ui-card${hero.isYou ? " is-you" : ""}${!selectedEnemyName && hero.characterId === selectedPartyCharacterId ? " is-selected" : ""}`;
    card.dataset.status = hero.tableStatus ?? (hero.presence === "away" ? "away" : "waiting");
    card.dataset.presence = hero.presence ?? "present";
    card.dataset.condition = hero.fallen ? "dead" : hero.down ? "down" : "healthy";
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
    const nameLine = document.createElement("span");
    nameLine.className = "party-name-line";
    const name = document.createElement("strong");
    name.textContent = hero.name;
    if (hero.isYou) {
      const you = document.createElement("small");
      you.textContent = t("activity.party.you");
      name.append(you);
    }
    const status = document.createElement("span");
    status.className = "live-party-status party-status-icon";
    const statusText = partyStatusText(hero);
    status.title = statusText;
    status.setAttribute("aria-label", statusText);
    status.setAttribute("role", "img");
    status.dataset.status = hero.tableStatus ?? (hero.presence === "away" ? "away" : "waiting");
    status.append(iconImage(partyStatusIcon(hero)));
    nameLine.append(name, status);
    const subtitle = document.createElement("span");
    subtitle.className = "party-class-line";
    const kind = `${hero.raceName ?? ""} ${classText(hero.className) ?? t("activity.hero.heroClass")}`.trim();
    if (hero.level === null) subtitle.textContent = classText(hero.className) ?? t(`activity.party.presence.${hero.presence}`);
    else {
      // The class and the level each get a line, so neither needs a separator and a long class name has the whole width.
      const line = (text) => Object.assign(document.createElement("span"), { textContent: text, title: text });
      subtitle.replaceChildren(line(kind), line(`${t("activity.detail.level")} ${hero.level}`));
    }
    copy.append(nameLine, subtitle);
    const meta = document.createElement("span");
    meta.className = "party-meta-line";
    if (hero.hp !== null && hero.maxHp !== null) {
      const bar = document.createElement("span");
      bar.className = "party-health live-party-health ui-meter";
      const fill = document.createElement("i");
      const percent = hero.maxHp > 0 ? Math.max(0, Math.min(100, Math.round((hero.hp / hero.maxHp) * 100))) : 0;
      fill.style.width = `${percent}%`;
      bar.dataset.health = percent > 60 ? "good" : percent > 30 ? "hurt" : "low";
      bar.append(fill);
      meta.append(bar);
      const hp = document.createElement("span");
      hp.className = "party-hp-label";
      hp.textContent = t("activity.hero.hp", { hp: hero.hp, max: hero.maxHp });
      meta.append(hp);
    } else {
      const presence = document.createElement("span");
      presence.className = "party-hp-label";
      presence.textContent = hero.presence === "ready" ? t("activity.party.characterSelected") : t("activity.party.choosingCharacter");
      meta.append(presence);
    }
    copy.append(meta);
    card.append(sigil, copy);
    if (hero.presence === "away" || hero.fallen || hero.down) {
      const condition = document.createElement("span");
      condition.className = "party-condition-overlay";
      condition.textContent = hero.presence === "away" ? t("activity.party.offline") : hero.fallen ? t("activity.party.dead") : t("activity.party.down");
      card.append(condition);
    }
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

function populateMemberOverview(profile, status, conditions = [], customEntries = null) {
  const overview = document.querySelector("#member-overview");
  overview.hidden = false;
  // Level is in the subtitle and the turn is in the header and the party tile, so a hero has no stat tiles of its own here.
  const entries = customEntries ?? [];
  const stats = document.querySelector("#member-overview-stats");
  stats.replaceChildren(...entries.map(([label, value, icon]) => {
    const card = document.createElement("div"); card.className = "member-stat";
    const heading = document.createElement("span"); heading.className = "member-stat-label"; heading.append(iconImage(icon), document.createTextNode(t(label)));
    const amount = document.createElement("strong"); amount.textContent = value;
    card.append(heading, amount);
    return card;
  }));
  const conditionList = document.querySelector("#member-overview-conditions");
  conditionList.replaceChildren();
  stats.hidden = entries.length === 0;
  document.querySelector("#member-overview .member-condition-block").hidden = customEntries !== null;
  const stateBadge = document.querySelector("#member-condition-state");
  const state = customEntries === null
    ? profile?.fallen ? "fallen" : profile?.down ? "down" : profile?.presence === "away" ? "away" : "clear"
    : null;
  stateBadge.hidden = state === null || state === "clear";
  stateBadge.dataset.state = state ?? "";
  stateBadge.textContent = state === "fallen" ? t("activity.party.dead") : state === "down" ? t("activity.party.down") : state === "away" ? t("activity.party.offline") : "";
  if (conditions.length === 0 && state === "clear" && customEntries === null) {
    conditionList.textContent = t("activity.party.noConditions");
  } else {
    for (const condition of conditions) {
      const chip = document.createElement("span"); chip.className = "member-condition"; chip.textContent = condition; conditionList.append(chip);
    }
  }
}

function updateHealthMeter(hp, maxHp) {
  const health = document.querySelector("#live-hero-health");
  const meter = document.querySelector("#live-hero-health-meter");
  const safeMax = Math.max(1, maxHp);
  const current = Math.max(0, Math.min(safeMax, hp));
  const percent = Math.round(current / safeMax * 100);
  health.style.width = `${percent}%`;
  health.dataset.health = percent > 60 ? "healthy" : percent > 30 ? "wounded" : "critical";
  meter.setAttribute("aria-valuemax", String(safeMax));
  meter.setAttribute("aria-valuenow", String(current));
  meter.setAttribute("aria-valuetext", t("activity.hero.hp", { hp: current, max: safeMax }));
}

function partyStatusText(hero) {
  if (hero.fallen) return t("activity.party.dead");
  if (hero.down) return t("activity.party.down");
  if (hero.presence === "away") return t("activity.party.presence.away");
  const statusWords = { acting: t("activity.party.turnNow"), submitted: hero.presence === "ready" ? t("activity.party.ready") : t("activity.party.actionIn"), passed: t("activity.party.passed"), missed: t("activity.party.missed"), away: t("activity.party.away"), waiting: t("activity.party.waiting") };
  return statusWords[hero.tableStatus] ?? statusWords.waiting;
}

function partyStatusIcon(hero) {
  if (hero.fallen) return "hazard";
  if (hero.down) return "heal";
  if (hero.presence === "away") return "notice";
  const status = hero.tableStatus ?? (hero.presence === "away" ? "away" : "waiting");
  return ({ acting: "attack", submitted: "reward", passed: "pause", missed: "hazard", away: "notice", waiting: "rest" })[status] ?? "rest";
}

function setWorkspaceTabs(game, tabs) {
  const tablist = document.querySelector("#hero-workspace-tabs");
  tablist.hidden = false;
  tablist.replaceChildren(...tabs.map(([id, key]) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "ui-control"; button.role = "tab";
    button.id = `hero-tab-${id}`; button.setAttribute("aria-selected", String(selectedWorkspaceTab === id));
    button.setAttribute("aria-controls", `hero-panel-${id}`); button.tabIndex = selectedWorkspaceTab === id ? 0 : -1;
    button.textContent = t(key); button.addEventListener("click", () => { selectedWorkspaceTab = id; renderCharacterWorkspace(game); });
    return button;
  }));
  for (const id of ["overview", "actions", "spells", "inventory", "trade"]) {
    const panel = document.querySelector(`#hero-panel-${id}`);
    panel.hidden = !tabs.some(([tabId]) => tabId === id) || selectedWorkspaceTab !== id;
  }
}

function renderCharacterWorkspace(game) {
  document.querySelector("#hero-panel-actions").append(liveActions);
  const enemy = game.foes.find((foe) => foe.name === selectedEnemyName);
  if (enemy) {
    document.querySelector("#live-turn").textContent = enemy.active ? t("activity.party.turnNow") : "";
    document.querySelector("#live-turn").classList.toggle("is-active", enemy.active);
    document.querySelector("#hero-workspace-label").textContent = t("activity.scene.encounter");
    document.querySelector("#live-hero-name").textContent = enemy.name;
    document.querySelector("#live-hero-subtitle").textContent = enemy.zone;
    document.querySelector("#live-hero-class").textContent = enemy.band;
    setHeroWatermark(null);
    document.querySelector("#live-hero-hp").textContent = t("activity.hero.hp", { hp: enemy.hp, max: enemy.maxHp });
    document.querySelector("#live-hero-ac").textContent = "";
    updateHealthMeter(enemy.hp, enemy.maxHp);
    const sigil = document.querySelector("#live-hero-sigil"); sigil.replaceChildren(iconImage("attack"));
    void setArtwork(document.querySelector("#live-hero-image"), sigil, null, enemy.name);
    const enemyTabs = game.myHero ? [["overview", "activity.tab.overview"], ["actions", "activity.tab.myActions"]] : [["overview", "activity.tab.overview"]];
    if (!enemyTabs.some(([id]) => id === selectedWorkspaceTab)) selectedWorkspaceTab = "overview";
    setWorkspaceTabs(game, enemyTabs);
    populateMemberOverview(null, null, [], [
      ["activity.detail.location", enemy.zone, "move"],
      ["activity.detail.status", enemy.active ? t("activity.party.turnNow") : t("activity.party.waiting"), "notice"],
    ]);
    const enemyConditions = document.querySelector("#member-overview-conditions");
    enemyConditions.replaceChildren();
    document.querySelector("#member-overview").hidden = false;
    document.querySelector("#live-resources").replaceChildren();
    document.querySelector("#live-equipment").replaceChildren();
    if (!game.myHero) document.querySelector("#hero-panel-overview").hidden = false;
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
  const profile = viewingOwn ? ownHero : selected;
  if (!profile) return;
  const turnLabel = document.querySelector("#live-turn");
  turnLabel.classList.toggle("is-active", selected.tableStatus === "acting");
  turnLabel.textContent = selected.tableStatus === "acting" && viewingOwn ? t("activity.hero.turn") : partyStatusText(selected);
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
  updateHealthMeter(profile.hp, profile.maxHp);
  populateMemberOverview(selected, partyStatusText(selected), selected.conditions ?? []);

  const tabs = viewingOwn
    ? [["overview", "activity.tab.overview"], ["actions", "activity.tab.actions"], ["spells", "activity.tab.spells"], ["inventory", "activity.tab.inventory"], ["trade", "activity.tab.trade"]]
    : ownHero
      ? [["overview", "activity.tab.overview"], ["actions", "activity.tab.myActions"], ["trade", "activity.tab.trade"]]
      : [["overview", "activity.tab.overview"], ["trade", "activity.tab.trade"]];
  if (!tabs.some(([id]) => id === selectedWorkspaceTab)) selectedWorkspaceTab = viewingOwn ? "actions" : "overview";
  setWorkspaceTabs(game, tabs);

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
    resources.replaceChildren();
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
const actionPlacement = { acceptInvite: "top", joinHero: "top", reaction: "top", smite: "top", opportunityAttack: "top", ready: "top", begin: "top", continue: "top", toggleMoveObjection: "top", submit: "composer", pass: "composer", endTurn: "bottom" };
const actionCategoryOf = { attack: "attack", combatSpell: "spells", exploreSpell: "spells", healSpell: "spells", reviveSpell: "spells", summonCompanion: "spells", move: "move", moveScene: "move", teleport: "move", engage: "move", withdraw: "move", dash: "move", useItem: "items", combatItem: "items", shield: "items", shop: "items", askNpc: "talk", pressNpc: "talk", feature: "other", wildShape: "other", combatDodge: "other" };
const actionCategoryOrder = ["attack", "spells", "move", "items", "talk", "other"];
const actionCategoryIcon = { attack: "attack", spells: "spell", move: "move", items: "potion", talk: "clue", other: "shape" };
let selectedActionCategory = null;
const drafts = { action: "", ask: "", say: "" };

function draftInput(element, draftKey, label, placeholder) {
  element.className = "live-action-input";
  element.placeholder = placeholder;
  element.setAttribute("aria-label", label);
  element.value = drafts[draftKey];
  element.addEventListener("input", () => { drafts[draftKey] = element.value; });
  return element;
}

// In-character words: they tell the table and the DM, use no action, and work in a fight too.
function speechRow(game) {
  if (!game.myHero || !["collecting", "combat"].includes(game.mode)) return null;
  const input = draftInput(document.createElement("input"), "say", t("activity.action.say"), t("activity.action.sayPlaceholder"));
  input.maxLength = 300;
  const send = () => {
    const text = input.value.trim();
    if (text.length === 0) return;
    drafts.say = "";
    input.value = "";
    void performAction({ kind: "speak", text });
  };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); send(); } });
  const row = document.createElement("div");
  row.className = "action-speech";
  row.append(input, makeButton(t("activity.action.say"), send, false, "notice"));
  return row;
}

// The action panel is built off to the side and swapped in only when it differs from what is showing. Rebuilding an identical panel would
// take focus out of the text box mid-sentence and swallow a click that started on the old button; a real change keeps the caret.
let actionsSignature = "";

function renderTableActions(game) {
  const next = document.createElement("div");
  const log = [];
  buildTableActions(game, next, log);
  const signature = next.innerHTML + JSON.stringify(log);
  if (signature === actionsSignature && liveActions.childElementCount > 0) return;
  actionsSignature = signature;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && liveActions.contains(active) && active.getAttribute("aria-label")
    ? { label: active.getAttribute("aria-label"), start: active.selectionStart, end: active.selectionEnd }
    : null;
  liveActions.replaceChildren(...next.childNodes);
  if (focused === null) return;
  const again = [...liveActions.querySelectorAll("[aria-label]")].find((element) => element.getAttribute("aria-label") === focused.label);
  if (!(again instanceof HTMLElement)) return;
  again.focus({ preventScroll: true });
  if (focused.start !== null && "setSelectionRange" in again) again.setSelectionRange(focused.start, focused.end);
}

function buildTableActions(game, liveActions, log) {
  liveActions.replaceChildren();
  if (["paused", "safety", "recovery"].includes(game.mode)) {
    if (game.canBegin) liveActions.append(makeButton(t("activity.action.resumeGame"), () => void performAction({ kind: "continue" }), true, "play"));
    else {
      const note = document.createElement("span");
      note.className = "live-action-note status-note";
      note.textContent = t("activity.status.paused");
      liveActions.append(note);
    }
    return;
  }
  const top = [], composer = [], bottom = [];
  const groups = new Map(actionCategoryOrder.map((category) => [category, []]));
  const addAction = (label, action, primary = false) => {
    log.push(JSON.stringify(action));
    const button = makeButton(label, () => void performAction(action), primary, actionIcon[action.kind] ?? "notice");
    const place = actionPlacement[action.kind];
    (place === "top" ? top : place === "composer" ? composer : place === "bottom" ? bottom : groups.get(actionCategoryOf[action.kind] ?? "other")).push(button);
  };
  if (game.pendingMove && game.mode === "collecting") {
    const label = t(game.pendingMove.stayingByYou ? "activity.move.withdrawStay" : "activity.move.stayHere");
    addAction(label, { kind: "toggleMoveObjection" }, true);
    const voteRow = document.createElement("div");
    voteRow.className = "action-row action-urgent";
    voteRow.append(...top);
    liveActions.append(voteRow);
    const voteSpeech = speechRow(game);
    if (voteSpeech) liveActions.append(voteSpeech);
    return;
  }
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
    input.maxLength = 300;
    input.rows = 2;
    composer.push(input);
    composer.push(makeButton(t("activity.action.say"), () => {
      const text = input.value.trim();
      if (!text) return;
      drafts.action = "";
      input.value = "";
      void performAction({ kind: "speak", text });
    }, false, "notice"));
    addAction(t("activity.action.takeAction"), { kind: "submit", text: () => input.value }, true);
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
  const speech = game.mode === "collecting" && game.submission === null ? null : speechRow(game);
  if (speech) liveActions.append(speech);
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
  const diceDescription = document.querySelector("#dice-description");
  diceDescription.textContent = "";
  diceDescription.hidden = true;
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
  document.querySelector("#dice-description").hidden = false;
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
  resetPaint();
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
  const previewLanguage = new URLSearchParams(window.location.search).get("language") === "zh-TW" ? "zh-TW" : "en";
  currentSnapshot = preview;
  if (new URLSearchParams(window.location.search).has("state-preview")) {
    const effects = previewLanguage === "zh-TW" ? ["專注", "祝福"] : ["Concentrating", "Blessed"];
    preview.party = preview.party.map((hero) => hero.characterId === "aria" ? { ...hero, hp: 21, conditions: effects } : hero);
    preview.myHero = { ...preview.myHero, hp: 21, conditions: effects };
  }
  if (new URLSearchParams(window.location.search).has("down-preview")) {
    preview.party = preview.party.map((hero) => hero.characterId === "aria" ? { ...hero, hp: 0, down: true, conditions: [] } : hero);
    preview.myHero = { ...preview.myHero, hp: 0, conditions: [] };
  }
  if (new URLSearchParams(window.location.search).has("member-preview")) {
    selectedPartyCharacterId = "thorne";
    selectedWorkspaceTab = "overview";
  }
  if (new URLSearchParams(window.location.search).has("party-states")) {
    preview.party = preview.party.map((hero) => hero.characterId === "pip" ? { ...hero, presence: "away" }
      : hero.characterId === "sable" ? { ...hero, hp: 0, down: true }
        : hero.characterId === "kestrel" ? { ...hero, hp: 0, fallen: true }
          : hero);
  }
  if (new URLSearchParams(window.location.search).has("roll")) {
    preview.mode = "awaitingRolls";
    preview.yourTurn = false;
    preview.activeName = null;
    preview.pendingRoll = { checkId: "preview-check", test: { kind: "skill", skill: "arcana" }, action: "Identify the runes before the sentinel moves." };
    preview.pendingRollCount = 1;
    preview.party = preview.party.map((hero) => ({ ...hero, tableStatus: "waiting" }));
  }
  if (new URLSearchParams(window.location.search).has("vote") || new URLSearchParams(window.location.search).has("collect")) {
    preview.mode = "collecting";
    preview.yourTurn = false;
    preview.activeName = null;
    preview.foes = [];
    preview.turn = null;
    if (new URLSearchParams(window.location.search).has("vote")) preview.pendingMove = { sceneId: "gallery", present: 6, needed: 3, closesAt: Date.now() + 83000, sceneTitle: "Broken Gallery", staying: ["Thorne Oakshield"], stayingByYou: new URLSearchParams(window.location.search).has("stay") };
  }
  void setLanguage(previewLanguage).then(() => { setTableConnectionState("live"); renderGame(preview); });
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
    yourTurn: true, canBegin: false, activeName: "Aria Vell", upcomingNames: ["Hollow Sentinel", "Thorne Oakshield", "Mira Fen"],
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
