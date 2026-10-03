import { app } from "./state.js";
import { openRollPrompt } from "./dice.js";
import { requestJson } from "./api.js";
import { actionIcon, iconImage, liveActions, makeButton, setLiveMessage } from "./dom.js";
import { classText, t } from "./i18n.js";
import { loadTable } from "./poll.js";
import { renderGame, renderTable } from "./render.js";

// Where each kind of action is shown: urgent decisions on top, the round composer, a category list, or the closing button.
export const actionPlacement = { acceptInvite: "top", joinHero: "top", reaction: "top", smite: "top", opportunityAttack: "top", ready: "top", begin: "top", continue: "top", toggleMoveObjection: "top", moveVote: "top", submit: "composer", pass: "composer", endTurn: "bottom" };

export const actionCategoryOf = { attack: "attack", combatSpell: "spells", exploreSpell: "spells", healSpell: "spells", reviveSpell: "spells", summonCompanion: "spells", move: "move", moveScene: "move", teleport: "move", engage: "move", withdraw: "move", dash: "move", useItem: "items", combatItem: "items", shield: "items", shop: "items", askNpc: "talk", pressNpc: "talk", feature: "other", wildShape: "other", combatDodge: "other" };

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
    if (game.canBegin) liveActions.append(makeButton(t("activity.action.resumeGame"), () => void performAction({ kind: "continue" }), true, "play"));
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
    if (action.kind === "moveVote") { button.dataset.choice = action.choice; button.dataset.selected = String(selected); }
    const place = actionPlacement[action.kind];
    (place === "top" ? top : place === "composer" ? composer : place === "bottom" ? bottom : groups.get(actionCategoryOf[action.kind] ?? "other")).push(button);
  };
  if (game.pendingMove && game.mode === "collecting") {
    const choice = game.pendingMove.choiceByYou;
    addAction(t(choice === "go" ? "activity.move.withdrawGo" : "activity.move.voteGo"), { kind: "moveVote", choice: "go" }, choice !== "go", choice === "go");
    addAction(t(choice === "stay" ? "activity.move.withdrawStay" : "activity.move.voteStay"), { kind: "moveVote", choice: "stay" }, choice === "stay", choice === "stay");
    const voteRow = document.createElement("div");
    voteRow.className = "action-row action-urgent";
    voteRow.append(...top);
    liveActions.append(voteRow);
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
  if (game.explore && game.myHero) {
    if (game.explore.npcs.length) {
      const question = draftInput(document.createElement("input"), "ask", t("activity.category.talk"), t("activity.action.askPlaceholder"));
      question.maxLength = 500;
      groups.get("talk").push(question);
      for (const npc of game.explore.npcs) {
        addAction(t("activity.action.ask", { name: npc.name }), { kind: "askNpc", npcId: npc.id, question: () => question.value }, true);
        if (!npc.secretKnown && !npc.pressAttempted) for (const skill of ["insight", "persuasion", "deception", "intimidation"]) addAction(t("activity.action.pressNpc", { name: npc.name, skill: t(`activity.skill.${skill}`) }), { kind: "pressNpc", npcId: npc.id, skill });
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
  if (liveActions.childElementCount === 0) {
    const empty = document.createElement("span");
    empty.className = "live-action-note";
    empty.textContent = t("activity.status.waitUpdate");
    liveActions.append(empty);
  }
}


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
      const spell = String(action.spellId ?? "").replace(/^spell:/, "").replaceAll("-", " ");
      setLiveMessage(t("activity.status.castSuccess", { spell }));
    } else if (action.kind === "moveVote") setLiveMessage(t(action.choice === "stay" ? "activity.status.moveVoteStay" : "activity.status.moveVoteGo"));
    else setLiveMessage(t("activity.status.actionSuccess"));
    return true;
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : t("activity.status.actionFailed"));
    await loadTable();
    return false;
  } finally {
    app.actionInFlight = false;
    document.body.classList.remove("is-sending");
  }
}

