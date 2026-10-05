import { t } from "./i18n.js";
import { rollLabel } from "./dice.js";

// The story the table has read, kept in a drawer, and its newest line shown as a strip under the scene.
// game.story is the server's list of entries (newest last); the ids stay the same between snapshots, so only what is new is added.

const combatKinds = new Set(["combat", "alert", "maneuver", "move", "fled", "deathSave"]);
// What counts as news for the badge on the closed drawer: not the fight's blow-by-blow.
const newsKinds = new Set(["narration", "action", "speech", "clue", "cast", "talk", "alert"]);

const feed = { nodes: new Map(), filter: "story", inFight: false, unread: 0, ready: false, element: null, jump: null, tabs: new Map(), listeners: [] };
let strip = null;
let stripFade = null;

function checkText(target) {
  const parts = [];
  if (target.check === "hit") parts.push(t("activity.story.hit", { damage: target.damage }));
  else if (target.check === "critical") parts.push(t("activity.story.critical", { damage: target.damage }));
  else if (target.check === "miss") parts.push(t("activity.story.miss"));
  else if (target.check === "saved") parts.push(target.damage > 0 ? `${t("activity.story.saved")}, ${t("activity.story.damage", { damage: target.damage })}` : t("activity.story.saved"));
  else if (target.check === "failed") parts.push(target.damage > 0 ? `${t("activity.story.failed")}, ${t("activity.story.damage", { damage: target.damage })}` : t("activity.story.failed"));
  else if (target.damage > 0) parts.push(t("activity.story.damage", { damage: target.damage }));
  else if (target.heal > 0) parts.push(t("activity.story.heal", { amount: target.heal }));
  if (target.prone) parts.push(t("activity.story.prone"));
  return parts.length === 0 ? target.name : `${target.name}: ${parts.join(", ")}`;
}

function talkHead(entry) {
  if (entry.roll === null) return t("activity.story.ask", { who: entry.who, npc: entry.npc, question: entry.question ?? "" });
  return `${t("activity.story.press", { who: entry.who, npc: entry.npc })} ${rollLabel(entry.roll.test)} ${entry.roll.total} ${t("activity.dice.versusDc", { dc: entry.roll.dc })} ${entry.roll.success ? "✓" : "✗"}`;
}

// One entry, in words, for the strip and for screen readers.
export function entryText(entry) {
  switch (entry.kind) {
    case "narration": return entry.text;
    case "action": return `${entry.who} ${entry.text}`;
    case "speech": return `${entry.who}: “${entry.text}”`;
    case "clue": return entry.text;
    case "talk": return `${talkHead(entry)}. ${entry.text}`;
    case "cast": return `${t("activity.story.cast", { who: entry.who, spell: entry.spell })}. ${entry.text}`;
    case "roll": return `${entry.who}: ${rollLabel(entry.test)}, ${entry.total} ${t("activity.dice.versusDc", { dc: entry.dc })} ${entry.success ? "✓" : "✗"}`;
    case "combat": return t("activity.story.combatLine", { who: entry.who, using: entry.using, results: entry.targets.map(checkText).join("; ") });
    case "maneuver": return t(`activity.story.${entry.maneuver}`, { who: entry.who });
    case "move": return t("activity.story.move", { who: entry.who, zone: entry.zone });
    case "fled": return t("activity.story.fled", { who: entry.who });
    case "deathSave": {
      const result = entry.condition === "stable" ? "deathStable" : entry.condition === "dead" ? "deathDead" : entry.condition === "active" ? "deathRises" : "deathHolds";
      return t("activity.story.deathSave", { who: entry.who, natural: entry.natural, result: t(`activity.story.${result}`) });
    }
    case "alert": return t(entry.tone === "slain" ? "activity.story.alertSlain" : "activity.story.alertDown", { name: entry.name });
    case "system":
      return entry.code === "scene" ? t("activity.story.scene", { scene: entry.text ?? "" }) : t(`activity.story.${entry.code}`);
    default: return "";
  }
}

function entryNode(entry) {
  const node = document.createElement("p");
  node.className = "story-entry";
  node.dataset.id = entry.id;
  node.dataset.kind = entry.kind;
  node.dataset.group = combatKinds.has(entry.kind) ? "combat" : entry.kind === "system" ? "system" : "story";
  fillNode(node, entry);
  return node;
}

function fillNode(node, entry) {
  if (entry.kind === "roll") {
    node.dataset.ok = String(entry.success);
    const who = document.createElement("b");
    who.textContent = entry.who;
    const total = document.createElement("i");
    total.textContent = String(entry.total);
    node.replaceChildren(who, ` ${rollLabel(entry.test)} `, total, ` ${t("activity.dice.versusDc", { dc: entry.dc })} ${entry.success ? "✓" : "✗"}`);
  } else if (entry.kind === "cast" || entry.kind === "talk") {
    const head = document.createElement("b");
    head.textContent = entry.kind === "talk" ? talkHead(entry) : t("activity.story.cast", { who: entry.who, spell: entry.spell });
    const told = document.createElement("span");
    told.textContent = entry.text;
    node.replaceChildren(head, told);
  } else if (entry.kind === "clue") {
    node.textContent = `🔍 ${entry.text}`;
  } else if (entry.kind === "action" || entry.kind === "speech") {
    const who = document.createElement("b");
    who.textContent = entry.who;
    node.replaceChildren(who, entry.kind === "action" ? ` ${entry.text}` : `: “${entry.text}”`);
  } else if (entry.kind === "combat") {
    node.dataset.source = entry.source ?? "weapon";
    const who = document.createElement("b");
    who.textContent = entry.who;
    const detail = document.createElement("small");
    detail.textContent = `${entry.using} → ${entry.targets.map(checkText).join("; ")}`;
    node.replaceChildren(who, detail);
  } else {
    if (entry.kind === "alert") node.dataset.tone = entry.tone;
    if (entry.kind === "system") node.dataset.code = entry.code;
    node.textContent = entryText(entry);
  }
}

const atBottom = () => feed.element.scrollHeight - feed.element.scrollTop - feed.element.clientHeight < 40;

function applyFilter() {
  // Out of a fight there is one list, so no tabs; a fight's end puts the reader back on the story.
  if (!feed.inFight) feed.filter = "story";
  for (const [key, button] of feed.tabs) button.setAttribute("aria-pressed", String(key === feed.filter));
  feed.tabs.get("story").parentElement.hidden = !feed.inFight;
  for (const node of feed.element.querySelectorAll(".story-entry")) {
    node.hidden = !(node.dataset.group === feed.filter || node.dataset.group === "system");
  }
  feed.element.dataset.empty = String(![...feed.element.querySelectorAll(".story-entry")].some((node) => !node.hidden));
}

// The feed itself, with its Story and Combat tabs, for the drawer to hold. The Combat tab is there only while a fight is on, and the Story tab never carries its blow-by-blow.
export function buildStoryFeed() {
  const panel = document.createElement("div");
  panel.className = "story-panel";
  const tabs = document.createElement("div");
  tabs.className = "story-tabs";
  for (const [key, label] of [["story", "activity.story.tabStory"], ["combat", "activity.story.tabCombat"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "story-tab ui-control";
    button.dataset.label = label;
    button.textContent = t(label);
    button.addEventListener("click", () => { feed.filter = key; applyFilter(); feed.element.scrollTop = feed.element.scrollHeight; });
    feed.tabs.set(key, button);
    tabs.append(button);
  }
  const log = document.createElement("div");
  log.className = "story-feed";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.dataset.empty = "true";
  const empty = document.createElement("p");
  empty.className = "story-empty";
  empty.textContent = t("activity.story.empty");
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "story-jump";
  jump.hidden = true;
  jump.addEventListener("click", () => { feed.unread = 0; jump.hidden = true; log.scrollTop = log.scrollHeight; });
  log.addEventListener("scroll", () => { if (atBottom()) { feed.unread = 0; jump.hidden = true; } });
  log.append(empty, jump);
  panel.append(tabs, log);
  feed.element = log;
  feed.jump = jump;
  applyFilter();
  return panel;
}

// Called by the drawer when the story opens, so the newest entry is in view and nothing counts as unread.
export function storyOpened() {
  if (feed.element === null) return;
  feed.unread = 0;
  feed.jump.hidden = true;
  feed.element.scrollTop = feed.element.scrollHeight;
}

// The drawer registers here to be told how many entries arrived while it was closed.
export function onStoryNews(listener) { feed.listeners.push(listener); }

// Leaving a game: its story must not carry over into the next one, and the next one's first sight is not "news".
export function resetStory() {
  if (feed.element === null) return;
  retranslateStory();
  feed.unread = 0;
  feed.filter = "story";
  applyFilter();
  feed.jump.hidden = true;
  if (strip !== null) { clearTimeout(stripFade); strip.hidden = true; delete strip.dataset.shown; }
}

export function retranslateStory() {
  for (const button of feed.tabs.values()) button.textContent = t(button.dataset.label);
  if (feed.element === null) return;
  feed.element.querySelector(".story-empty").textContent = t("activity.story.empty");
  feed.nodes.clear();
  for (const node of feed.element.querySelectorAll(".story-entry")) node.remove();
  feed.ready = false;
}

function showStrip(entry) {
  if (strip === null) return;
  clearTimeout(stripFade);
  const text = strip.querySelector(".story-now-text");
  text.textContent = entryText(entry);
  strip.dataset.kind = entry.kind;
  if (entry.kind === "alert") strip.dataset.tone = entry.tone; else delete strip.dataset.tone;
  strip.dataset.dim = "false";
  strip.hidden = false;
  strip.classList.remove("is-new");
  void strip.offsetWidth;
  strip.classList.add("is-new");
  // Narration stays until something newer comes; a fight line or a call-out dims after a few seconds, but the strip keeps its height.
  if (entry.kind === "combat") stripFade = setTimeout(() => { strip.dataset.dim = "true"; }, 6000);
  if (entry.kind === "alert") stripFade = setTimeout(() => { strip.dataset.dim = "true"; }, 8000);
}

// What the strip shows: the newest telling outside a fight, the newest fight line (or call-out) inside one. Actions, speech and
// clues go to the feed only.
const stripKinds = new Set(["narration", "combat", "alert"]);

// The strip under the scene. onOpen is what a press on it does: open the story at the newest entry.
export function buildStoryStrip(onOpen) {
  strip = document.createElement("button");
  strip.type = "button";
  strip.className = "story-now";
  strip.hidden = true;
  strip.setAttribute("aria-live", "polite");
  const text = document.createElement("span");
  text.className = "story-now-text";
  const more = document.createElement("small");
  more.className = "story-now-more";
  more.textContent = t("activity.story.readAll");
  strip.append(text, more);
  strip.addEventListener("click", onOpen);
  return strip;
}

export function renderStory(game) {
  if (feed.element === null || strip === null) return;
  const entries = game.kind === "table" ? game.story ?? [] : [];
  feed.inFight = game.kind === "table" && game.mode === "combat";
  strip.querySelector(".story-now-more").textContent = t("activity.story.readAll");
  const stick = atBottom();
  const ids = new Set(entries.map((entry) => entry.id));
  for (const [id, node] of feed.nodes) if (!ids.has(id)) { node.remove(); feed.nodes.delete(id); }
  const added = [];
  let previous = null;
  for (const entry of entries) {
    let node = feed.nodes.get(entry.id);
    if (node === undefined) {
      node = entryNode(entry);
      if (feed.ready) node.classList.add("is-new");
      feed.nodes.set(entry.id, node);
      added.push(entry);
      if (previous === null) feed.element.insertBefore(node, feed.element.querySelector(".story-empty").nextSibling);
      else previous.after(node);
    } else if (entry.kind === "action") fillNode(node, entry);
    previous = node;
  }
  applyFilter();
  if (added.length > 0 && feed.ready) {
    const news = added.filter((entry) => newsKinds.has(entry.kind)).length;
    if (stick) feed.element.scrollTop = feed.element.scrollHeight;
    else if (news > 0) {
      feed.unread += news;
      feed.jump.hidden = false;
      feed.jump.textContent = `${t("activity.story.new", { count: feed.unread })} · ${t("activity.story.jump")}`;
    }
    for (const listener of feed.listeners) listener(news);
  } else if (!feed.ready) feed.element.scrollTop = feed.element.scrollHeight;
  // The strip follows what is newest and fitting: in a fight the latest fight line, otherwise the latest telling.
  const inFight = feed.inFight;
  const fits = entries.filter((entry) => stripKinds.has(entry.kind) && (inFight || entry.kind === "narration"));
  const newest = fits.at(-1);
  if (newest === undefined) strip.hidden = true;
  else if (strip.dataset.shown !== newest.id) {
    strip.dataset.shown = newest.id;
    // The first sight of the game shows the line without announcing it as new.
    showStrip(newest);
    if (!feed.ready) { strip.classList.remove("is-new"); clearTimeout(stripFade); strip.dataset.dim = "false"; }
  }
  feed.ready = true;
}
