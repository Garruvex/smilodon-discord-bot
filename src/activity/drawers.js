import { app } from "./state.js";
import { t } from "./i18n.js";
import { buildStoryFeed, buildStoryStrip, onStoryNews, retranslateStory, storyOpened } from "./story.js";

// The party, the map and the story sit in panels that slide in from the edge of the screen, each with a tab on its edge. They are built once,
// and the party's and the map's own markup is moved into them, so everything that paints those sections keeps working where it is.
const drawers = {};
const order = [];

function makeDrawer(side, titleKey, body, onOpen) {
  const drawer = document.createElement("aside");
  drawer.className = "drawer";
  drawer.id = `drawer-${side}`;
  drawer.dataset.side = side;
  drawer.dataset.open = "false";
  const head = document.createElement("header");
  head.className = "drawer-head";
  const title = document.createElement("h2");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ui-control";
  head.append(title, close);
  const content = document.createElement("div");
  content.className = "drawer-body";
  content.append(body);
  drawer.append(head, content);

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

  const entry = { drawer, tab, badge, titleKey, title, close, label, dots: null, onOpen };
  entry.set = (open) => {
    if (drawer.dataset.open === String(open)) return;
    drawer.dataset.open = String(open);
    tab.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle(`drawer-open-${side}`, open);
    if (open) {
      order.splice(order.indexOf(side), 1);
      order.push(side);
      // On a narrow screen the panels are sheets over one another: only one is up at a time.
      if (window.matchMedia("(max-width: 900px)").matches) for (const other of Object.values(drawers)) if (other !== entry) other.set(false);
      entry.onOpen?.();
    }
  };
  tab.addEventListener("click", () => { app.drawerAuto[side] = false; entry.set(drawer.dataset.open !== "true"); });
  close.addEventListener("click", () => { app.drawerAuto[side] = false; entry.set(false); tab.focus(); });
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
  const dots = document.createElement("span");
  dots.className = "drawer-dots";
  drawers.left.dots = dots;
  drawers.left.tab.append(dots);
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
    entry.title.textContent = text;
    entry.label.textContent = text;
    entry.close.textContent = t("activity.drawer.close");
    entry.drawer.setAttribute("aria-label", text);
  }
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
  drawers.left.dots.replaceChildren(...game.party.map((hero) => {
    const dot = document.createElement("i");
    dot.dataset.state = hero.fallen ? "dead" : hero.down ? "down" : hero.presence === "away" ? "away" : "well";
    dot.title = hero.name;
    return dot;
  }));
  // The map opens when your turn to move comes round and puts itself away when the turn is over, unless you took it over by hand.
  const turn = game.yourTurn && game.mode === "combat";
  if (turn && !app.wasMyTurn) { app.drawerAuto.bottom = true; drawers.bottom.set(true); }
  if (!turn && app.wasMyTurn && app.drawerAuto.bottom) { app.drawerAuto.bottom = false; drawers.bottom.set(false); }
  app.wasMyTurn = turn;
}
