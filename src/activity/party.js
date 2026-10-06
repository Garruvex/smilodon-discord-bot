import { app } from "./state.js";
import { openArtwork } from "./artwork-viewer.js";
import { iconForClass, iconImage, liveEnemies, liveParty, setArtwork } from "./dom.js";
import { renderCharacterWorkspace } from "./hero.js";
import { performAction } from "./actions.js";
import { classText, t } from "./i18n.js";
import { fightTags, turnOrderBar } from "./fight-status.js";
import { encounterPreview, captureBattlefieldPositions, animateBattlefieldMovement, previewAttack, previewMagic, previewMelee } from "./encounter-preview.js";

export function enemyRankIcon(rank) { return rank === "boss" ? "crowned-skull" : rank === "elite" ? "evil-minion" : rank === "minion" ? "minions" : "attack"; }


// A creature in the fight, drawn like a hero's card: name and who it is, where it stands, and its health. Foes can be opened for their details; allies cannot.
function combatCard(entry, { side, rank = "standard", owner = null }) {
  const foe = side === "foes";
  const card = document.createElement(foe ? "button" : "div");
  if (foe) card.type = "button";
  card.className = `live-party-card ${foe ? "live-enemy" : "live-ally"} ui-card${foe ? ` rank-${rank}` : ""}${entry.active ? " is-active" : ""}${foe && entry.name === app.selectedEnemyName ? " is-selected" : ""}`;
  const down = entry.hp <= 0 || entry.condition === "dead" || entry.condition === "fled";
  if (down) card.dataset.condition = entry.condition === "fled" ? "fled" : "down";
  const place = t("activity.combat.at", { zone: entry.zone });
  const health = `${entry.hp} / ${entry.maxHp}`;
  const kind = foe ? t(`activity.enemyRank.${rank}`) : owner === null ? t("activity.ally.kind") : t("activity.ally.belongsTo", { name: owner });
  card.setAttribute("aria-label", `${entry.name}. ${kind}. ${place}. ${t("activity.hero.hp", { hp: entry.hp, max: entry.maxHp })}`);
  if (foe) {
    card.setAttribute("aria-pressed", String(entry.name === app.selectedEnemyName));
    card.addEventListener("click", () => { app.selectedEnemyName = entry.name; if (app.currentSnapshot?.kind === "table") { renderParty(app.currentSnapshot.party); renderCharacterWorkspace(app.currentSnapshot); renderEnemies(app.currentSnapshot.foes, app.currentSnapshot.allies); } });
  }
  const sigil = document.createElement("span");
  sigil.className = `live-party-sigil ${foe ? "enemy-sigil" : "ally-sigil"}`;
  sigil.setAttribute("aria-hidden", "true");
  sigil.append(iconImage(foe ? enemyRankIcon(rank) : "minions"));
  card.append(sigil);
  const copy = document.createElement("span");
  copy.className = "live-party-copy";
  const nameLine = document.createElement("span");
  nameLine.className = "party-name-line";
  const name = document.createElement("strong");
  name.textContent = entry.name;
  nameLine.append(name);
  if (entry.active) nameLine.append(Object.assign(document.createElement("small"), { className: "combat-turn", textContent: t("activity.party.turnNow") }));
  const kindLine = document.createElement("span");
  kindLine.className = "party-class-line combat-kind";
  kindLine.textContent = kind;
  kindLine.title = kind;
  const placeLine = document.createElement("span");
  placeLine.className = "party-class-line combat-place";
  placeLine.textContent = place;
  placeLine.title = place;
  const meta = document.createElement("span");
  meta.className = "party-meta-line";
  const bar = document.createElement("span");
  bar.className = "party-health live-party-health ui-meter";
  const fill = document.createElement("i");
  const percent = entry.maxHp > 0 ? Math.max(0, Math.min(100, Math.round((entry.hp / entry.maxHp) * 100))) : 0;
  fill.style.width = `${percent}%`;
  bar.dataset.health = percent > 60 ? "good" : percent > 30 ? "hurt" : "low";
  bar.append(fill);
  const hp = document.createElement("span");
  hp.className = "party-hp-label";
  hp.textContent = health;
  meta.append(bar, hp);
  copy.append(nameLine, kindLine, placeLine, meta);
  const tags = fightTags(entry);
  if (tags !== null) copy.append(tags);
  card.append(copy);
  return card;
}

export function makeEnemy(enemy) { return combatCard(enemy, { side: "foes", rank: enemy.rank ?? "standard" }); }

function makeAlly(ally) { return combatCard(ally, { side: "party", owner: ally.ownerName }); }

export function renderEnemies(enemies, allies = app.currentSnapshot?.allies ?? []) {
  const heading = (text, extra = "") => Object.assign(document.createElement("span"), { className: `live-enemies-heading${extra}`, textContent: text });
  const game = app.currentSnapshot;
  // A fight with a battlefield is drawn as the board; the sample controls (next turn, test attacks) are only for the design preview.
  const preview = new URLSearchParams(window.location.search).has("design-preview");
  if (game?.map?.kind === "battlefield" && game.party.some((hero) => hero.zone !== null && hero.zone !== undefined)) {
    const previous = captureBattlefieldPositions();
    const board = encounterPreview(game, (entry) => {
      if (entry.side === "allies") return;
      app.selectedEnemyName = entry.side === "foes" ? entry.name : null;
      if (entry.side === "party") app.selectedPartyCharacterId = entry.characterId;
      // On your own turn the Actions tab stays where it is, so picking a target does not take you away from the buttons.
      if (!(game.mode === "combat" && game.yourTurn)) app.selectedWorkspaceTab = "overview";
      renderParty(game.party);
      renderCharacterWorkspace(game);
      renderEnemies(game.foes, game.allies);
    });
    const title = heading(t("activity.scene.encounter"));
    const next = document.createElement("button");
    next.type = "button";
    next.className = "initiative-preview-next ui-control";
    next.textContent = "Preview next turn →";
    next.addEventListener("click", () => {
      const current = game.order.findIndex((entry) => entry.active);
      game.order = game.order.map((entry, index) => ({ ...entry, active: index === (current + 1) % game.order.length }));
      game.activeName = game.order.find((entry) => entry.active).name;
      renderEnemies(game.foes, game.allies);
    });
    // The round belongs to the encounter, not to the turn order, so it sits in the heading.
    if (game.roundNumber) title.append(Object.assign(document.createElement("span"), { className: "encounter-round", textContent: t("activity.status.round", { round: game.roundNumber }) }));
    if (preview) title.append(next);
    const effects = document.createElement("div");
    effects.className = "battle-preview-controls";
    for (const [label, run] of [
      ["Move hero", () => {
        const hero = game.party.find((entry) => entry.isYou);
        if (!hero) return;
        const current = game.map.zones.find((zone) => zone.name === hero.zone);
        const route = game.map.edges.find((edge) => edge.from === current?.id || edge.to === current?.id);
        if (!route) return;
        hero.zone = game.map.zones.find((zone) => zone.id === (route.from === current.id ? route.to : route.from)).name;
        renderEnemies(game.foes, game.allies);
      }],
      ["Attack · hit", () => void previewAttack(board, game.party.find((hero) => hero.isYou)?.name, game.foes[0]?.name, true)],
      ["Attack · miss", () => void previewAttack(board, game.party.find((hero) => hero.isYou)?.name, game.foes[0]?.name, false)],
      ["Magic bolt", () => void previewMagic(board)],
      ["Melee", () => {
        const hero = game.party.find((entry) => entry.isYou);
        const foe = game.foes[0];
        if (!hero || !foe) return;
        if (hero.zone !== foe.zone) {
          hero.zone = foe.zone;
          renderEnemies(game.foes, game.allies);
          setTimeout(() => { const currentBoard = liveEnemies.querySelector(".encounter-board"); if (currentBoard) void previewMelee(currentBoard); }, 700);
        } else void previewMelee(board);
      }],
      ["Area spell", () => void previewMagic(board, true)],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-control";
      button.textContent = label;
      button.addEventListener("click", run);
      effects.append(button);
    }
    const note = document.createElement("small");
    note.textContent = "Animation preview · attacks do not change HP";
    effects.append(note);
    liveEnemies.replaceChildren(title, ...[turnOrderBar(game)].filter(Boolean), ...(preview ? [effects] : []), board);
    requestAnimationFrame(() => animateBattlefieldMovement(board, previous));
    return;
  }
  liveEnemies.replaceChildren(...(enemies.length
    ? [heading(t("activity.scene.encounter")), ...[turnOrderBar(app.currentSnapshot)].filter(Boolean), ...enemies.map(makeEnemy), ...(allies.length ? [heading(t("activity.ally.heading"), " live-allies-heading"), ...allies.map(makeAlly)] : [])]
    : []));
}


// The organizer's way out of a full table with someone away: free their seat. It asks for a second press first, since it removes their hero from the table.
function freeSeatButton(seatUserId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "party-free-seat ui-control";
  button.textContent = t("activity.party.freeSeat");
  let armed = null;
  button.addEventListener("click", () => {
    if (armed === null) {
      button.textContent = t("activity.party.freeSeatSure");
      button.dataset.armed = "true";
      armed = setTimeout(() => { armed = null; button.textContent = t("activity.party.freeSeat"); delete button.dataset.armed; }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    void performAction({ kind: "retireSeat", userId: seatUserId });
  });
  return button;
}

// A seat nobody has taken yet, drawn as an outline the size of a hero card, so the panel is as tall as the table can ever be.
function openSeat() {
  const seat = document.createElement("div");
  seat.className = "live-party-card party-open-seat";
  seat.textContent = t("activity.party.openSeat");
  return seat;
}

export function renderParty(members) {
  const seats = app.currentSnapshot?.kind === "table" ? app.currentSnapshot.partySeats ?? 0 : 0;
  liveParty.replaceChildren(...members.map((hero) => {
    // Only your own card answers a press (it brings you back from an enemy's details). Someone else's has nothing to open, so it is not a button.
    const pressable = hero.isYou && hero.hp !== null && hero.maxHp !== null;
    const card = document.createElement("div");
    card.className = `live-party-card ui-card${hero.isYou ? " is-you" : ""}${!app.selectedEnemyName && hero.characterId === app.selectedPartyCharacterId ? " is-selected" : ""}`;
    card.dataset.status = hero.tableStatus ?? (hero.presence === "away" ? "away" : "waiting");
    card.dataset.presence = hero.presence ?? "present";
    card.dataset.condition = hero.fallen ? "dead" : hero.down ? "down" : "healthy";
    let selectTarget = null;
    if (pressable) {
      selectTarget = document.createElement("button");
      selectTarget.type = "button";
      selectTarget.className = "party-select-target";
      selectTarget.setAttribute("aria-label", t("activity.party.inspect", { name: hero.name }));
      selectTarget.setAttribute("aria-pressed", String(!app.selectedEnemyName && hero.characterId === app.selectedPartyCharacterId));
      selectTarget.addEventListener("click", () => {
        app.selectedEnemyName = null;
        const page = document.querySelector(".live-hero");
        if (app.selectedPartyCharacterId !== hero.characterId && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          page.getAnimations().forEach((animation) => animation.cancel());
          page.animate([{ transform: "perspective(1200px) rotateY(-9deg)", opacity: .55 }, { transform: "perspective(1200px) rotateY(0deg)", opacity: 1 }], { duration: 360, easing: "ease-out" });
        }
        app.selectedPartyCharacterId = hero.characterId;
        app.selectedWorkspaceTab = hero.isYou ? "actions" : "overview";
        if (app.currentSnapshot?.kind === "table") {
          renderParty(app.currentSnapshot.party);
          renderCharacterWorkspace(app.currentSnapshot);
          renderEnemies(app.currentSnapshot.foes);
        }
      });
    }
    const sigil = document.createElement("span");
    sigil.className = "live-party-sigil";
    const classGlyph = iconImage(iconForClass(hero.className));
    classGlyph.className = "party-class-glyph";
    const portrait = document.createElement("img");
    portrait.className = "party-portrait";
    portrait.alt = "";
    const inspectPortrait = document.createElement("button");
    inspectPortrait.type = "button";
    inspectPortrait.className = "party-portrait-open";
    inspectPortrait.setAttribute("aria-label", t("activity.artwork.viewPartyPortrait", { name: hero.name }));
    inspectPortrait.setAttribute("aria-haspopup", "dialog");
    inspectPortrait.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 5 5"></path></svg>';
    inspectPortrait.addEventListener("click", (event) => { event.stopPropagation(); void openArtwork(portrait, hero.name); });
    sigil.append(classGlyph, portrait, inspectPortrait);
    void setArtwork(portrait, classGlyph, hero.imageUrl, "");
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
    status.className = "party-status-label";
    const statusText = partyStatusText(hero);
    status.title = statusText;
    status.setAttribute("aria-label", statusText);
    status.dataset.status = hero.tableStatus ?? (hero.presence === "away" ? "away" : "waiting");
    status.textContent = statusText;
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
    const liveLine = partyLiveLine(hero, app.currentSnapshot);
    if (liveLine !== null) copy.append(liveLine);
    if (hero.playedBy) copy.append(Object.assign(document.createElement("span"), { className: "party-class-line", textContent: t("activity.party.playedBy", { name: hero.playedBy }) }));
    if (hero.zone != null) copy.append(Object.assign(document.createElement("span"), { className: "party-class-line combat-place", textContent: t("activity.combat.at", { zone: hero.zone }), title: hero.zone }));
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
    const tags = fightTags(hero);
    if (tags !== null) copy.append(tags);
    card.append(sigil, copy);
    if (selectTarget) card.append(selectTarget);
    if (hero.seatUserId !== undefined) card.append(freeSeatButton(hero.seatUserId));
    if (hero.presence === "away" || hero.fallen || hero.down) {
      const condition = document.createElement("span");
      condition.className = "party-condition-overlay";
      condition.textContent = hero.presence === "away" ? t("activity.party.offline") : hero.fallen ? t("activity.party.dead") : t("activity.party.down");
      card.append(condition);
    }
    return card;
  }), ...Array.from({ length: Math.max(0, seats - members.length) }, openSeat));
}


// What this hero is doing right now, in a line: thinking, what they sent, passed, acting, up next. Nothing when there is nothing to say.
function partyLiveLine(hero, game) {
  if (game === undefined || game.kind !== "table" || hero.fallen || hero.down) return null;
  const line = (state, text, full = text) => {
    const node = Object.assign(document.createElement("span"), { className: "party-live", textContent: text, title: full });
    node.dataset.live = state;
    return node;
  };
  if (hero.presence === "away") return line("away", t("activity.party.live.away"));
  if (game.mode === "collecting") {
    switch (hero.tableStatus) {
      case "submitted": return line("ready", hero.intent ? `✓ ${hero.intent}` : t("activity.party.live.ready"), hero.intent ?? t("activity.party.live.ready"));
      case "passed": return line("passed", t("activity.party.live.passed"));
      case "missed": return line("missed", t("activity.party.live.missed"));
      default: return line("thinking", t("activity.party.live.thinking"));
    }
  }
  if ((game.mode === "planning" || game.mode === "awaitingRolls") && hero.intent) return line("done", `▸ ${hero.intent}`, hero.intent);
  if (game.mode === "combat") {
    if (hero.tableStatus === "acting") return line("acting", t("activity.party.live.acting"));
    if (game.upcomingNames?.[0] === hero.name) return line("next", t("activity.party.live.next"));
  }
  return null;
}

export function partyStatusText(hero) {
  if (hero.fallen) return t("activity.party.dead");
  if (hero.down) return t("activity.party.down");
  if (hero.presence === "away") return t("activity.party.presence.away");
  if (hero.tableStatus === "done") return t("activity.party.done");
  const statusWords = { acting: t("activity.party.turnNow"), submitted: hero.presence === "ready" ? t("activity.party.ready") : t("activity.party.actionIn"), passed: t("activity.party.passed"), missed: t("activity.party.missed"), away: t("activity.party.away"), waiting: t("activity.party.waiting") };
  return statusWords[hero.tableStatus] ?? statusWords.waiting;
}


export function partyStatusIcon(hero) {
  if (hero.fallen) return "hazard";
  if (hero.down) return "heal";
  if (hero.presence === "away") return "notice";
  const status = hero.tableStatus ?? (hero.presence === "away" ? "away" : "waiting");
  return ({ acting: "attack", submitted: "reward", passed: "pause", missed: "hazard", away: "notice", waiting: "rest" })[status] ?? "rest";
}

