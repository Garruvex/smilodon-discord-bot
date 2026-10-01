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

const lifecycleLabels = { lobby: "Open lobby", active: "Live game", paused: "On a break" };
const actionLabels = { join: "Join game", continue: "Open table", request: "Request to join", requested: "Request sent", invited: "Open invitation", full: "Table full", resume: "Open table" };
const phaseLabels = { opening: "Opening scene", readyCheck: "Gathering the party", collecting: "Your action", planning: "The story unfolds", awaitingRolls: "Waiting on rolls", combat: "Combat", waiting: "Waiting for players", paused: "Paused", safety: "Safety pause", recovery: "Recovering", archived: "Ended" };

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
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("The Activity server did not respond in time. Check that the bot and tunnel are running.");
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
    ? "Could not connect to Discord"
    : connectionStage === "Discord authorization"
      ? "Could not sign in to Discord"
      : connectionStage === "Account verification"
        ? "Could not verify your Discord account"
        : "Could not load your games";
  errorMessageElement.textContent = error;
  userElement.textContent = "Connection needs attention";
  serverElement.textContent = discordConnected ? "Discord connected" : "Connecting to Discord";
  setMessage("");
}

function apiErrorMessage(code) {
  const messages = {
    activityAuthNotConfigured: "This Activity is missing its Discord sign-in configuration.",
    discordAuthorizationFailed: "Discord could not authorize this Activity. Close it and open it again.",
    discordIdentityFailed: "Discord could not confirm your account.",
    notInLaunchGuild: "Open this Activity in a server where you are a member.",
    privateInviteOnly: "This campaign is private. Ask its organizer for an invitation.",
    full: "This lobby is full.",
    gameFull: "This game has no open seats.",
    heroTaken: "That hero was just chosen by another player.",
    unknownHero: "That hero is not available for this adventure.",
    notReady: "Every player needs to choose a hero before the game can start.",
    notEnoughPlayers: "The lobby needs more players before it can start.",
    unauthorized: "Your Activity session expired. Close it and open it again.",
    notActive: "This game has not started yet.",
    notMember: "Join the campaign before taking a game action.",
    joinNotAtBreak: "The party can welcome a new hero between encounters.",
    joinNotApproved: "The organizer has not approved this invitation yet.",
    notYourTurn: "It is not your turn anymore. The game has been refreshed.",
    invalidAction: "That action is not available right now.",
  };
  return messages[code] ?? "The request could not be completed. Try again in a moment.";
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (sessionToken !== null) headers.set("Authorization", `Bearer ${sessionToken}`);
  const response = await fetchWithTimeout(url, { ...options, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? apiErrorMessage(payload.error) : `The Activity server returned an unexpected response (${response.status}). Check the tunnel route and bot logs.`);
  return payload;
}

function makeButton(label, onClick, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `live-action-choice${primary ? " primary" : ""}`;
  button.textContent = label;
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
  status.textContent = lifecycleLabels[game.lifecycle] ?? "Campaign";
  const title = document.createElement("h3");
  title.textContent = game.name;
  const adventure = document.createElement("p");
  adventure.className = "lobby-card-adventure";
  adventure.textContent = game.adventureTitle;
  const players = document.createElement("p");
  players.className = "lobby-card-players";
  players.textContent = `${game.playerCount} / ${game.maxPlayers} players`;
  copy.append(status, title, adventure, players);
  const action = document.createElement("button");
  action.className = "lobby-card-action";
  action.type = "button";
  action.textContent = actionLabels[game.action] ?? "View game";
  action.disabled = game.action === "full";
  if (game.action === "requested") action.textContent = "Withdraw request";
  action.addEventListener("click", () => void selectGame(game, action));
  card.append(art, copy, action);
  return card;
}

async function loadGames() {
  errorElement.hidden = true;
  emptyElement.hidden = true;
  setMessage("Finding games in this server…");
  const payload = await requestJson("/api/activity/games");
  userElement.textContent = payload.user?.displayName ?? "Connected to Discord";
  gamesElement.replaceChildren(...(payload.games ?? []).map(createGameCard));
  emptyElement.hidden = (payload.games ?? []).length !== 0;
  setMessage(payload.games?.length ? "Choose a table to continue." : "");
}

async function selectGame(game, button) {
  if (game.action === "join" || game.action === "request" || game.action === "requested") {
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = game.action === "join" ? "Joining…" : game.action === "requested" ? "Withdrawing…" : "Sending…";
    try {
      await requestJson(`/api/activity/games/${encodeURIComponent(game.campaignId)}/${game.action === "requested" ? "withdraw" : game.action}`, { method: "POST" });
      if (game.action === "join") await openGame(game.campaignId);
      else {
        await loadGames();
        setMessage(game.action === "requested" ? "Your join request was withdrawn." : `Your request to join ${game.name} was sent.`);
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = originalLabel;
      setMessage(error instanceof Error ? error.message : "Could not update this game.");
    }
    return;
  }
  if (["continue", "resume", "invited"].includes(game.action)) await openGame(game.campaignId);
  else if (game.action === "requested") setMessage("Your request is waiting for the organizer.");
}

async function openGame(campaignId) {
  currentGameId = campaignId;
  lobbyScreen.hidden = true;
  liveScreen.hidden = false;
  liveActions.replaceChildren();
  setLiveMessage("Loading campaign…");
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
    renderGame(currentSnapshot);
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : "Could not load this game.");
    if (error instanceof Error && error.message === apiErrorMessage("notActive")) {
      clearInterval(tableTimer);
      tableTimer = null;
    }
  } finally {
    loadingTable = false;
  }
}

function renderGame(game) {
  document.querySelector("#live-campaign").textContent = game.campaignName;
  document.querySelector("#live-adventure").textContent = game.adventureTitle.toLocaleUpperCase();
  document.querySelector("#live-scene-title").textContent = game.kind === "lobby" ? "Choose your hero" : game.scene.title;
  document.querySelector("#live-scene-description").textContent = game.kind === "lobby"
    ? "Choose an available character. The organizer can start once the party is ready."
    : game.scene.description;
  if (game.kind === "lobby") {
    document.querySelector(".adventure-map-panel").hidden = true;
    renderLobby(game);
  } else {
    document.querySelector(".adventure-map-panel").hidden = false;
    renderMap(game.map);
    renderTable(game);
  }
}

function renderMap(map) {
  liveMap.replaceChildren();
  if (map.kind === "battlefield") {
    document.querySelector("#live-map-kind").textContent = "TACTICAL VIEW";
    document.querySelector("#live-map-title").textContent = "Battlefield";
    document.querySelector(".map-key").innerHTML = '<i class="current-key"></i> Party <i class="foe-key"></i> Foes';
    const zones = document.createElement("div");
    zones.className = "battle-map-zones";
    for (const zone of map.zones) {
      const tile = document.createElement(zone.canMove ? "button" : "article");
      tile.className = `battle-zone${zone.canMove ? " can-move" : ""}${zone.occupants.some((occupant) => occupant.active) ? " has-active" : ""}`;
      if (zone.canMove) {
        tile.type = "button";
        tile.addEventListener("click", () => void performAction({ kind: "move", zoneId: zone.id }));
      }
      const name = document.createElement("strong"); name.textContent = zone.name;
      const terrain = document.createElement("span"); terrain.className = "zone-terrain";
      terrain.textContent = [zone.lighting, zone.cover ? `${zone.cover} cover` : "", zone.difficult ? "difficult terrain" : ""].filter(Boolean).join(" · ") || "Open ground";
      const occupants = document.createElement("div"); occupants.className = "zone-occupants";
      for (const occupant of zone.occupants) {
        const token = document.createElement("span");
        token.className = `zone-token ${occupant.side}${occupant.active ? " active" : ""}`;
        token.title = `${occupant.name} · ${occupant.hp}/${occupant.maxHp} HP`;
        token.textContent = occupant.name;
        occupants.append(token);
      }
      tile.append(name, terrain, occupants);
      if (zone.canMove) { const move = document.createElement("small"); move.textContent = "Move here"; tile.append(move); }
      zones.append(tile);
    }
    liveMap.append(zones);
    return;
  }
  document.querySelector("#live-map-kind").textContent = "THE JOURNEY";
  document.querySelector("#live-map-title").textContent = "Adventure map";
  document.querySelector(".map-key").innerHTML = '<i class="current-key"></i> Here <i class="reachable-key"></i> Open route <i class="locked-key"></i> Locked';
  if (map.nodes.length === 0) { liveMap.textContent = "No mapped routes are known yet."; return; }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.classList.add("route-map-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Adventure route map. Open routes can be selected to travel.");
  const columns = new Map();
  for (const node of map.nodes) { if (!columns.has(node.column)) columns.set(node.column, []); columns.get(node.column).push(node); }
  const maxColumn = Math.max(...columns.keys());
  const maxRows = Math.max(...[...columns.values()].map((nodes) => nodes.length));
  const positions = new Map();
  for (const node of map.nodes) {
    const rowsInColumn = columns.get(node.column).length;
    positions.set(node.id, { x: 110 + node.column * 205, y: 54 + node.row * 90 + ((maxRows - rowsInColumn) * 45) });
  }
  const mapWidth = Math.max(240, 220 + maxColumn * 205);
  const mapHeight = Math.max(118, 92 + maxRows * 90);
  svg.setAttribute("viewBox", `0 0 ${mapWidth} ${mapHeight}`);
  svg.setAttribute("width", String(mapWidth)); svg.setAttribute("height", String(mapHeight));
  const defs = document.createElementNS(ns, "defs");
  const marker = document.createElementNS(ns, "marker");
  marker.setAttribute("id", "route-arrow"); marker.setAttribute("markerWidth", "8"); marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "6"); marker.setAttribute("refY", "4"); marker.setAttribute("orient", "auto"); marker.setAttribute("markerUnits", "strokeWidth");
  const arrow = document.createElementNS(ns, "path"); arrow.setAttribute("d", "M0,0 L8,4 L0,8 z"); arrow.setAttribute("fill", "#9aa1a9"); marker.append(arrow); defs.append(marker); svg.append(defs);
  for (const route of map.routes) {
    const from = positions.get(route.from); const to = positions.get(route.to); if (!from || !to) continue;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(from.x + 76)); line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x - 76)); line.setAttribute("y2", String(to.y));
    line.setAttribute("class", route.oneWay ? "route-line one-way" : "route-line");
    line.setAttribute("marker-end", "url(#route-arrow)"); svg.append(line);
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
    rect.setAttribute("x", String(point.x - 76)); rect.setAttribute("y", String(point.y - 26)); rect.setAttribute("width", "152"); rect.setAttribute("height", "52"); rect.setAttribute("rx", "10");
    const title = document.createElementNS(ns, "text");
    title.setAttribute("x", String(point.x)); title.setAttribute("y", String(point.y + 4)); title.setAttribute("text-anchor", "middle"); title.textContent = node.title;
    const subtitle = document.createElementNS(ns, "text");
    subtitle.setAttribute("x", String(point.x)); subtitle.setAttribute("y", String(point.y + 18)); subtitle.setAttribute("text-anchor", "middle"); subtitle.setAttribute("class", "route-subtitle");
    subtitle.textContent = node.status === "current" ? "You are here" : node.deadEnd ? "Dead end" : node.status === "visited" ? "Visited" : node.status === "locked" ? "Locked" : node.status === "known" ? "Mapped" : "Open route";
    group.append(rect, title, subtitle); svg.append(group);
  }
  liveMap.append(svg);
}

function renderLobby(game) {
  document.querySelector("#live-phase").textContent = `Lobby · ${game.playerCount} / ${game.maxPlayers}`;
  document.querySelector("#live-turn").textContent = game.selectedHeroId ? "Ready at the table" : "Choose a hero";
  document.querySelector("#live-turn").classList.remove("is-active");
  document.querySelector("#live-hero-name").textContent = game.selectedHeroName ?? "Your hero";
  document.querySelector("#live-hero-subtitle").textContent = game.selectedHeroClass ?? "Choose from the available characters";
  document.querySelector("#live-hero-hp").textContent = "Pre-game lobby";
  document.querySelector("#live-hero-ac").textContent = "";
  document.querySelector("#live-hero-health").style.width = "0%";
  document.querySelector("#live-resources").replaceChildren();
  liveEnemies.replaceChildren();
  liveActions.replaceChildren();
  for (const hero of game.heroChoices) {
    const button = makeButton(`${hero.name} · ${hero.className}${hero.available ? "" : " · chosen"}`, () => void performAction({ kind: "chooseHero", heroId: hero.id }), hero.id === game.selectedHeroId);
    button.disabled = !hero.available;
    liveActions.append(button);
  }
  if (game.joinRequestStatus === "requested") liveActions.append(makeButton("Withdraw join request", () => void performAction({ kind: "withdrawJoin" })));
  if (game.canStart) liveActions.append(makeButton("Start adventure", () => void performAction({ kind: "startLobby" }), true));
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
  })));
  document.querySelector("#live-party-count").textContent = `${game.playerCount} / ${game.maxPlayers}`;
  setLiveMessage(game.startBlockReason === "notEnoughPlayers" ? "Waiting for more players to join." : game.startBlockReason === "notReady" ? "Every player needs to choose a hero before the adventure can start." : game.selectedHeroId ? "You’re ready. The organizer can start the adventure." : "Choose a hero to reserve your seat.");
}

function renderTable(game) {
  const phase = phaseLabels[game.mode] ?? "Adventure";
  document.querySelector("#live-phase").textContent = game.roundNumber === null ? phase : `${phase} · Round ${game.roundNumber}`;
  const turn = document.querySelector("#live-turn");
  turn.textContent = game.yourTurn ? "Your turn" : game.activeName ? `${game.activeName}’s turn` : game.mode === "collecting" ? "Your action" : "Waiting for the table";
  turn.classList.toggle("is-active", game.yourTurn);
  const hero = game.myHero;
  document.querySelector("#live-hero-name").textContent = hero?.name ?? "Your character isn’t selected";
  document.querySelector("#live-hero-subtitle").textContent = hero ? `${hero.raceName ?? "Adventurer"} ${hero.className ?? "Hero"} ${hero.level}` : "Join the game to choose a hero";
  document.querySelector("#live-hero-hp").textContent = hero ? `${hero.hp} / ${hero.maxHp} HP` : "";
  document.querySelector("#live-hero-ac").textContent = hero ? `AC ${hero.armorClass}` : "";
  document.querySelector("#live-hero-health").style.width = hero ? `${Math.max(0, Math.min(100, (hero.hp / Math.max(1, hero.maxHp)) * 100))}%` : "0%";
  const resources = document.querySelector("#live-resources");
  resources.replaceChildren();
  if (hero) {
    for (const slot of [...hero.slots, ...hero.pactSlots]) {
      const resource = document.createElement("span");
      resource.className = "resource";
      resource.textContent = `✦ Level ${slot.level}: ${slot.left} / ${slot.max}`;
      resources.append(resource);
    }
  }
  liveEnemies.replaceChildren(...game.foes.map(makeEnemy));
  renderParty(game.party);
  document.querySelector("#live-party-count").textContent = `${game.party.length} heroes`;
  renderTableActions(game);
  setLiveMessage(game.submission === "action" ? "Your action is in. The story will update as the table resolves." : game.submission === "pass" ? "You passed this round." : "");
}

function makeEnemy(enemy) {
  const card = document.createElement("div");
  card.className = "live-enemy";
  const name = document.createElement("strong");
  name.textContent = enemy.name;
  const health = document.createElement("span");
  health.textContent = `${enemy.hp} / ${enemy.maxHp} HP · ${enemy.zone}`;
  const track = document.createElement("div");
  track.className = "health-track";
  const fill = document.createElement("i");
  fill.style.width = `${Math.max(0, Math.min(100, enemy.hp / Math.max(1, enemy.maxHp) * 100))}%`;
  track.append(fill);
  card.append(name, health, track);
  return card;
}

function renderParty(members) {
  liveParty.replaceChildren(...members.map((hero) => {
    const card = document.createElement(hero.isYou && hero.hp !== null ? "button" : "div");
    card.className = `live-party-card${hero.isYou ? " is-you" : ""}`;
    if (hero.isYou && hero.hp !== null) {
      card.type = "button";
      card.addEventListener("click", openDetails);
    }
    const sigil = document.createElement("span");
    sigil.className = "live-party-sigil";
    sigil.setAttribute("aria-hidden", "true");
    sigil.textContent = (hero.className ?? hero.name).slice(0, 1).toUpperCase();
    const copy = document.createElement("span");
    copy.className = "live-party-copy";
    const name = document.createElement("strong");
    name.textContent = `${hero.name}${hero.isYou ? " · YOU" : ""}`;
    const subtitle = document.createElement("span");
    subtitle.textContent = hero.level === null ? hero.className ?? hero.presence : `${hero.raceName ?? ""} ${hero.className ?? "Hero"} ${hero.level}`.trim();
    copy.append(name, subtitle);
    if (hero.hp !== null && hero.maxHp !== null) {
      const track = document.createElement("span");
      track.className = "party-health live-party-health";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, hero.hp / Math.max(1, hero.maxHp) * 100))}%`;
      track.append(fill);
      const hp = document.createElement("span");
      hp.textContent = `${hero.hp} / ${hero.maxHp} HP${hero.conditions?.length ? ` · ${hero.conditions.length} conditions` : ""}`;
      copy.append(track, hp);
    } else {
      const status = document.createElement("span");
      status.textContent = hero.presence === "ready" ? "Character selected" : "Choosing a character";
      copy.append(status);
    }
    card.append(sigil, copy);
    return card;
  }));
}

function renderTableActions(game) {
  liveActions.replaceChildren();
  const addAction = (label, action, primary = false) => liveActions.append(makeButton(label, () => void performAction(action), primary));
  if (game.canAcceptInvite) addAction("Accept invitation", { kind: "acceptInvite" }, true);
  for (const hero of game.joinChoices) addAction(`Join as ${hero.name} · ${hero.className}`, { kind: "joinHero", heroRef: hero.id }, true);
  for (const hero of game.savedHeroChoices ?? []) addAction(`Join with ${hero.name} · ${hero.className}`, { kind: "joinHero", heroRef: hero.id }, true);
  if (game.reactionIsYours && game.reaction) {
    addAction(`Decline reaction · ${game.reaction.attackerName}`, { kind: "reaction", spellId: null, slotLevel: null }, true);
    for (const spell of [...new Map(game.reaction.options.map((option) => [option.spellId, option])).values()]) addAction(`Cast ${spell.spellName}`, { kind: "reaction", spellId: spell.spellId, slotLevel: spell.slotLevel });
  }
  if (game.smiteIsYours && game.smite) {
    addAction(`Skip smite · ${game.smite.targetName}`, { kind: "smite", slotLevel: null }, true);
    for (const option of game.smite.options) addAction(`Divine Smite · level ${option.slotLevel}`, { kind: "smite", slotLevel: option.slotLevel });
  }
  if (game.opportunityAttackIsYours && game.opportunityAttack) {
    addAction(`Hold reaction · ${game.opportunityAttack.moverName} is moving`, { kind: "opportunityAttack", accept: false }, true);
    addAction(`Take opportunity attack vs ${game.opportunityAttack.moverName}`, { kind: "opportunityAttack", accept: true });
  }
  if (game.pendingRoll) addAction("Roll check", { kind: "roll" }, true);
  if (game.mode === "readyCheck") {
    addAction("I’m ready", { kind: "ready" }, true);
    if (game.canBegin) addAction("Begin the adventure", { kind: "begin" });
  } else if (game.mode === "paused" && game.canBegin) addAction("Resume game", { kind: "continue" }, true);

  if (game.turn && !game.turn.busy) {
    for (const attack of game.turn.attacks) {
      const offHand = attack.weapon.startsWith("offhand:");
      const nonlethal = attack.weapon.startsWith("nonlethal:");
      const weaponId = attack.weapon.replace(/^(offhand:|nonlethal:)/, "");
      for (const target of attack.targets) {
        addAction(`Attack ${target.name} · ${weaponId.replace(/^item:/, "")}`, { kind: "attack", weaponId, targetId: target.id, offHand, nonlethal }, true);
      }
    }
    for (const spell of game.turn.spells) {
      const target = spell.targets[0];
      if (target) addAction(`Cast ${spell.spellId.replace(/^spell:/, "")} · ${target.name}`, { kind: "combatSpell", spellId: spell.spellId, slotLevel: spell.slotLevel, targetIds: [target.id] });
    }
    for (const feature of game.turn.features) addAction(`Use ${feature.id.replace(/^feature:/, "").replaceAll("-", " ")}`, { kind: "feature", featureId: feature.id });
    for (const potion of game.turn.potions) addAction(`Use potion · ${potion.id.replace(/^item:/, "").replaceAll("-", " ")} ×${potion.count}`, { kind: "combatItem", itemId: potion.id });
    for (const shield of game.turn.shields) addAction(`${shield.on ? "Stow" : "Raise"} shield`, { kind: "shield", itemId: shield.id, on: !shield.on });
    for (const move of game.turn.moves) addAction(`Move to ${move.zone}`, { kind: "move", zoneId: move.zoneId });
    for (const target of game.turn.engage) addAction(`Engage ${target.name}`, { kind: "engage", targetId: target.id });
    for (const teleport of game.turn.teleports) addAction(`Teleport to ${teleport.zone}`, { kind: "teleport", spellId: teleport.spellId, slotLevel: teleport.slotLevel, zoneId: teleport.zoneId });
    for (const monsterId of game.turn.wildShapes) addAction(`Wild Shape · ${monsterId.replace(/^monster:/, "").replaceAll("-", " ")}`, { kind: "wildShape", monsterId });
    if (game.turn.canRevertShape) addAction("Return to your own form", { kind: "wildShape", monsterId: null });
    if (game.turn.canWithdraw) addAction("Withdraw safely", { kind: "withdraw" });
    if (game.turn.canDashOrDisengage) addAction("Dash", { kind: "dash" });
    if (game.turn.canDodge) addAction("Dodge", { kind: "combatDodge" });
    addAction("End turn", { kind: "endTurn" });
  } else if (game.mode === "collecting" && game.submission === null && game.myHero !== null) {
    const input = document.createElement("textarea");
    input.className = "live-action-input";
    input.maxLength = 1500;
    input.rows = 2;
    input.placeholder = "What does your hero do?";
    liveActions.append(input);
    addAction("Submit action", { kind: "submit", text: () => input.value }, true);
    addAction("Pass", { kind: "pass" });
  }
  if (game.explore && game.myHero) {
    if (game.explore.npcs.length) {
      const question = document.createElement("input");
      question.className = "live-action-input";
      question.maxLength = 500;
      question.placeholder = "Ask someone in the scene…";
      liveActions.append(question);
      for (const npc of game.explore.npcs) {
        addAction(`Ask ${npc.name}`, { kind: "askNpc", npcId: npc.id, question: () => question.value }, true);
        if (!npc.secretKnown) for (const skill of ["insight", "persuasion", "deception", "intimidation"]) addAction(`Press ${npc.name} · ${skill}`, { kind: "pressNpc", npcId: npc.id, skill });
      }
    }
    for (const shop of game.explore.shops ?? []) {
      for (const item of shop.buy) addAction(`Buy ${item.name} · ${item.price} gp`, { kind: "shop", npcId: shop.npc.id, itemId: item.itemId, direction: "buy" });
      for (const item of shop.sell) addAction(`Sell ${item.name} · ${item.price} gp`, { kind: "shop", npcId: shop.npc.id, itemId: item.itemId, direction: "sell" });
    }
    for (const spell of game.explore.spells) addAction(`Cast ${spell.name}`, { kind: "exploreSpell", spellId: spell.id });
    for (const potion of game.myHero.usablePotions ?? []) addAction(`Drink ${potion.name} ×${potion.count}`, { kind: "useItem", itemId: potion.id });
    for (const spell of game.explore.healing) for (const slot of spell.slots) for (const target of game.explore.hurt) addAction(`Heal ${target.name} · ${spell.name} level ${slot.level}`, { kind: "healSpell", spellId: spell.id, slotLevel: slot.level, targetId: target.id });
    for (const spell of game.explore.reviving) for (const slot of spell.slots) for (const target of game.explore.fallen) addAction(`Revive ${target.name} · ${spell.name} level ${slot.level}`, { kind: "reviveSpell", spellId: spell.id, slotLevel: slot.level, targetId: target.id });
    for (const spell of game.explore.conjuring) for (const slot of spell.slots) addAction(`Summon companion · ${spell.name} level ${slot.level}`, { kind: "summonCompanion", spellId: spell.id, slotLevel: slot.level });
    for (const place of game.explore.places) addAction(`Travel to ${place.title}`, { kind: "moveScene", sceneId: place.id });
  }
  if (game.myHero) addAction("Character details", { kind: "details" });
  if (liveActions.childElementCount === 0) {
    const note = document.createElement("span");
    note.className = "live-action-note";
    note.textContent = "Waiting for the next turn or campaign update.";
    liveActions.append(note);
  }
}

async function performAction(action) {
  if (currentGameId === null) return;
  if (action.kind === "details") return openDetails();
  const body = { ...action };
  for (const [key, value] of Object.entries(body)) if (typeof value === "function") body[key] = value();
  setLiveMessage("Sending your action…");
  try {
    const payload = await requestJson(`/api/activity/games/${encodeURIComponent(currentGameId)}/action`, { method: "POST", body: JSON.stringify(body) });
    currentSnapshot = payload.snapshot;
    renderGame(currentSnapshot);
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : "That action could not be sent.");
    await loadTable();
  }
}

function openDetails() {
  const hero = currentSnapshot?.kind === "table" ? currentSnapshot.myHero : null;
  if (!hero) return;
  document.querySelector("#detail-name").textContent = hero.name;
  document.querySelector("#detail-subtitle").textContent = `${hero.raceName ?? "Adventurer"} ${hero.className ?? "Hero"} ${hero.level}`;
  document.querySelector("#detail-hp").textContent = `${hero.hp} / ${hero.maxHp}`;
  document.querySelector("#detail-ac").textContent = String(hero.armorClass);
  document.querySelector("#detail-gold").textContent = String(hero.gold + hero.partyGold);
  document.querySelector("#detail-spells").textContent = [...hero.cantrips, ...hero.prepared, ...hero.slots.map((slot) => `${slot.left}/${slot.max} level ${slot.level} slots`), ...hero.pactSlots.map((slot) => `${slot.left}/${slot.max} pact level ${slot.level} slots`), ...hero.uses.map((use) => `${use.name}: ${use.left}/${use.max}`)].join(", ") || "No spellcasting or limited-use features.";
  const inventory = document.querySelector("#detail-inventory");
  inventory.replaceChildren();
  for (const item of hero.inventoryChoices ?? []) {
    const row = document.createElement("div");
    row.className = "detail-item-row";
    const label = document.createElement("span");
    label.textContent = `${item.name} ×${item.count}${item.worn ? " · equipped" : ""}`;
    row.append(label);
    if (item.wearable) {
      const wear = makeButton(item.worn ? "Remove" : "Equip", () => {
        document.querySelector("#detail-dialog").close();
        void performAction({ kind: item.worn ? "removeItem" : "wearItem", itemId: item.id });
      });
      row.append(wear);
    }
    const stash = makeButton("Stash", () => {
      document.querySelector("#detail-dialog").close();
      void performAction({ kind: "stashItem", itemId: item.id });
    });
    row.append(stash);
    inventory.append(row);
  }
  if (inventory.childElementCount === 0) inventory.textContent = "No carried equipment.";
  const stash = document.querySelector("#detail-stash");
  stash.replaceChildren();
  for (const item of hero.stash ?? []) {
    const row = document.createElement("div");
    row.className = "detail-item-row";
    const label = document.createElement("span");
    label.textContent = `${item.name} ×${item.count}`;
    row.append(label, makeButton("Take", () => {
      document.querySelector("#detail-dialog").close();
      void performAction({ kind: "takeFromStash", itemId: item.id });
    }));
    stash.append(row);
  }
  if (stash.childElementCount === 0) stash.textContent = "The party stash is empty.";
  document.querySelector("#detail-dialog").showModal();
}

document.querySelector("#back-to-lobby").addEventListener("click", () => {
  clearInterval(tableTimer);
  tableTimer = null;
  currentGameId = null;
  currentSnapshot = null;
  liveScreen.hidden = true;
  lobbyScreen.hidden = false;
  void loadGames().catch((error) => showError(error instanceof Error ? error.message : "Could not load your games."));
});
document.querySelector("#lobby-retry").addEventListener("click", () => {
  errorElement.hidden = true;
  void authenticate().catch((error) => showError(error instanceof Error ? error.message : "Discord sign-in failed."));
});

async function authenticate() {
  connectionStage = "Activity setup";
  discordConnected = false;
  errorElement.hidden = true;
  userElement.textContent = "Connecting to Discord…";
  serverElement.textContent = "Connecting to Discord…";
  setMessage("Connecting to Discord Activity…");
  const configResponse = await fetchWithTimeout("/activity-config.json", { cache: "no-store" });
  if (!configResponse.ok) throw new Error("Could not load the Discord application configuration.");
  const config = await configResponse.json();
  if (typeof config.applicationId !== "string" || config.applicationId.length === 0) throw new Error("The Discord application ID is not configured.");
  discordSdk = new DiscordSDK(config.applicationId);
  connectionStage = "Discord connection";
  setMessage("Waiting for Discord to connect…");
  await withTimeout(discordSdk.ready(), 12000, "Discord did not connect to the Activity. Close and relaunch it inside Discord, then check the Activity URL mapping if it still fails.");
  discordConnected = true;
  if (!discordSdk.guildId) throw new Error("Open this Activity from a server to see its games.");
  serverElement.textContent = "Discord connected";
  connectionStage = "Discord authorization";
  setMessage("Checking your Discord authorization…");
  const authorization = await withTimeout(discordSdk.commands.authorize({
    client_id: config.applicationId,
    response_type: "code",
    state: crypto.randomUUID(),
    prompt: "none",
    scope: ["identify", "guilds.members.read"],
  }), 20000, "Discord authorization did not finish. Close and reopen the Activity; if it repeats, check its OAuth2 redirect and requested scopes.");
  connectionStage = "Account verification";
  setMessage("Verifying your Discord account…");
  const session = await requestJson("/api/activity/session", {
    method: "POST",
    body: JSON.stringify({ code: authorization.code, guildId: discordSdk.guildId, channelId: discordSdk.channelId }),
  });
  sessionToken = session.session_token;
  if (typeof session.access_token !== "string" || typeof sessionToken !== "string") throw new Error("Discord sign-in did not return a valid session.");
  const identity = await discordSdk.commands.authenticate({ access_token: session.access_token });
  userElement.textContent = identity.user.global_name || identity.user.username;
  serverElement.textContent = "This Discord server";
  connectionStage = "Loading games";
  if (typeof session.launchCampaignId === "string") await openGame(session.launchCampaignId);
  else await loadGames();
}

void authenticate().catch((error) => {
  console.warn(`Discord Activity failed during ${connectionStage}.`, error);
  showError(error instanceof Error ? error.message : "Discord sign-in failed.");
});
