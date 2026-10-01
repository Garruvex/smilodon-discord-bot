import { DiscordSDK } from "@discord/embedded-app-sdk";

const gamesElement = document.querySelector("#lobby-games");
const messageElement = document.querySelector("#lobby-message");
const emptyElement = document.querySelector("#lobby-empty");
const errorElement = document.querySelector("#lobby-error");
const errorMessageElement = document.querySelector("#lobby-error-message");
const userElement = document.querySelector("#lobby-user");
const serverElement = document.querySelector("#server-label");
const lobbyScreen = document.querySelector("#lobby-screen");
const liveScreen = document.querySelector("#live-screen");
const liveActions = document.querySelector("#live-actions");
const liveParty = document.querySelector("#live-party");
const liveEnemies = document.querySelector("#live-enemies");
let sessionToken = null;
let discordSdk = null;
let currentGameId = null;
let tableTimer = null;
let loadingTable = false;
let currentSnapshot = null;

const lifecycleLabels = { lobby: "Open lobby", active: "Live game", paused: "On a break" };
const actionLabels = { join: "Join game", continue: "Open table", request: "Request to join", requested: "Request sent", invited: "Open invitation", full: "Table full", resume: "Open table" };
const phaseLabels = { opening: "Opening scene", readyCheck: "Gathering the party", collecting: "Your action", planning: "The story unfolds", awaitingRolls: "Waiting on rolls", combat: "Combat", waiting: "Waiting for players", paused: "Paused", safety: "Safety pause", recovery: "Recovering", archived: "Ended" };

function setMessage(message) { messageElement.textContent = message; }
function setLiveMessage(message) { document.querySelector("#live-message").textContent = message; }

function showError(error) {
  gamesElement.replaceChildren();
  emptyElement.hidden = true;
  errorElement.hidden = false;
  errorMessageElement.textContent = error;
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
  const response = await fetch(url, { ...options, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(payload.error));
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
  if (game.kind === "lobby") renderLobby(game);
  else renderTable(game);
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
  const configResponse = await fetch("/activity-config.json", { cache: "no-store" });
  if (!configResponse.ok) throw new Error("Could not load the Discord application configuration.");
  const config = await configResponse.json();
  if (typeof config.applicationId !== "string" || config.applicationId.length === 0) throw new Error("The Discord application ID is not configured.");
  discordSdk = new DiscordSDK(config.applicationId);
  await discordSdk.ready();
  if (!discordSdk.guildId) throw new Error("Open this Activity from a server to see its games.");
  setMessage("Connect your Discord account to find your games…");
  const authorization = await discordSdk.commands.authorize({
    client_id: config.applicationId,
    response_type: "code",
    state: crypto.randomUUID(),
    prompt: "none",
    scope: ["identify", "guilds.members.read"],
  });
  const session = await requestJson("/api/activity/session", {
    method: "POST",
    body: JSON.stringify({ code: authorization.code, guildId: discordSdk.guildId }),
  });
  sessionToken = session.session_token;
  if (typeof session.access_token !== "string" || typeof sessionToken !== "string") throw new Error("Discord sign-in did not return a valid session.");
  const identity = await discordSdk.commands.authenticate({ access_token: session.access_token });
  userElement.textContent = identity.user.global_name || identity.user.username;
  serverElement.textContent = "This Discord server";
  await loadGames();
}

void authenticate().catch((error) => {
  console.info("Discord Activity sign-in is unavailable in this browser preview.", error);
  showError(error instanceof Error ? error.message : "Discord sign-in failed.");
});
