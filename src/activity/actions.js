import { app } from "./state.js";
import { openRollPrompt } from "./dice.js";
import { requestJson } from "./api.js";
import { actionIcon, finishBusy, iconImage, liveActions, makeButton, setLiveMessage, showBusy } from "./dom.js";
import { classText, t } from "./i18n.js";
import { loadTable } from "./poll.js";
import { actionGuide, spellGuide } from "./rules-book.js";
import { renderGame } from "./render.js";

// Where each kind of action is shown: urgent decisions on top, the round composer, a category list, or the closing button.
// Spell names as the table sends them, so a cast is confirmed by name.
const spellNames = new Map();

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function slotLabel(level, left, innate) {
  return innate ? t("activity.spell.innateChoice") : level === 0 ? t("activity.spell.cantripChoice") : t("activity.spell.slotChoice", { level, left });
}

function refreshActions() {
  if (app.currentSnapshot?.kind === "table") renderTableActions(app.currentSnapshot);
}

// The card for a choice made in steps: chips for the level and the targets, then the confirm button.
function pickerCard(config) {
  const picker = app.picker;
  if (!config.levels.some((level) => level.id === picker.level)) picker.level = config.levels[0]?.id ?? null;
  const card = document.createElement("section");
  card.className = "action-picker";
  const title = document.createElement("strong");
  title.textContent = config.title;
  card.append(title);
  const chips = (caption, options, selected, onPick) => {
    const group = document.createElement("div");
    group.className = "picker-group";
    const label = document.createElement("span");
    label.className = "picker-caption";
    label.textContent = caption;
    const row = document.createElement("div");
    row.className = "picker-chips";
    for (const option of options) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "picker-chip ui-control";
      chip.setAttribute("aria-pressed", String(selected.includes(option.id)));
      chip.textContent = option.label;
      chip.addEventListener("click", () => onPick(option.id));
      row.append(chip);
    }
    group.append(label, row);
    return group;
  };
  const limit = config.maxTargets(picker.level);
  picker.targets = picker.targets.filter((id) => config.targets.some((target) => target.id === id)).slice(0, Math.max(1, limit));
  if (config.levels.length > 1) card.append(chips(config.levelCaption, config.levels, [picker.level], (id) => { picker.level = id; refreshActions(); }));
  if (config.targets.length > 0) {
    const caption = limit > 1 ? t("activity.picker.chooseTargets", { max: limit }) : config.targetCaption;
    card.append(chips(caption, config.targets.map((target) => ({ id: target.id, label: target.name })), picker.targets, (id) => {
      picker.targets = picker.targets.includes(id) ? picker.targets.filter((chosen) => chosen !== id) : limit <= 1 ? [id] : [...picker.targets, id].slice(-limit);
      refreshActions();
    }));
  }
  if (config.impactPreview && picker.targets.length > 0) {
    const preview = config.impactPreview(picker.level, picker.targets);
    const impact = document.createElement("div");
    impact.className = "picker-impact";
    const label = document.createElement("span");
    label.className = "picker-caption";
    label.textContent = t("activity.picker.willAffect");
    const details = document.createElement("p");
    details.textContent = preview;
    impact.append(label, details);
    card.append(impact);
  }
  const buttons = document.createElement("div");
  buttons.className = "action-row";
  const confirm = makeButton(config.confirmLabel, () => {
    const action = config.build(picker.level, picker.targets);
    app.picker = null;
    void performAction(action);
  }, true, config.icon);
  confirm.disabled = config.targets.length > 0 && picker.targets.length === 0;
  buttons.append(confirm, makeButton(t("activity.picker.cancel"), () => { app.picker = null; refreshActions(); }));
  card.append(buttons);
  return card;
}

export const actionPlacement = { acceptInvite: "top", joinHero: "top", reaction: "top", smite: "top", opportunityAttack: "top", ready: "top", begin: "top", continue: "top", toggleMoveObjection: "top", moveVote: "top", submit: "composer", pass: "composer", endTurn: "bottom" };

export const actionCategoryOf = { attack: "attack", combatSpell: "spells", exploreSpell: "spells", healSpell: "spells", reviveSpell: "spells", summonCompanion: "spells", move: "move", moveScene: "move", teleport: "move", engage: "move", withdraw: "move", dash: "move", useItem: "items", combatItem: "items", shield: "items", shop: "items", askNpc: "talk", pressNpc: "talk", feature: "other", wildShape: "other", combatDodge: "other", spendHitDice: "other" };

export const actionCategoryOrder = ["attack", "spells", "move", "items", "talk", "other"];

export const actionCategoryIcon = { attack: "attack", spells: "spell", move: "move", items: "potion", talk: "clue", other: "shape" };

export const drafts = { action: "", ask: "", say: "" };


export function draftInput(element, draftKey, label, placeholder) {
  element.className = "live-action-input";
  element.placeholder = placeholder;
  element.setAttribute("aria-label", label);
  element.value = drafts[draftKey];
  element.addEventListener("input", () => { drafts[draftKey] = element.value; });
  return element;
}


// In-character words: they tell the table and the DM, use no action, and work in a fight too.
export const maxSpeechLength = 300;


export function speechRow(game) {
  if (!game.myHero || !["collecting", "combat"].includes(game.mode)) return null;
  const input = draftInput(document.createElement("input"), "say", t("activity.action.say"), t("activity.action.sayPlaceholder"));
  input.maxLength = 300;
  // Shown beside the box as well as in the page status, which a vote card can cover.
  const problem = document.createElement("span");
  problem.className = "speech-problem";
  problem.setAttribute("role", "alert");
  problem.hidden = true;
  const fail = (message) => { setLiveMessage(message); problem.textContent = message; problem.hidden = false; };
  input.addEventListener("input", () => { problem.hidden = true; });
  const send = async () => {
    const text = input.value.trim();
    if (text.length === 0) return;
    if (text.length > maxSpeechLength) return fail(t("activity.error.actionTooLong"));
    // The words stay in the box until the table has taken them.
    if (!(await performAction({ kind: "speak", text }))) return fail(document.querySelector("#live-message")?.textContent || t("activity.status.actionFailed"));
    drafts.say = "";
    input.value = "";
  };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); send(); } });
  const row = document.createElement("div");
  row.className = "action-speech";
  row.append(input, makeButton(t("activity.action.say"), send, false, "notice"), problem);
  return row;
}


export function renderTableActions(game) {
  const next = document.createElement("div");
  const log = [];
  buildTableActions(game, next, log);
  const signature = next.innerHTML + JSON.stringify(log);
  if (signature === app.actionsSignature && liveActions.childElementCount > 0) return;
  app.actionsSignature = signature;
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


export function buildTableActions(game, liveActions, log) {
  liveActions.replaceChildren();
  if (game.joinRequestStatus === "requested") {
    const note = document.createElement("span");
    note.className = "live-action-note status-note join-queue-note";
    note.textContent = t("activity.join.waitingApproval");
    liveActions.append(note);
    const withdraw = { kind: "withdrawJoin" };
    log.push(JSON.stringify(withdraw));
    liveActions.append(makeButton(t("activity.action.withdrawJoin"), () => void performAction(withdraw), false, "pause"));
  } else if (game.joinRequestStatus === "approved") {
    const note = document.createElement("span");
    note.className = "live-action-note status-note join-queue-note";
    note.textContent = t("activity.join.approvedChooseHero");
    liveActions.append(note);
  } else if (game.joinRequestStatus === "invited") {
    const note = document.createElement("span");
    note.className = "live-action-note status-note join-queue-note";
    note.textContent = t("activity.join.invited");
    liveActions.append(note);
  }
  if (game.queuedJoin) {
    const note = document.createElement("span");
    note.className = "live-action-note status-note join-queue-note";
    note.textContent = game.queuedJoin.nextEncounter
      ? t("activity.join.waitingNextEncounter", { name: game.queuedJoin.heroName })
      : game.queuedJoin.encounterRound === null
        ? t("activity.join.waitingEncounter", { name: game.queuedJoin.heroName })
        : t("activity.join.waitingEncounterRound", { name: game.queuedJoin.heroName, round: game.queuedJoin.encounterRound });
    liveActions.append(note);
    const cancelJoin = { kind: "withdrawJoin" };
    log.push(JSON.stringify(cancelJoin));
    liveActions.append(makeButton(t("activity.action.cancelQueuedJoin"), () => void performAction(cancelJoin), false, "pause"));
  }
  // A prompt the player closed, or one they have not met yet, can always be brought back from here.
  if (game.pendingRoll && !["paused", "safety", "recovery"].includes(game.mode)) {
    const row = document.createElement("div");
    row.className = "action-row action-urgent";
    log.push(JSON.stringify({ kind: "openRoll", checkId: game.pendingRoll.checkId }));
    row.append(makeButton(t("activity.dice.rollD20"), () => openRollPrompt(), true, "roll"));
    liveActions.append(row);
  }
  if (["paused", "safety", "recovery"].includes(game.mode)) {
    if (game.canBegin) {
      const resume = makeButton(t("activity.action.resumeGame"), () => void performAction({ kind: "continue" }), true, "play");
      resume.dataset.allowAway = "true";
      liveActions.append(resume);
    }
    else {
      const note = document.createElement("span");
      note.className = "live-action-note status-note";
      note.textContent = t("activity.status.paused");
      liveActions.append(note);
    }
    return;
  }
  if (game.mode === "planning" || game.mode === "awaitingRolls") {
    const note = document.createElement("span");
    note.className = "live-action-note status-note";
    note.textContent = t(game.mode === "planning" ? "activity.status.dmResolving" : "activity.status.waitRolls");
    liveActions.prepend(note);
    return;
  }
  const top = [], composer = [], bottom = [];
  const groups = new Map(actionCategoryOrder.map((category) => [category, []]));
  const addAction = (label, action, primary = false, selected = false) => {
    log.push(JSON.stringify(action));
    const button = makeButton(label, () => void performAction(action), primary, actionIcon[action.kind] ?? "notice");
    // Resuming the table is the organizer's even while marked away, so the away lock leaves it alone.
    if (action.kind === "continue" || action.kind === "back") button.dataset.allowAway = "true";
    if (action.kind === "moveVote") { button.dataset.choice = action.choice; button.dataset.selected = String(selected); }
    const place = actionPlacement[action.kind];
    (place === "top" ? top : place === "composer" ? composer : place === "bottom" ? bottom : groups.get(actionCategoryOf[action.kind] ?? "other")).push(button);
  };
  // A choice that needs more than a press (which spell level, which targets): its opener sits in the list and the card opens above it.
  const panels = [];
  const addPicker = (key, category, openLabel, config) => {
    log.push(JSON.stringify(["picker", key]));
    const open = app.picker?.key === key;
    const opener = makeButton(openLabel, () => { app.picker = open ? null : { key, level: config.levels[0]?.id ?? null, targets: [] }; refreshActions(); }, false, config.icon);
    opener.setAttribute("aria-expanded", String(open));
    groups.get(category).push(opener);
    if (open) panels.push(pickerCard(config));
  };
  if (game.pendingMove && game.mode === "collecting") {
    // The vote card above the table is where the vote is cast; this panel keeps only what can still be done beside it.
    const note = document.createElement("span");
    note.className = "live-action-note status-note";
    note.textContent = t("activity.status.moveDecision");
    liveActions.append(note);
    const voteSpeech = speechRow(game);
    if (voteSpeech) liveActions.append(voteSpeech);
    return;
  }
  if (game.canAcceptInvite) addAction(t("activity.action.acceptInvite"), { kind: "acceptInvite" }, true);
  if (game.joinRequestStatus !== "queued") {
    for (const hero of game.joinChoices) addAction(t("activity.action.joinAs", { name: hero.name, class: classText(hero.className) }), { kind: "joinHero", heroRef: hero.id }, true);
    for (const hero of game.savedHeroChoices ?? []) addAction(t("activity.action.joinWith", { name: hero.name, class: classText(hero.className) }), { kind: "joinHero", heroRef: hero.id }, true);
  }
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
      const weapon = offHand ? t("activity.weapon.offhand", { name: attack.weaponName }) : nonlethal ? t("activity.weapon.nonlethal", { name: attack.weaponName }) : attack.weaponName;
      for (const target of attack.targets) {
        addAction(t("activity.action.attack", { name: target.name, weapon }), { kind: "attack", weaponId, targetId: target.id, offHand, nonlethal }, true);
      }
    }
    for (const [spellId, entries] of groupBy(game.turn.spells, (spell) => spell.spellId)) {
      const name = entries[0].spellName;
      spellNames.set(spellId, name);
      const targets = [...new Map(entries.flatMap((entry) => entry.targets).map((target) => [target.id, target])).values()];
      if (targets.length === 0) continue;
      const levels = entries.map((entry) => ({ id: String(entry.slotLevel), label: slotLabel(entry.slotLevel, entry.slotsLeft, entry.innate) }));
      const area = entries[0].affectedByTarget !== undefined;
      if (!area && levels.length === 1 && targets.length === 1) {
        addAction(t("activity.action.castOn", { spell: name, name: targets[0].name }), { kind: "combatSpell", spellId, slotLevel: entries[0].slotLevel, targetIds: [targets[0].id] });
        continue;
      }
      addPicker(`spell:${spellId}`, "spells", t("activity.action.castOpen", { name }), {
        icon: "spell", title: name, confirmLabel: t("activity.action.cast", { name }), levelCaption: t("activity.picker.chooseLevel"), targetCaption: t("activity.picker.chooseTarget"),
        levels, targets: targets.map((target) => ({ id: target.id, name: target.name })),
        maxTargets: (level) => Math.max(1, entries.find((entry) => String(entry.slotLevel) === level)?.maxTargets ?? 1),
        ...(area ? { impactPreview: (level, targetIds) => {
          const entry = entries.find((candidate) => String(candidate.slotLevel) === level);
          const affected = [...new Map(targetIds.flatMap((id) => entry?.affectedByTarget?.[id] ?? []).map((target) => [target.id, target])).values()];
          return affected.map((target) => target.side === "party" ? t("activity.picker.allyName", { name: target.name }) : target.name).join(", ");
        } } : {}),
        build: (level, targetIds) => ({ kind: "combatSpell", spellId, slotLevel: Number(level), targetIds }),
      });
    }
    for (const feature of game.turn.features) addAction(t("activity.action.useFeature", { name: feature.name }), { kind: "feature", featureId: feature.id });
    for (const potion of game.turn.potions) addAction(t("activity.action.usePotion", { name: potion.name, count: potion.count }), { kind: "combatItem", itemId: potion.id });
    for (const shield of game.turn.shields) addAction(t(shield.on ? "activity.action.shieldStow" : "activity.action.shieldRaise"), { kind: "shield", itemId: shield.id, on: !shield.on });
    for (const move of game.turn.moves) addAction(t("activity.action.moveTo", { name: move.zone }), { kind: "move", zoneId: move.zoneId });
    for (const target of game.turn.engage) addAction(t("activity.action.engage", { name: target.name }), { kind: "engage", targetId: target.id });
    for (const [spellId, entries] of groupBy(game.turn.teleports, (teleport) => teleport.spellId)) {
      const name = entries[0].spellName;
      spellNames.set(spellId, name);
      const zones = [...new Map(entries.map((entry) => [entry.zoneId, { id: entry.zoneId, name: `${entry.zone} · ${entry.feet} ft` }])).values()];
      const levels = [...new Map(entries.map((entry) => [entry.slotLevel, { id: String(entry.slotLevel), label: slotLabel(entry.slotLevel, entry.slotsLeft, false) }])).values()];
      if (levels.length === 1 && zones.length === 1) {
        addAction(t("activity.action.teleport", { name: entries[0].zone }), { kind: "teleport", spellId, slotLevel: entries[0].slotLevel, zoneId: entries[0].zoneId });
        continue;
      }
      addPicker(`teleport:${spellId}`, "move", t("activity.action.castOpen", { name }), {
        icon: "move", title: name, confirmLabel: t("activity.action.cast", { name }), levelCaption: t("activity.picker.chooseLevel"), targetCaption: t("activity.picker.chooseZone"),
        levels, targets: zones, maxTargets: () => 1,
        build: (level, zoneIds) => ({ kind: "teleport", spellId, slotLevel: Number(level), zoneId: zoneIds[0] }),
      });
    }
    for (const form of game.turn.wildShapeChoices) addAction(t("activity.action.wildShape", { name: form.name }), { kind: "wildShape", monsterId: form.id });
    if (game.turn.canRevertShape) addAction(t("activity.action.returnForm"), { kind: "wildShape", monsterId: null });
    if (game.turn.canWithdraw) addAction(t("activity.action.withdrawSafely"), { kind: "withdraw" });
    if (game.turn.canDashOrDisengage) addAction(t("activity.action.dash"), { kind: "dash" });
    if (game.turn.canDodge) addAction(t("activity.action.dodge"), { kind: "combatDodge" });
    addAction(t("activity.action.endTurn"), { kind: "endTurn" });
  } else if (game.mode === "collecting" && [null, "action", "pass"].includes(game.submission) && game.myHero !== null) {
    const submissionKey = `${game.campaignId}:${game.sceneId}:${game.roundNumber}:${game.submissionRevision ?? 0}`;
    if (submissionKey !== app.actionDraftSubmissionKey) {
      drafts.action = game.submissionText ?? "";
      app.actionDraftSubmissionKey = submissionKey;
    }
    const input = draftInput(document.createElement("textarea"), "action", t("activity.action.submit"), t("activity.action.inputPlaceholder"));
    input.maxLength = 500;
    input.rows = 2;
    composer.push(input);
    // Seen while typing too, which a placeholder is not.
    const hint = document.createElement("p");
    hint.className = "action-hint";
    hint.textContent = t("activity.action.ownOnly");
    composer.push(hint);
    composer.push(makeButton(t("activity.action.say"), async () => {
      const text = input.value.trim();
      if (!text) {
        setLiveMessage(t("activity.error.emptyAction"));
        input.focus();
        return;
      }
      // An action may run to 500 characters, words to 300; the text stays in the box until the table has taken it.
      if (text.length > maxSpeechLength) return setLiveMessage(t("activity.error.actionTooLong"));
      if (!(await performAction({ kind: "speak", text }))) return;
      drafts.action = "";
      input.value = "";
    }, false, "notice"));
    addAction(t(game.submission === "action" ? "activity.action.updateAction" : "activity.action.takeAction"), { kind: "submit", text: () => input.value, roundNumber: game.roundNumber, sceneId: game.sceneId }, true);
    addAction(t("activity.action.pass"), { kind: "pass" });
  }
  // After a short rest the hero may spend Hit Dice: each one is rolled, the Constitution modifier added, and the total healed.
  if (game.hitDice?.canSpend) {
    addAction(t("activity.action.spendHitDice", { die: `d${game.hitDice.die ?? ""}` }), { kind: "spendHitDice", count: 1 });
    if (game.hitDice.left > 1) addAction(t("activity.action.spendAllHitDice", { count: game.hitDice.left }), { kind: "spendHitDice", count: game.hitDice.left });
  }
  if (game.explore && game.myHero) {
    if (game.explore.npcs.length) {
      const question = draftInput(document.createElement("input"), "ask", t("activity.category.talk"), t("activity.action.askPlaceholder"));
      question.maxLength = 500;
      groups.get("talk").push(question);
      for (const npc of game.explore.npcs) {
        addAction(t("activity.action.ask", { name: npc.name }), { kind: "askNpc", npcId: npc.id, question: () => question.value }, true);
        if (!npc.secretKnown && !npc.pressAttempted) {
          addPicker(`press:${npc.id}`, "talk", t("activity.action.pressNpcOpen", { name: npc.name }), {
            icon: "clue", title: t("activity.action.pressNpcOpen", { name: npc.name }), confirmLabel: t("activity.action.pressConfirm"), levelCaption: t("activity.picker.chooseSkill"), targetCaption: "",
            levels: ["insight", "persuasion", "deception", "intimidation"].map((skill) => ({ id: skill, label: t(`activity.skill.${skill}`) })), targets: [], maxTargets: () => 0,
            build: (skill) => ({ kind: "pressNpc", npcId: npc.id, skill }),
          });
        }
        if (npc.pressAttempted && !npc.secretKnown) {
          const note = document.createElement("span");
          note.className = "live-action-note status-note";
          note.textContent = t("activity.dialogue.pressAlreadyAttempted");
          groups.get("talk").push(note);
        }
      }
    }
    for (const shop of game.explore.shops ?? []) {
      for (const item of shop.buy) addAction(t("activity.action.buy", { name: item.name, price: item.price }), { kind: "shop", npcId: shop.npc.id, itemId: item.itemId, direction: "buy" });
      for (const item of shop.sell) addAction(t("activity.action.sell", { name: item.name, price: item.price }), { kind: "shop", npcId: shop.npc.id, itemId: item.itemId, direction: "sell" });
    }
    for (const spell of game.explore.spells) addAction(t("activity.action.cast", { name: spell.name }), { kind: "exploreSpell", spellId: spell.id });
    for (const potion of game.myHero.usablePotions ?? []) addAction(t("activity.action.drink", { name: potion.name, count: potion.count }), { kind: "useItem", itemId: potion.id });
    const castCard = (key, spell, slots, targets, direct, build) => {
      spellNames.set(spell.id, spell.name);
      if (slots.length === 1 && targets.length <= 1) return direct(slots[0], targets[0]);
      addPicker(key, "spells", t("activity.action.castOpen", { name: spell.name }), {
        icon: "heal", title: spell.name, confirmLabel: t("activity.action.cast", { name: spell.name }), levelCaption: t("activity.picker.chooseLevel"), targetCaption: t("activity.picker.chooseTarget"),
        levels: slots.map((slot) => ({ id: String(slot.level), label: slotLabel(slot.level, slot.left, false) })), targets: targets.map((target) => ({ id: target.id, name: target.name })), maxTargets: () => 1, build,
      });
    };
    for (const spell of game.explore.healing) {
      if (game.explore.hurt.length === 0) continue;
      castCard(`heal:${spell.id}`, spell, spell.slots, game.explore.hurt,
        (slot, target) => addAction(t("activity.action.heal", { target: target.name, spell: spell.name, level: slot.level }), { kind: "healSpell", spellId: spell.id, slotLevel: slot.level, targetId: target.id }),
        (level, ids) => ({ kind: "healSpell", spellId: spell.id, slotLevel: Number(level), targetId: ids[0] }));
    }
    for (const spell of game.explore.reviving) {
      if (game.explore.fallen.length === 0) continue;
      castCard(`revive:${spell.id}`, spell, spell.slots, game.explore.fallen,
        (slot, target) => addAction(t("activity.action.revive", { target: target.name, spell: spell.name, level: slot.level }), { kind: "reviveSpell", spellId: spell.id, slotLevel: slot.level, targetId: target.id }),
        (level, ids) => ({ kind: "reviveSpell", spellId: spell.id, slotLevel: Number(level), targetId: ids[0] }));
    }
    for (const spell of game.explore.conjuring) {
      castCard(`summon:${spell.id}`, spell, spell.slots, [],
        (slot) => addAction(t("activity.action.summon", { spell: spell.name, level: slot.level }), { kind: "summonCompanion", spellId: spell.id, slotLevel: slot.level }),
        (level) => ({ kind: "summonCompanion", spellId: spell.id, slotLevel: Number(level) }));
    }
    for (const place of game.explore.places) addAction(t("activity.action.travel", { name: place.title }), { kind: "moveScene", sceneId: place.id });
  }

      if (category === "spells") list.append(spellGuide(game.spellFacts));
      if (category === "attack" && game.mode === "combat") list.append(actionGuide());
  const row = (className, nodes) => {
    const element = document.createElement("div");
    element.className = className;
    element.append(...nodes);
    return element;
  };
  if (top.length) liveActions.append(row("action-row action-urgent", top));
  for (const panel of panels) liveActions.append(panel);
  if (composer.length) liveActions.append(row("action-composer", composer));
  if (note) liveActions.append(note);
  const speech = game.mode === "collecting" && game.submission === null ? null : speechRow(game);
  if (speech) liveActions.append(speech);
  const choiceCount = (category) => groups.get(category).filter((node) => node instanceof HTMLButtonElement).length;
  const categories = actionCategoryOrder.filter((category) => choiceCount(category) > 0);
  if (categories.length) {
    if (!categories.includes(app.selectedActionCategory)) app.selectedActionCategory = categories[0];
    const chips = document.createElement("div");
    chips.className = "action-chips";
    chips.setAttribute("role", "tablist");
    const lists = new Map();
    const select = (category) => {
      app.selectedActionCategory = category;
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
    select(app.selectedActionCategory);
  }
  if (bottom.length) liveActions.append(row("action-row action-end", bottom));
  if (app.picker !== null && panels.length === 0) app.picker = null;
  if (liveActions.childElementCount === 0) {
    const empty = document.createElement("span");
    empty.className = "live-action-note";
    empty.textContent = t("activity.status.waitUpdate");
    liveActions.append(empty);
  }
}


// After an action goes through, the panel stays locked for this long, with the pill saying what was done, so a press is not repeated by mistake.
const cooldownMs = 2000;

export async function performAction(action) {
  if (app.currentGameId === null || app.actionInFlight) return;
  if (app.currentGameId === "local-preview" && action.kind === "moveVote") {
    const move = app.currentSnapshot.pendingMove;
    const ownName = app.uiLanguage === "zh-TW" ? "艾莉亞・維爾" : "Aria Vell";
    move.supporters = (move.supporters ?? []).filter((name) => name !== ownName);
    move.staying = move.staying.filter((name) => name !== ownName);
    if (action.choice === "go") move.supporters.push(ownName); else move.staying.push(ownName);
    move.choiceByYou = action.choice;
    renderGame(app.currentSnapshot);
    setLiveMessage(t(action.choice === "stay" ? "activity.status.moveVoteStay" : "activity.status.moveVoteGo"));
    return true;
  }
  const body = { ...action };
  for (const [key, value] of Object.entries(body)) if (typeof value === "function") body[key] = value();
  if (["submit", "speak"].includes(body.kind) && (typeof body.text !== "string" || body.text.trim() === "")) {
    setLiveMessage(t("activity.error.emptyAction"));
    return;
  }
  setLiveMessage(t("activity.status.sendingAction"));
  showBusy(t("activity.status.sendingAction"), t("activity.status.stillSending"));
  app.actionInFlight = true;
  document.body.classList.add("is-sending");
  try {
    const payload = await requestJson(`/api/activity/games/${encodeURIComponent(app.currentGameId)}/action`, { method: "POST", body: JSON.stringify(body) });
    app.currentSnapshot = payload.snapshot;
    app.tableToken = payload.token ?? null;
    app.lastFullTableAt = Date.now();
    renderGame(app.currentSnapshot);
    if (action.kind === "joinHero" && app.currentSnapshot?.queuedJoin) setLiveMessage(t("activity.join.queuedConfirmation", { name: app.currentSnapshot.queuedJoin.heroName }));
    else if (["combatSpell", "exploreSpell", "healSpell", "reviveSpell", "summonCompanion", "teleport"].includes(action.kind)) {
      const spell = spellNames.get(action.spellId) ?? String(action.spellId ?? "").replace(/^spell:/, "").replaceAll("-", " ");
      setLiveMessage(t("activity.status.castSuccess", { spell }));
    } else if (action.kind === "moveVote") setLiveMessage(t(action.choice === "stay" ? "activity.status.moveVoteStay" : "activity.status.moveVoteGo"));
    else setLiveMessage(app.pressedLabel === null ? t("activity.status.actionSuccess") : t("activity.status.didAction", { action: app.pressedLabel }));
    finishBusy(document.querySelector("#live-message").textContent, false);
    await new Promise((resolve) => setTimeout(resolve, cooldownMs));
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : t("activity.status.actionFailed");
    setLiveMessage(reason);
    finishBusy(reason, true);
    await loadTable();
    return false;
  } finally {
    app.actionInFlight = false;
    app.pressedLabel = null;
    document.body.classList.remove("is-sending");
    // A refused press or one that changes nothing leaves the panel as it was, so the spinner on its button is cleared here.
    for (const pending of document.querySelectorAll(".live-action-choice.is-pending")) pending.classList.remove("is-pending");
  }
}

