import { app } from "./state.js";
import { requestJson } from "./api.js";
import { makeButton, setArtwork, setLiveMessage } from "./dom.js";
import { classText, t } from "./i18n.js";
import { loadCharacters, openCharacterCreator } from "./character-builder.js";
import { openGame, loadTable } from "./poll.js";
import { performAction } from "./actions.js";
import { loadGames } from "./lobby.js";
import { resetDrawers } from "./drawers.js";
import { resetPaint } from "./render.js";

export function flowElement(tag, className = "", text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const text = (key, values) => t(`activity.tables.${key}`, values);
const panel = (title) => {
  const node = flowElement("section", "table-flow-panel ui-card");
  node.append(flowElement("h2", "", title));
  return node;
};
const field = (caption, input) => {
  const label = flowElement("label", "table-flow-field");
  label.append(flowElement("span", "", caption), input);
  return label;
};
const select = (name, entries, current) => {
  const node = flowElement("select", "ui-input");
  node.name = name;
  for (const [value, title] of entries) {
    const option = flowElement("option", "", title);
    option.value = String(value);
    node.append(option);
  }
  if (current !== undefined) node.value = String(current);
  return node;
};
const message = () => {
  const node = flowElement("p", "table-flow-feedback");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  return node;
};
const input = (name, maxLength, value = "") => {
  const node = flowElement("input", "ui-input");
  node.name = name;
  node.maxLength = maxLength;
  node.value = value;
  node.required = true;
  return node;
};
const actionRow = () => flowElement("div", "table-flow-actions");

export async function returnToTables() {
  clearInterval(app.tableTimer);
  app.tableTimer = null;
  app.currentGameId = null;
  app.currentSnapshot = null;
  resetPaint();
  resetDrawers();
  for (const id of ["live-screen", "table-setup-screen", "table-lobby-screen", "characters-screen"]) document.getElementById(id).hidden = true;
  document.querySelector("#lobby-screen").hidden = false;
  await loadGames();
}

function heading(title, subtitle, organizer = false, status = null) {
  const header = flowElement("header", "table-flow-heading");
  const copy = flowElement("div");
  copy.append(makeButton(text("allBack"), () => void returnToTables().catch((error) => setLiveMessage(error.message))), flowElement("h1", "", title), flowElement("p", "table-flow-muted", subtitle));
  if (status) copy.append(flowElement("span", "table-flow-status", status));
  header.append(copy);
  if (organizer) header.append(makeButton(text("manage"), () => void openTableManagement()));
  return header;
}

async function createCharacter() {
  await loadCharacters();
  openCharacterCreator();
}

export function renderTableLobby(game) {
  const screen = document.querySelector("#table-lobby-screen");
  screen.hidden = false;
  const columns = flowElement("div", "table-flow-columns");
  const heroPanel = panel(t("activity.lobby.yourCharacter"));
  if (!game.isMember) {
    heroPanel.append(flowElement("p", "table-flow-muted", text(game.isOrganizer ? "organizerSeat" : "joinFirst")));
    const join = makeButton(t("activity.lobby.action.join"), () => void performAction({ kind: "joinLobby" }), true);
    join.disabled = game.canJoin === false;
    heroPanel.append(join);
    if (!game.canJoin) heroPanel.append(flowElement("p", "table-flow-muted", t("activity.lobby.action.full")));
  } else {
    const tabs = actionRow();
    for (const [tab, label] of [["saved", "activity.lobby.savedCharacters"], ["presets", "activity.lobby.adventureCharacters"]]) {
      const button = makeButton(t(label), () => { app.lobbyCharacterTab = tab; renderTableLobby(game); });
      button.setAttribute("aria-pressed", String(app.lobbyCharacterTab === tab));
      tabs.append(button);
    }
    heroPanel.append(tabs);
    const saved = app.lobbyCharacterTab === "saved";
    const choices = saved ? game.savedHeroChoices ?? [] : game.heroChoices;
    if (!choices.length) heroPanel.append(flowElement("p", "table-flow-muted", t("activity.creator.emptyLibrary")));
    for (const hero of choices) {
      const selected = hero.id === game.selectedHeroId;
      const button = makeButton("", () => void performAction(saved ? { kind: "chooseSaved", snapshotId: hero.id.replace(/^lib:/, "") } : { kind: "chooseHero", heroId: hero.id }));
      button.classList.add("table-hero-choice");
      button.replaceChildren();
      const avatar = flowElement("span", "table-flow-avatar");
      avatar.setAttribute("aria-hidden", "true");
      const portrait = flowElement("img", "table-choice-portrait");
      portrait.hidden = true;
      const initials = flowElement("span", "", hero.name.slice(0, 1));
      avatar.append(portrait, initials);
      void setArtwork(portrait, initials, hero.imageUrl, "");
      const copy = flowElement("span", "table-hero-copy");
      copy.append(flowElement("strong", "", hero.name), flowElement("small", "", classText(hero.className)));
      button.append(avatar, copy, flowElement("span", "table-choice-state", selected ? text("selected") : hero.available === false ? text("taken") : text("choose")));
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = hero.available === false;
      heroPanel.append(button);
    }
    const feedback = message();
    heroPanel.append(makeButton(t("activity.characters.create"), () => void createCharacter().catch((error) => { feedback.textContent = error.message; })), feedback);
    if (game.selectedHeroId) heroPanel.append(flowElement("p", "table-flow-notice", text("characterReady", { name: game.selectedHeroName })));
    const leave = makeButton(text("leaveLobby"), () => void performAction({ kind: "leaveLobby" }));
    heroPanel.append(leave);
  }
  const aside = flowElement("aside", "table-flow-stack");
  const roster = panel(text("party"));
  roster.append(flowElement("p", "table-flow-muted", t("activity.lobby.players", { count: game.playerCount, max: game.maxPlayers })));
  for (const member of game.members) {
    const row = flowElement("div", "table-member-row");
    const copy = flowElement("div", "table-hero-copy");
    copy.append(flowElement("strong", "", member.heroName), flowElement("small", "", member.isYou ? text("you") : classText(member.className) ?? text("choosing")));
    row.append(copy, flowElement("span", `table-ready-status${member.ready ? " is-ready" : ""}`, text(member.ready ? "ready" : "choosing")));
    roster.append(row);
  }
  if (!game.members.length) roster.append(flowElement("p", "table-flow-muted", text("emptySeats")));
  const start = panel(game.isOrganizer ? t("activity.action.startAdventure") : text("waitingOrganizer"));
  start.append(flowElement("p", "table-flow-muted", game.startBlockReason === "notEnoughPlayers" ? t("activity.status.waitingPlayers") : game.startBlockReason === "notReady" ? t("activity.lobby.waitingReady") : text("partyReady")));
  if (game.isOrganizer) {
    const button = makeButton(t("activity.action.startAdventure"), () => void performAction({ kind: "startLobby" }), true);
    button.disabled = !game.canStart;
    start.append(button);
  }
  const liveMessage = message();
  liveMessage.id = "table-lobby-message";
  aside.append(roster, start, houseRulesPanel(game.houseRules), liveMessage);
  columns.append(heroPanel, aside);
  screen.replaceChildren(heading(game.campaignName, game.adventureTitle, game.isOrganizer, t("activity.status.openTable")), columns);
}

// The table's house rules: everyone reads what is in force; the organizer changes them here until the game starts.
function houseRulesPanel(rules) {
  const box = panel(t("activity.rules.houseTitle"));
  box.append(flowElement("p", "table-flow-muted", t(rules.editable ? "activity.rules.houseIntro" : "activity.rules.houseReadOnly")));
  if (rules.editable) {
    const preset = flowElement("select", "ui-input");
    preset.setAttribute("aria-label", t("activity.rules.presetLabel"));
    preset.append(Object.assign(flowElement("option", "", t("activity.rules.presetPick")), { value: "" }));
    for (const entry of rules.presets) preset.append(Object.assign(flowElement("option", "", entry.name), { value: entry.id }));
    preset.addEventListener("change", () => { if (preset.value !== "") void performAction({ kind: "applyRulePreset", presetId: preset.value }); });
    box.append(preset);
  }
  for (const option of rules.options) {
    const row = flowElement("div", "table-member-row");
    const copy = flowElement("div", "table-hero-copy");
    copy.append(flowElement("strong", "", option.name), flowElement("small", "", option.info));
    row.append(copy);
    if (rules.editable) {
      const choice = flowElement("select", "ui-input");
      choice.setAttribute("aria-label", option.name);
      for (const value of option.values) choice.append(Object.assign(flowElement("option", "", value.label), { value: value.id }));
      choice.value = option.value;
      choice.addEventListener("change", () => void performAction({ kind: "setHouseRule", ruleId: option.id, value: choice.value }));
      row.append(choice);
    } else {
      row.append(flowElement("span", "table-choice-state", option.values.find((value) => value.id === option.value)?.label ?? option.value));
    }
    box.append(row);
  }
  return box;
}

export async function openCreateTable() {
  const options = await requestJson("/api/activity/table-options");
  if (!options.canCreate) throw new Error(text("notOrganizer"));
  clearInterval(app.gamesTimer);
  app.gamesTimer = null;
  const screen = document.querySelector("#table-setup-screen");
  document.querySelector("#lobby-screen").hidden = true;
  screen.hidden = false;
  const form = flowElement("form", "table-create-form");
  const columns = flowElement("div", "table-flow-columns");
  const settings = panel(text("settings"));
  const fields = flowElement("div", "table-flow-fields");
  const name = input("name", 60);
  name.minLength = 2;
  const language = select("language", [["en", "English"], ["zh-TW", "繁體中文"]], options.language);
  const adventure = select("adventureId", []);
  const refill = () => {
    const old = adventure.value;
    adventure.replaceChildren();
    for (const entry of options.adventures.filter((item) => item.languages.includes(language.value))) {
      const option = flowElement("option", "", entry.titles?.[language.value] ?? entry.id);
      option.value = entry.id;
      adventure.append(option);
    }
    if ([...adventure.options].some((entry) => entry.value === old)) adventure.value = old;
  };
  language.addEventListener("change", refill);
  refill();
  adventure.required = true;
  const players = select("players", [1, 2, 3, 4, 5, 6].map((count) => [count, String(count)]), 3);
  fields.append(field(text("name"), name), field(text("adventure"), adventure), field(text("language"), language), field(text("maxPlayers"), players), field(text("pace"), select("pacing", [["live", text("paceLive")], ["playByPost", text("pacePost")]])), field(text("access"), select("visibility", [["open", text("accessOpen")], ["membersOnly", text("accessPrivate")]])), field(text("loot"), select("lootGold", [["pooled", text("lootPooled")], ["split", text("lootSplit")]])));
  settings.append(fields);
  const summary = panel(text("newTable"));
  summary.append(flowElement("p", "table-flow-muted", text("createHelp")), field(text("yourRole"), select("joinAsPlayer", [["yes", text("play")], ["no", text("host")]])), flowElement("p", "table-flow-notice", text("privateHelp")));
  columns.append(settings, summary);
  const feedback = message();
  if (options.creationBlock) feedback.textContent = text(options.creationBlock);
  const submit = flowElement("button", "ui-control primary", text("openLobby"));
  submit.type = "submit";
  submit.disabled = options.creationBlock !== null || !adventure.options.length;
  language.addEventListener("change", () => { submit.disabled = options.creationBlock !== null || !adventure.options.length; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    feedback.textContent = text("creating");
    const values = Object.fromEntries(new FormData(form));
    try {
      const result = await requestJson("/api/activity/games", { method: "POST", body: JSON.stringify({ ...values, players: Number(values.players), joinAsPlayer: values.joinAsPlayer === "yes" }) });
      await openGame(result.campaignId);
      if (result.warning) setLiveMessage(text("provisioningFailed"));
    } catch (error) { feedback.textContent = error.message; submit.disabled = false; }
  });
  const buttons = actionRow();
  buttons.append(submit, makeButton(text("cancel"), () => void returnToTables()));
  form.append(columns, feedback, buttons);
  screen.replaceChildren(heading(text("create"), text("createSubtitle")), form);
  name.focus();
}

export async function openTableManagement() {
  const id = app.currentGameId;
  if (!id || id === "local-preview") return;
  const dialog = document.querySelector("#table-manage-dialog");
  const feedback = message();
  const header = flowElement("header", "table-flow-heading");
  const title = flowElement("h2", "", text("manage"));
  title.id = "table-manage-title";
  const close = makeButton(text("close"), () => dialog.close());
  header.append(title, close);
  dialog.replaceChildren(header, feedback);
  if (!dialog.open) dialog.showModal();
  feedback.textContent = text("loading");
  try {
    const data = await requestJson(`/api/activity/games/${id}/manage`);
    if (!dialog.open || app.currentGameId !== id) return;
    feedback.textContent = "";
    const write = async (action, button) => {
      if (button.disabled) return;
      button.disabled = true;
      feedback.textContent = text("saving");
      try {
        await requestJson(`/api/activity/games/${id}/manage`, { method: "POST", body: JSON.stringify(action) });
        if (app.currentGameId !== id) return;
        app.tableToken = null;
        await loadTable();
        if (!dialog.open || app.currentGameId !== id) return;
        await openTableManagement();
        dialog.querySelector(".table-flow-feedback").textContent = text("saved");
      } catch (error) { feedback.textContent = error.message; button.disabled = false; }
    };
    const settings = panel(data.name);
    const seats = select("maxPlayers", [1, 2, 3, 4, 5, 6].map((count) => [count, String(count)]), data.maxPlayers);
    const save = makeButton(text("saveSeats"), () => void write({ kind: "resize", maxPlayers: Number(seats.value) }, save));
    settings.append(field(text("maxPlayers"), seats), save);
    // Seated players can be removed from a waiting lobby and from a running game (between fights); a running game asks for a second press.
    for (const member of data.members) {
      const row = flowElement("div", "table-member-row");
      row.append(flowElement("span", "", member.displayName ?? member.userId));
      if (member.userId !== app.discordUserId) {
        const live = data.lifecycle !== "lobby";
        const remove = makeButton(text("remove"), () => {
          if (live && remove.dataset.armed !== "true") {
            remove.dataset.armed = "true";
            remove.textContent = t("activity.party.freeSeatSure");
            setTimeout(() => { delete remove.dataset.armed; remove.textContent = text("remove"); }, 4000);
            return;
          }
          void write({ kind: "remove", userId: member.userId }, remove);
        });
        row.append(remove);
      }
      settings.append(row);
    }
    const requests = panel(text("requests"));
    const pending = data.requests.filter((request) => request.status === "requested");
    if (!pending.length) requests.append(flowElement("p", "table-flow-muted", text("noRequests")));
    for (const request of pending) {
      const form = flowElement("form", "table-request-row");
      form.append(flowElement("h3", "", request.displayName ?? request.userId));
      const entrance = flowElement("textarea", "ui-input");
      entrance.required = true;
      entrance.maxLength = 500;
      form.append(field(text("entrance"), entrance));
      const approve = flowElement("button", "ui-control primary", text("approve"));
      approve.type = "submit";
      form.addEventListener("submit", (event) => { event.preventDefault(); void write({ kind: "decide", userId: request.userId, approve: true, entrance: entrance.value }, approve); });
      const decline = makeButton(text("decline"), () => void write({ kind: "decide", userId: request.userId, approve: false }, decline));
      const row = actionRow();
      row.append(approve, decline);
      form.append(row);
      requests.append(form);
    }
    for (const request of data.requests.filter((request) => request.status !== "requested")) {
      const row = flowElement("div", "table-request-status");
      const revoke = makeButton(text("revoke"), () => void write({ kind: "revoke", userId: request.userId }, revoke));
      row.append(flowElement("strong", "", request.displayName ?? request.userId), flowElement("span", "table-flow-status", text(request.status)), revoke);
      requests.append(row);
    }
    const invite = panel(text("invite"));
    const searchForm = flowElement("form", "table-member-search");
    const query = input("query", 80);
    query.minLength = 2;
    const search = flowElement("button", "ui-control", text("findPlayer"));
    search.type = "submit";
    searchForm.append(field(text("playerName"), query), search);
    const found = flowElement("div", "table-invite-results");
    searchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      search.disabled = true;
      try {
        const result = await requestJson(`/api/activity/games/${id}/invite-members?q=${encodeURIComponent(query.value.trim())}`);
        found.replaceChildren();
        if (!result.members.length) found.append(flowElement("p", "table-flow-muted", text("noMembers")));
        for (const member of result.members) {
          const form = flowElement("form", "table-request-row");
          form.append(flowElement("h3", "", member.displayName));
          const entrance = flowElement("textarea", "ui-input");
          entrance.maxLength = 500;
          entrance.required = data.lifecycle !== "lobby";
          if (data.lifecycle !== "lobby") form.append(field(text("entrance"), entrance));
          const send = flowElement("button", "ui-control primary", text("sendInvitation"));
          send.type = "submit";
          form.addEventListener("submit", (submitEvent) => { submitEvent.preventDefault(); void write({ kind: "invite", userId: member.userId, entrance: entrance.value }, send); });
          form.append(send);
          found.append(form);
        }
      } catch (error) { feedback.textContent = error.message; }
      finally { search.disabled = false; }
    });
    invite.append(searchForm, found);
    const body = flowElement("div", "table-flow-stack");
    body.append(settings, requests, invite);
    dialog.append(body, makeButton(text("refreshRequests"), () => void openTableManagement()));
  } catch (error) { feedback.textContent = error.message; }
}

export function wireTableLifecycle() {
  document.querySelector("#table-create").addEventListener("click", () => void openCreateTable().catch((error) => { document.querySelector("#lobby-message").textContent = error.message; }));
  document.querySelector("#table-manage").addEventListener("click", () => void openTableManagement());
  document.addEventListener("activity-characters-loaded", () => {
    if (app.currentGameId !== null && app.currentGameId !== "local-preview") {
      app.tableToken = null;
      void loadTable().catch(() => {});
    }
  });
}

export function renderJoiningPanel(game) {
  const root = document.querySelector("#table-join-panel");
  root.hidden = Boolean(game.myHero) || (game.canBegin && !game.joinRequestStatus);
  if (root.hidden) { root.replaceChildren(); return; }
  root.replaceChildren(flowElement("h2", "", text("joinOngoing")));
  const status = game.joinRequestStatus;
  if (status === "requested") {
    root.append(flowElement("p", "table-flow-muted", t("activity.join.waitingApproval")), makeButton(t("activity.action.withdrawJoin"), () => void performAction({ kind: "withdrawJoin" })));
  } else if (status === "invited") {
    root.append(flowElement("p", "table-flow-muted", t("activity.join.invited")));
    if (game.joinEntrance) root.append(flowElement("p", "table-flow-notice", game.joinEntrance));
    root.append(makeButton(t("activity.action.acceptInvite"), () => void performAction({ kind: "acceptInvite" }), true));
  } else if (status === "queued" && game.queuedJoin) {
    root.append(flowElement("p", "table-flow-notice", t(game.queuedJoin.nextEncounter ? "activity.join.waitingNextEncounter" : "activity.join.waitingEncounter", { name: game.queuedJoin.heroName })), makeButton(t("activity.action.cancelQueuedJoin"), () => void performAction({ kind: "withdrawJoin" })));
  } else if (status === "approved") {
    root.append(flowElement("p", "table-flow-muted", t("activity.join.approvedChooseHero")));
    if (game.joinEntrance) root.append(flowElement("p", "table-flow-notice", game.joinEntrance));
    const choices = [...(game.savedHeroChoices ?? []), ...(game.joinChoices ?? [])];
    if (!choices.some((hero) => hero.id === app.joinHeroSelection)) app.joinHeroSelection = null;
    const list = flowElement("div", "table-join-choices");
    for (const hero of choices) {
      const button = makeButton("", () => { app.joinHeroSelection = hero.id; renderJoiningPanel(game); });
      button.classList.add("table-join-choice");
      button.append(flowElement("strong", "", hero.name), flowElement("small", "", classText(hero.className)));
      button.setAttribute("aria-pressed", String(hero.id === app.joinHeroSelection));
      list.append(button);
    }
    root.append(list);
    const confirm = makeButton(text("confirmCharacter"), () => void performAction({ kind: "joinHero", heroRef: app.joinHeroSelection }), true);
    confirm.disabled = app.joinHeroSelection === null;
    const feedback = message();
    const actions = actionRow();
    actions.append(confirm, makeButton(t("activity.characters.create"), () => void createCharacter().catch((error) => { feedback.textContent = error.message; })));
    root.append(flowElement("p", "table-flow-muted", text("joinTiming")), actions, feedback);
  } else {
    root.append(flowElement("p", "table-flow-muted", text(game.canRequestJoin ? "requestHelp" : "noOpenSeats")));
    if (game.canRequestJoin) root.append(makeButton(t("activity.lobby.action.request"), () => void performAction({ kind: "requestJoin" }), true));
  }
}
