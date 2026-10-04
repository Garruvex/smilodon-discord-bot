import { app } from "./state.js";
import { openArtwork } from "./artwork-viewer.js";
import { iconForClass, iconImage, liveEnemies, liveParty, setArtwork } from "./dom.js";
import { renderCharacterWorkspace } from "./hero.js";
import { classText, t } from "./i18n.js";

export function enemyRankIcon(rank) { return rank === "boss" ? "crowned-skull" : rank === "elite" ? "evil-minion" : rank === "minion" ? "minions" : "attack"; }


export function makeEnemy(enemy) {
  const card = document.createElement("button");
  card.type = "button";
  const rank = enemy.rank ?? "standard";
  card.className = `live-party-card live-enemy ui-card rank-${rank}${enemy.active ? " is-active" : ""}${enemy.name === app.selectedEnemyName ? " is-selected" : ""}`;
  card.classList.toggle("is-active", enemy.active);
  const hpText = t("activity.hero.enemyHealth", { hp: enemy.hp, max: enemy.maxHp, band: t(`activity.band.${enemy.band}`), zone: enemy.zone });
  card.setAttribute("aria-label", `${enemy.name}. ${t(`activity.enemyRank.${rank}`)}. ${hpText}`);
  card.setAttribute("aria-pressed", String(enemy.name === app.selectedEnemyName));
  card.addEventListener("click", () => { app.selectedEnemyName = enemy.name; if (app.currentSnapshot?.kind === "table") { renderParty(app.currentSnapshot.party); renderCharacterWorkspace(app.currentSnapshot); renderEnemies(app.currentSnapshot.foes); } });
  const sigil = document.createElement("span"); sigil.className = "live-party-sigil enemy-sigil"; sigil.setAttribute("aria-hidden", "true");
  sigil.append(iconImage(enemyRankIcon(rank))); card.append(sigil);
  const copy = document.createElement("span"); copy.className = "live-party-copy enemy-copy";
  const name = document.createElement("strong");
  name.textContent = enemy.name;
  const rankBadge = document.createElement("span");
  rankBadge.className = "enemy-rank-label";
  rankBadge.textContent = t(`activity.enemyRank.${rank}`);
  const health = document.createElement("span");
  health.textContent = hpText;
  const track = document.createElement("span");
  track.className = "party-health live-party-health ui-meter";
  const fill = document.createElement("i");
  fill.style.width = `${enemy.maxHp > 0 ? Math.max(0, Math.min(100, Math.round((enemy.hp / enemy.maxHp) * 100))) : 0}%`;
  track.append(fill);
  copy.append(name, rankBadge, health);
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


export function renderEnemies(enemies) { liveEnemies.replaceChildren(...(enemies.length ? [Object.assign(document.createElement("span"), { className: "live-enemies-heading", textContent: t("activity.scene.encounter") }), ...enemies.map(makeEnemy)] : [])); }


export function renderParty(members) {
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
    if (selectTarget) card.append(selectTarget);
    if (hero.presence === "away" || hero.fallen || hero.down) {
      const condition = document.createElement("span");
      condition.className = "party-condition-overlay";
      condition.textContent = hero.presence === "away" ? t("activity.party.offline") : hero.fallen ? t("activity.party.dead") : t("activity.party.down");
      card.append(condition);
    }
    return card;
  }));
}


export function partyStatusText(hero) {
  if (hero.fallen) return t("activity.party.dead");
  if (hero.down) return t("activity.party.down");
  if (hero.presence === "away") return t("activity.party.presence.away");
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

