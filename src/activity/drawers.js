import { app } from "./state.js";
import { iconImage, setArtwork } from "./dom.js";
import { t } from "./i18n.js";
import { partyStatusText } from "./party.js";
import { readyRules } from "./rules-book.js";
import { buildStoryFeed, buildStoryStrip, onStoryNews, resetStory, retranslateStory, storyOpened } from "./story.js";

// The party, the map and the story sit in panels that slide in from the edge of the screen, each with a tab on its edge. They are built once,
// and the party's and the map's own markup is moved into them, so everything that paints those sections keeps working where it is.
const drawers = {};
const order = [];

// The bookmarks and the portrait rail ride the panels' edge. While a panel slides, they read where its edge really is on every frame (--dock-w), so they never drift from it,
// and when one panel is going out as another comes in they stay with the wider of the two.
function placeDock() {
  if (!window.matchMedia("(min-width: 901px)").matches) return;
  let edge = 0;
  for (const entry of Object.values(drawers)) {
    const right = entry.drawer.getBoundingClientRect().right;
    if (entry.drawer.dataset.open === "true" || right > 0) edge = Math.max(edge, right);
  }
  document.body.style.setProperty("--dock-w", `${Math.round(edge)}px`);
}
function followDock() {
  const end = performance.now() + 450;
  const tick = () => { placeDock(); if (performance.now() < end) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
window.addEventListener("resize", placeDock);

function makeDrawer(side, titleKey, body, onOpen) {
  const drawer = document.createElement("aside");
  drawer.className = "drawer";
  drawer.id = `drawer-${side}`;
  drawer.dataset.side = side;
  drawer.dataset.open = "false";
  const content = document.createElement("div");
  content.className = "drawer-body";
  content.append(body);
  drawer.append(content);

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "drawer-tab";
  tab.dataset.side = side;
  tab.setAttribute("aria-controls", drawer.id);
  tab.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  const badge = document.createElement("span");
  badge.className = "drawer-badge";
  badge.hidden = true;
  tab.append(label, badge);

  const entry = { drawer, tab, badge, titleKey, label, dots: null, onOpen };
  entry.set = (open) => {
    if (drawer.dataset.open === String(open)) return;
    drawer.dataset.open = String(open);
    tab.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle(`drawer-open-${side}`, open);
    if (open) {
      // The panels are bookmarks on one edge: only one is out at a time.
      for (const other of Object.values(drawers)) if (other !== entry) other.set(false);
      order.splice(order.indexOf(side), 1);
      order.push(side);
      entry.onOpen?.();
    }
    followDock();
  };
  tab.addEventListener("click", () => { app.drawerAuto[side] = false; entry.set(drawer.dataset.open !== "true"); });
  document.body.append(drawer, tab);
  drawers[side] = entry;
  order.push(side);
  return entry;
}

export function mountDrawers() {
  if (drawers.left !== undefined) return;
  const party = document.querySelector(".party-section");
  const map = document.querySelector(".adventure-map-panel");
  const scene = document.querySelector(".live-scene");
  if (party === null || map === null || scene === null) return;
  // The map is a drawer now: it is always open inside it, and the drawer is what hides it.
  map.setAttribute("open", "");
  makeDrawer("left", "activity.drawer.party", party);
  // Fonts, card details and responsive widths can change the roster between game updates.
  const partySize = new ResizeObserver(() => fitPartyDrawer(party));
  partySize.observe(party);
  makeDrawer("bottom", "activity.drawer.map", map);
  const story = makeDrawer("right", "activity.drawer.story", buildStoryFeed(), () => {
    storyOpened();
    app.unreadStory = 0;
    drawers.right.badge.hidden = true;
  });
  scene.after(buildStoryStrip(() => story.set(true)));
  onStoryNews((news) => {
    if (news === 0 || story.drawer.dataset.open === "true") return;
    app.unreadStory += news;
    story.badge.textContent = String(app.unreadStory);
    story.badge.hidden = false;
  });
  const rulesBook = document.querySelector("#rules-book");
  if (rulesBook !== null) {
    const rules = makeDrawer("rules", "activity.rules.title", rulesBook, readyRules);
    rules.tab.prepend(Object.assign(document.createElement("img"), { alt: "", src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20"/><path d="M9 8h7M9 11.5h5"/></svg>')}` }));
    rules.tab.firstElementChild.setAttribute("aria-hidden", "true");
  }
  const dots = document.createElement("span");
  dots.className = "drawer-dots";
  drawers.left.dots = dots;
  drawers.left.tab.append(dots);
  // On wide screens the party is a rail of portraits down the left edge, and the story and the map are icon buttons down the right.
  const rail = document.createElement("nav");
  rail.className = "party-rail";
  rail.id = "party-rail";
  document.body.append(rail);
  drawers.left.rail = rail;
  // The party icon: two figures side by side.
  const partyIcon = Object.assign(document.createElement("img"), { alt: "", src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="8" cy="8" r="3.6"/><path d="M1.5 20c0-4 3-6.6 6.5-6.6s6.5 2.6 6.5 6.6z"/><circle cx="17" cy="9" r="3"/><path d="M15 13.6c.6-.2 1.300-.3 2-.3 3.100 0 5.500 2.300 5.500 5.700h-6.200c0-2-.5-4-1.300-5.400z"/></svg>')}` });
  partyIcon.setAttribute("aria-hidden", "true");
  drawers.left.tab.prepend(partyIcon);
  drawers.right.tab.prepend(iconImage("clue"));
  drawers.bottom.tab.prepend(iconImage("move"));
  // Escape puts away the panel opened last.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = [...order].reverse().find((side) => drawers[side].drawer.dataset.open === "true");
    if (open !== undefined && !document.querySelector("dialog[open]")) drawers[open].set(false);
  });
  paintTitles();
}

function paintTitles() {
  for (const entry of Object.values(drawers)) {
    const text = t(entry.titleKey);
    entry.label.textContent = text;
    entry.tab.title = text;
    entry.tab.setAttribute("aria-label", text);
    entry.drawer.setAttribute("aria-label", text);
  }
}

function fitPartyDrawer(party) {
  const fit = Math.ceil(party.getBoundingClientRect().height);
  if (fit > 0) drawers.left.drawer.style.setProperty("--drawer-fit", `${fit + 2}px`);
}

// The rules book is the fourth bookmark; asking for it brings its panel out.
export function showRules() { drawers.rules?.set(true); }

// Leaving a game for the lobby: every panel put away, and nothing of that game's story or turn left behind.
export function resetDrawers() {
  for (const entry of Object.values(drawers)) entry.set(false);
  for (const side of Object.keys(app.drawerAuto)) app.drawerAuto[side] = false;
  app.wasMyTurn = false;
  app.unreadStory = 0;
  if (drawers.right !== undefined) drawers.right.badge.hidden = true;
  delete document.body.dataset.gameKind;
  drawers.left?.rail?.replaceChildren();
  resetStory();
}

// One portrait per hero down the left edge, ringed with its health, so who is hurt is in view without opening the party. Tapping one opens the party.
function paintPartyRail(game) {
  const rail = drawers.left.rail;
  if (rail === undefined) return;
  const open = drawers.left.drawer.dataset.open === "true";
  // On a phone the rail is hidden, so the Party button carries the mark: amber while another hero is still deciding.
  drawers.left.tab.dataset.turn = game.party.some((hero) => !hero.isYou && hero.presence !== "away" && !hero.down && !hero.fallen && (hero.tableStatus === "acting" || (hero.tableStatus === "waiting" && game.mode !== "combat"))) ? "thinking" : "";
  const measure = () => document.body.style.setProperty("--rail-h", `${Math.ceil(rail.getBoundingClientRect().height)}px`);
  rail.replaceChildren(...game.party.map((hero) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rail-hero";
    const state = hero.fallen ? "dead" : hero.down ? "down" : hero.presence === "away" ? "away" : "well";
    button.dataset.state = state;
    if (hero.isYou) button.classList.add("is-you");
    const share = hero.maxHp > 0 ? Math.max(0, Math.min(100, Math.round(hero.hp / hero.maxHp * 100))) : 0;
    button.style.setProperty("--hp", `${share}%`);
    // Who is still thinking (their turn now, or in a scene not yet in) and who has finished: a pulsing dot or a check on the portrait.
    const status = hero.tableStatus ?? "waiting";
    const thinking = state === "well" && (status === "acting" || (status === "waiting" && game.mode !== "combat"));
    const finished = state === "well" && ["done", "submitted", "passed"].includes(status);
    if (thinking) button.dataset.turn = "thinking";
    else if (finished) button.dataset.turn = "finished";
    button.title = `${hero.name} · ${hero.hp} / ${hero.maxHp} · ${partyStatusText(hero)}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-controls", drawers.left.drawer.id);
    button.setAttribute("aria-expanded", String(open));
    const face = document.createElement("span");
    face.className = "rail-face";
    const letter = document.createElement("span");
    letter.textContent = [...hero.name][0] ?? "?";
    letter.setAttribute("aria-hidden", "true");
    const image = document.createElement("img");
    image.alt = "";
    face.append(letter, image);
    void setArtwork(image, letter, hero.imageUrl, "");
    button.append(face);
    if (thinking || finished) button.append(Object.assign(document.createElement("i"), { className: "rail-mark" }));
    button.addEventListener("click", () => { app.drawerAuto.left = false; drawers.left.set(drawers.left.drawer.dataset.open !== "true"); paintPartyRail(game); });
    return button;
  }));
  measure();
}

// Called on every paint of the game: the party tab's dots, the words in the language of the game, and the map coming up by itself on your turn.
export function syncDrawers(game) {
  if (drawers.left === undefined) return;
  document.body.dataset.gameKind = game.kind;
  paintTitles();
  // Words already in the feed are written again when the language changes.
  if (app.drawerLanguage !== app.uiLanguage) { app.drawerLanguage = app.uiLanguage; retranslateStory(); }
  if (game.kind !== "table") {
    for (const entry of Object.values(drawers)) entry.set(false);
    return;
  }
  // An open seat is exactly as tall as a hero's card, so a seat and a hero take the same room.
  const card = document.querySelector("#live-party > .live-party-card:not(.party-open-seat)");
  if (card !== null && card.offsetHeight > 0) document.querySelector("#live-party").style.setProperty("--seat-h", `${card.offsetHeight}px`);
  // Fit the cards immediately; the observer keeps the measurement current between paints.
  fitPartyDrawer(document.querySelector(".party-section"));
  drawers.left.dots.replaceChildren(...game.party.map((hero) => {
    const dot = document.createElement("i");
    dot.dataset.state = hero.fallen ? "dead" : hero.down ? "down" : hero.presence === "away" ? "away" : game.mode === "collecting" && hero.tableStatus === "waiting" ? "thinking" : "well";
    dot.title = hero.name;
    return dot;
  }));
  paintPartyRail(game);
  // The map opens when your turn to move comes round and puts itself away when the turn is over, unless you took it over by hand.
  const turn = game.yourTurn && game.mode === "combat";
  // It no longer opens by itself on your turn: it covered the actions. A map held open for the turn is still put away when it ends.
  if (!turn && app.wasMyTurn && app.drawerAuto.bottom) { app.drawerAuto.bottom = false; drawers.bottom.set(false); }
  app.wasMyTurn = turn;
}
