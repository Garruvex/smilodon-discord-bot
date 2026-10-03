import { app } from "./state.js";
import { performAction } from "./actions.js";
import { artIconPrefix, iconForClass, iconImage, liveActions, makeButton, setArtwork } from "./dom.js";
import { classText, t } from "./i18n.js";
import { partyStatusText } from "./party.js";

export function renderEquipment(hero) {
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


// The class emblem sits faintly in the corner of the hero page; it is the backdrop, not a mark on the portrait.
export function setHeroWatermark(className) {
  const mark = document.querySelector("#hero-watermark");
  if (!className) {
    mark.hidden = true;
    return;
  }
  mark.src = `${artIconPrefix}/${iconForClass(className)}.svg`;
  mark.hidden = false;
}


export function populateMemberOverview(profile, status, conditions = [], customEntries = null) {
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


export function updateHealthMeter(hp, maxHp) {
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


export function setWorkspaceTabs(game, tabs) {
  const tablist = document.querySelector("#hero-workspace-tabs");
  tablist.hidden = false;
  tablist.replaceChildren(...tabs.map(([id, key]) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "ui-control"; button.role = "tab";
    button.id = `hero-tab-${id}`; button.setAttribute("aria-selected", String(app.selectedWorkspaceTab === id));
    button.setAttribute("aria-controls", `hero-panel-${id}`); button.tabIndex = app.selectedWorkspaceTab === id ? 0 : -1;
    button.textContent = t(key); button.addEventListener("click", () => { app.selectedWorkspaceTab = id; renderCharacterWorkspace(game); });
    return button;
  }));
  for (const id of ["overview", "actions", "spells", "inventory", "trade"]) {
    const panel = document.querySelector(`#hero-panel-${id}`);
    panel.hidden = !tabs.some(([tabId]) => tabId === id) || app.selectedWorkspaceTab !== id;
  }
}


// What a caster checks before almost every turn, kept in view on every tab: spell slots and class feature uses as pips (filled = left).
export function renderHeroResources(hero) {
  const panel = document.querySelector("#hero-resources");
  const slots = hero ? [...hero.slots.map((slot) => ({ ...slot, pact: false })), ...hero.pactSlots.map((slot) => ({ ...slot, pact: true }))].filter((slot) => slot.max > 0) : [];
  const uses = hero ? hero.uses.filter((use) => use.max > 0) : [];
  panel.hidden = slots.length === 0 && uses.length === 0;
  const pips = (left, max) => {
    const track = document.createElement("span");
    track.className = "hr-pips";
    if (max > 8) {
      track.textContent = `${left}/${max}`;
      return track;
    }
    for (let index = 0; index < max; index += 1) {
      const pip = document.createElement("i");
      pip.className = "hr-pip";
      pip.dataset.state = index < left ? "full" : "spent";
      track.append(pip);
    }
    return track;
  };
  const row = (className, label, left, max, spoken) => {
    const item = document.createElement("div");
    item.className = className;
    item.setAttribute("role", "img");
    item.setAttribute("aria-label", spoken);
    const name = document.createElement("span");
    name.className = "hr-label";
    name.textContent = label;
    item.append(name, pips(left, max));
    return item;
  };
  document.querySelector("#hr-slots").replaceChildren(...slots.map((slot) => {
    const spoken = t(slot.pact ? "activity.resources.pact" : "activity.resources.slotLevel", { level: slot.level });
    const item = row("hr-slot", slot.pact ? t("activity.resources.pactShort", { level: slot.level }) : String(slot.level), slot.left, slot.max, `${spoken}: ${slot.left} / ${slot.max}`);
    item.title = spoken;
    return item;
  }));
  document.querySelector("#hr-uses").replaceChildren(...uses.map((use) => row("hr-use", use.name, use.left, use.max, `${use.name}: ${use.left} / ${use.max}`)));
}


export function renderCharacterWorkspace(game) {
  document.querySelector("#hero-panel-actions").append(liveActions);
  const enemy = game.foes.find((foe) => foe.name === app.selectedEnemyName);
  if (enemy) {
    document.querySelector("#live-turn").textContent = enemy.active ? t("activity.party.turnNow") : "";
    document.querySelector("#live-turn").classList.toggle("is-active", enemy.active);
    document.querySelector("#hero-workspace-label").textContent = t("activity.scene.encounter");
    document.querySelector("#live-hero-name").textContent = enemy.name;
    document.querySelector("#live-hero-subtitle").textContent = enemy.zone;
    document.querySelector("#live-hero-class").textContent = enemy.band;
    setHeroWatermark(null);
    renderHeroResources(null);
    document.querySelector("#live-hero-hp").textContent = t("activity.hero.hp", { hp: enemy.hp, max: enemy.maxHp });
    document.querySelector("#live-hero-ac").textContent = "";
    updateHealthMeter(enemy.hp, enemy.maxHp);
    const sigil = document.querySelector("#live-hero-sigil"); sigil.replaceChildren(iconImage("attack"));
    void setArtwork(document.querySelector("#live-hero-image"), sigil, null, enemy.name);
    const enemyTabs = game.myHero ? [["overview", "activity.tab.overview"], ["actions", "activity.tab.myActions"]] : [["overview", "activity.tab.overview"]];
    if (!enemyTabs.some(([id]) => id === app.selectedWorkspaceTab)) app.selectedWorkspaceTab = "overview";
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
  app.selectedEnemyName = null;
  const ownHero = game.myHero;
  if (app.selectedPartyCharacterId === null || !game.party.some((member) => member.characterId === app.selectedPartyCharacterId)) {
    app.selectedPartyCharacterId = ownHero?.characterId ?? game.party.find((member) => member.isYou)?.characterId ?? game.party[0]?.characterId ?? null;
    app.selectedWorkspaceTab = "actions";
  }
  const selected = game.party.find((member) => member.characterId === app.selectedPartyCharacterId) ?? game.party.find((member) => member.isYou) ?? null;
  const viewingOwn = selected?.isYou === true && ownHero !== null;
  const profile = viewingOwn ? ownHero : selected;
  renderHeroResources(viewingOwn ? ownHero : null);
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
  if (!tabs.some(([id]) => id === app.selectedWorkspaceTab)) app.selectedWorkspaceTab = viewingOwn ? "actions" : "overview";
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


export function renderSpellbook(hero) {
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


export function renderInventory(hero) {
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


export function renderTrade(game, fixedTarget) {
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

