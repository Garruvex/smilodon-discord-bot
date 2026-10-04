// Design preview only (?design-preview&layout): the whole proposal in one page. The latest line of the story sits as a subtitle on the scene art,
// the party in a drawer on the left (so no one else's card needs to open anything), the full story in a drawer on the right, and the map in a sheet along the bottom (moved here from its card, since maps run sideways). Below 900px both become one bottom dock.
// Nothing here ships: it builds its own markup and styles on top of the preview page.
import { buildStoryPanel, css as storyCss } from "./story-preview.js";

const zh = new URLSearchParams(window.location.search).get("language") === "zh-TW";
const words = zh
  ? { map: "地圖", story: "故事", pin: "釘選", unpin: "取消釘選", close: "關閉", bar: "預覽控制", narrate: "新旁白", hit: "戰鬥事件", down: "英雄倒下", slain: "敵人倒下", turn: "輪到我了", turnDone: "我行動完了", more: "點擊閱讀全部", dock: "底部面板" }
  : { map: "Map", story: "Story", pin: "Pin", unpin: "Unpin", close: "Close", bar: "Preview controls", narrate: "New narration", hit: "Combat event", down: "Hero goes down", slain: "Enemy falls", turn: "My turn", turnDone: "I'm done", more: "Tap to read it all", dock: "Bottom dock" };

// What the controls can send. A subtitle shows narration (kept) and combat lines (they fade); an alert interrupts both.
const script = zh ? {
  narrate: [
    "哨兵的拳頭砸進石地，碎石四濺。祭壇後的藍光越來越亮，彷彿整座聖堂都在呼吸。",
    "皮普靠著石柱慢慢站起來，手還在發抖，卻握緊了短弓。長廊盡頭傳來另一種更輕的腳步聲，不像石頭，更像是赤腳踩在濕地上的聲音，一步，又一步，越來越近。",
  ],
  hit: [
    { kind: "combat", who: "艾莉亞・維爾", text: "用法杖攻擊 霍洛哨兵", detail: "命中 (18 對 AC 17)，造成 5 點傷害" },
    { kind: "combat", who: "霍洛哨兵", text: "用石拳攻擊 索恩・橡盾", detail: "未命中 (8 對 AC 18)" },
  ],
  down: { kind: "alert", text: "皮普倒下了！", tone: "down" },
  slain: { kind: "alert", text: "霍洛哨兵倒下了。", tone: "slain" },
} : {
  narrate: [
    "The sentinel's fist cracks into the stone floor and sends chips flying. The blue light behind the altar swells until the whole chapel seems to breathe.",
    "Pip pushes up from the pillar, hands still shaking, and tightens a grip on the shortbow. Down the gallery comes another sound, lighter than stone: bare feet on wet ground, one step, then another, closer and closer.",
  ],
  hit: [
    { kind: "combat", who: "Aria Vell", text: "strikes the Hollow Sentinel with a quarterstaff", detail: "Hit (18 vs AC 17), 5 damage" },
    { kind: "combat", who: "Hollow Sentinel", text: "swings a stone fist at Thorne Oakshield", detail: "Miss (8 vs AC 18)" },
  ],
  down: { kind: "alert", text: "Pip is down!", tone: "down" },
  slain: { kind: "alert", text: "The Hollow Sentinel falls.", tone: "slain" },
};

const layoutCss = `
:root { --lp-gutter: clamp(16px, 3.5vw, 48px); --lp-side-h: min(calc(100vh - 48px), 680px); --lp-map-h: min(68vh, 520px); --lp-left-w: 320px; --lp-right-w: 340px; /* as wide as the page's own panels: the shell is 1120px with a gutter each side */ --lp-map-w: min(calc(1120px - 2 * var(--lp-gutter)), calc(100vw - 2 * var(--lp-gutter))); }
.lp-tab { position: fixed; z-index: 60; top: 50%; transition: left .22s ease, right .22s ease, bottom .22s ease; display: flex; align-items: center; gap: 8px; padding: 14px 7px; border: 1px solid #796546; background: #211e1bf2; color: #eee7d9; font: 800 12px/1 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; writing-mode: vertical-rl; box-shadow: 0 6px 24px #0008; transform: translateY(-50%); }
.lp-tab[data-side="left"] { left: 0; border-left: 0; border-radius: 0 10px 10px 0; }
.lp-tab[data-side="bottom"] { top: auto; transition: bottom .22s ease; bottom: 0; left: 50%; padding: 8px 18px; border-bottom: 0; border-radius: 10px 10px 0 0; writing-mode: horizontal-tb; transform: translateX(-50%); }
.lp-tab[data-side="right"] { right: 0; border-right: 0; border-radius: 10px 0 0 10px; }
.lp-tab[aria-expanded="true"] { background: #4a3b27; border-color: #e5c988; }
.lp-badge { min-width: 18px; padding: 3px 5px; border-radius: 999px; background: #a43c31; color: #fff0d4; font: 800 10px/1 system-ui, sans-serif; text-align: center; writing-mode: horizontal-tb; letter-spacing: 0; }
.lp-badge[hidden] { display: none; }
.lp-drawer { position: fixed; z-index: 55; top: calc((100vh - var(--lp-side-h)) / 2); height: var(--lp-side-h); width: min(340px, 92vw); display: flex; flex-direction: column; border: 1px solid #9c7a4b; background: #f3e7cb; color: #33241a; box-shadow: 0 10px 40px #000a; transition: transform .22s ease; }
.lp-drawer[data-side="left"] { left: 0; border-left: 0; border-radius: 0 12px 12px 0; transform: translateX(-104%); width: min(var(--lp-left-w), 92vw); }
.lp-drawer[data-side="left"] .party-section { margin: 0; padding: 10px; background: transparent; border: 0; box-shadow: none; }
.lp-drawer[data-side="left"] .live-party-grid { grid-template-columns: minmax(0, 1fr); }
.lp-drawer[data-side="left"] .section-heading { display: none; }
/* One line for the class, so the whole party fits without scrolling. */
.lp-drawer[data-side="left"] .party-class-line { display: flex; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lp-drawer[data-side="bottom"] { z-index: 57; top: auto; bottom: 0; left: 50%; right: auto; width: var(--lp-map-w); height: var(--lp-map-h); border-bottom: 0; border-radius: 12px 12px 0 0; transform: translate(-50%, 104%); }
.lp-drawer[data-side="bottom"][data-open="true"] { transform: translate(-50%, 0); }
.lp-tab[data-side="bottom"][aria-expanded="true"] { bottom: var(--lp-map-h); }
/* A tab rides the edge of its panel: out to the panel's edge when it opens, back to the screen edge when it closes. */
body.lp-open-left .lp-tab[data-side="left"] { left: var(--lp-left-w); }
body.lp-open-right .lp-tab[data-side="right"] { right: var(--lp-right-w); }
.lp-drawer[data-side="right"] { right: 0; border-right: 0; border-radius: 12px 0 0 12px; transform: translateX(104%); width: min(var(--lp-right-w), 92vw); }
.lp-drawer[data-open="true"] { transform: none; }
.lp-drawer-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #c4a874; background: #e8d6af; font: 800 12px/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #5c4128; }
.lp-drawer-head h2 { flex: 1; margin: 0; font: inherit; }
.lp-drawer-head button { padding: 5px 9px; border: 1px solid #b39a70; border-radius: 6px; background: #f6ebd0; color: #513b29; font: 700 11px/1 system-ui, sans-serif; cursor: pointer; }
.lp-drawer-body { flex: 1; min-height: 0; overflow: auto; }
.lp-drawer[data-side="right"] .lp-drawer-body { display: flex; flex-direction: column; overflow: hidden; }
.lp-drawer[data-side="right"] .sp { flex: 1; border: 0; border-radius: 0; box-shadow: none; }
.lp-drawer[data-side="right"] .sp-head { display: none; }
.lp-drawer[data-side="right"] .lp-sp-tabs { padding: 8px 12px 0; }
.lp-drawer .adventure-map-panel { margin: 0; border: 0; border-radius: 0; box-shadow: none; }
body.lp-pin-left .live-shell { padding-left: calc(var(--lp-left-w) + 16px); }
body.lp-pin-right .live-shell { padding-right: calc(var(--lp-right-w) + 16px); }
body.lp-party-moved .live-feature-grid { grid-template-columns: minmax(0, 1fr); }
body.lp-party-moved .live-feature-grid > .live-hero { grid-column: 1; }
.lp-dots { display: inline-flex; flex-direction: column; gap: 3px; writing-mode: horizontal-tb; }
.lp-dots i { width: 8px; height: 8px; border-radius: 50%; background: #7a9a62; }
.lp-dots i[data-state="down"] { background: #d7873a; }
.lp-dots i[data-state="dead"] { background: #b4584c; }
.lp-dots i[data-state="away"] { background: #6b6358; }
body.lp-pin-bottom .live-shell { padding-bottom: calc(var(--lp-map-h) + 20px); }
/* the subtitle on the scene art */
/* A strip of its own right under the scene card, so it never covers the art; the page orders sections by their order value, and sharing the scene's keeps it next to it. */
.lp-sub { order: 1; display: flex; align-items: center; gap: 14px; min-height: 62px; margin: 8px 0 0; padding: 10px 14px; border: 1px solid #5d4d38; border-left: 4px solid #a98550; border-radius: 8px; background: #211e1b; color: #f2e8d2; font: 15px/1.45 Georgia, "Noto Serif TC", serif; text-align: left; cursor: pointer; box-sizing: border-box; transition: opacity .6s ease; }
.lp-sub[hidden] { display: none; }
.lp-sub[data-fading="true"] { opacity: .55; }
.lp-sub-text { flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lp-sub[data-kind="narration"] .lp-sub-text { font-style: italic; }
.lp-sub[data-kind="combat"] .lp-sub-text { font: 13px/1.4 system-ui, sans-serif; }
.lp-sub small { flex: none; margin: 0; color: #d9c48f; font: 700 10px/1.2 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; }
.lp-sub[data-kind="alert"] { border-color: #b4584c; border-left-color: #e0897c; background: #3a1411; font: 800 16px/1.35 system-ui, sans-serif; }
.lp-sub[data-kind="alert"][data-tone="slain"] { border-color: #c9a24a; background: #352a0c; }
.lp-sub.is-new { animation: lp-in .45s ease-out; }
@keyframes lp-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.sp-entry[data-kind="alert"] { align-self: flex-start; padding: 3px 10px; border-radius: 6px; background: #f1c5bd; color: #7a1f17; font: 800 12px/1.4 system-ui, sans-serif; }
.sp-entry[data-kind="alert"][data-tone="slain"] { background: #f0dba4; color: #5a430c; }
/* the preview's own controls */
.lp-bar { position: fixed; z-index: 90; top: 8px; left: 50%; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; justify-content: center; max-width: calc(100% - 140px); padding: 5px 6px; border: 1px solid #796546; border-radius: 10px; background: #211e1bf2; color: #eee7d9; font: 700 11px/1 system-ui, sans-serif; box-shadow: 0 6px 24px #0008; transform: translateX(-50%); }
.lp-bar span { padding: 0 6px; color: #c8b794; }
.lp-bar button { padding: 6px 9px; border: 1px solid #5d4d38; border-radius: 7px; background: #2c2620; color: inherit; font: inherit; cursor: pointer; }
/* below 900px: one bottom dock with Map | Story, and the drawers become sheets */
@media (max-width: 900px) {
  .lp-tab { top: auto; bottom: 0; width: 33.34%; justify-content: center; padding: 12px 8px; border: 1px solid #796546; border-radius: 0; writing-mode: horizontal-tb; transform: none; }
  .lp-tab[data-side="left"] { left: 0; right: auto; border-left: 1px solid #796546; border-radius: 0; }
  .lp-tab[data-side="bottom"] { left: 33.33%; right: auto; bottom: 0; padding: 12px 8px; border: 1px solid #796546; border-radius: 0; transform: none; }
  .lp-tab[data-side="bottom"][aria-expanded="true"] { bottom: 0; }
  .lp-tab[data-side="right"] { right: 0; left: auto; }
  .lp-dots { flex-direction: row; }
  .lp-drawer, .lp-drawer[data-side="bottom"], .lp-drawer[data-side="left"] { top: auto; bottom: 44px; left: 0; right: 0; width: auto; height: 62vh; border: 1px solid #9c7a4b; border-radius: 12px 12px 0 0; }
  .lp-drawer[data-side="bottom"], .lp-drawer[data-side="right"], .lp-drawer[data-side="left"] { border-radius: 12px 12px 0 0; transform: translateY(110%); }
  .lp-drawer[data-open="true"], .lp-drawer[data-side="bottom"][data-open="true"] { transform: none; }
  body.lp-open-left .lp-tab[data-side="left"] { left: 0; }
  body.lp-open-right .lp-tab[data-side="right"] { right: 0; }
  body.lp-pin-left .live-shell, body.lp-pin-bottom .live-shell, body.lp-pin-right .live-shell { padding-left: 0; padding-right: 0; padding-bottom: 60px; }
  .live-shell { padding-bottom: 60px; }
  .lp-bar { top: auto; bottom: 52px; max-width: calc(100% - 16px); }
  .lp-pin { display: none; }
  .lp-sub { min-height: 0; padding: 8px 10px; font-size: 14px; }
  .lp-sub small { display: none; }
  .lp-sub-text { -webkit-line-clamp: 2; }
}
`;

export function mountLayoutPreview() {
  const style = document.createElement("style");
  style.textContent = storyCss + layoutCss;
  document.head.append(style);

  const { panel, add } = buildStoryPanel();
  // The story's own tabs (Story | Combat | All) go up into the drawer head, where the drawer's title would be.
  const innerTabs = panel.querySelector(".sp-tabs");
  innerTabs.classList.add("lp-sp-tabs");
  panel.prepend(innerTabs);

  const drawers = {};
  const tabs = {};
  const makeDrawer = (side, title, body) => {
    const drawer = document.createElement("aside");
    drawer.className = "lp-drawer";
    drawer.dataset.side = side;
    drawer.dataset.open = "false";
    drawer.setAttribute("aria-label", title);
    const head = document.createElement("header");
    head.className = "lp-drawer-head";
    const h = document.createElement("h2");
    h.textContent = title;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "lp-pin";
    pin.textContent = words.pin;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = words.close;
    head.append(h, pin, close);
    const content = document.createElement("div");
    content.className = "lp-drawer-body";
    content.append(body);
    drawer.append(head, content);
    document.body.append(drawer);
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "lp-tab";
    tab.dataset.side = side;
    tab.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.textContent = title;
    const badge = document.createElement("span");
    badge.className = "lp-badge";
    badge.hidden = true;
    tab.append(label, badge);
    document.body.append(tab);
    const set = (open) => {
      drawer.dataset.open = String(open);
      tab.setAttribute("aria-expanded", String(open));
      document.body.classList.toggle(`lp-open-${side}`, open);
      if (open && side === "right") { unread = 0; badge.hidden = true; const feed = panel.querySelector(".sp-feed"); feed.scrollTop = feed.scrollHeight; }
      // On a narrow screen only one sheet is up at a time.
      if (open && window.matchMedia("(max-width: 900px)").matches) for (const other of Object.keys(drawers)) if (other !== side) drawers[other].set(false);
    };
    tab.addEventListener("click", () => set(drawer.dataset.open !== "true"));
    close.addEventListener("click", () => set(false));
    pin.addEventListener("click", () => {
      const pinned = !document.body.classList.contains(`lp-pin-${side}`);
      document.body.classList.toggle(`lp-pin-${side}`, pinned);
      pin.textContent = pinned ? words.unpin : words.pin;
      if (pinned) set(true);
    });
    drawers[side] = { set, drawer, badge };
    tabs[side] = tab;
  };

  let unread = 0;
  // The roster moves out of the page into a left drawer; its edge tab shows one dot per hero (green well, orange down, red fallen, grey away).
  const partySection = document.querySelector(".party-section");
  if (partySection !== null) {
    makeDrawer("left", zh ? "隊伍" : "Party", partySection);
    document.body.classList.add("lp-party-moved");
    const dots = document.createElement("span");
    dots.className = "lp-dots";
    const paintDots = () => {
      dots.replaceChildren(...[...partySection.querySelectorAll(".live-party-card")].map((card) => {
        const dot = document.createElement("i");
        dot.dataset.state = card.dataset.condition !== "healthy" ? card.dataset.condition : card.dataset.presence === "away" ? "away" : "well";
        return dot;
      }));
    };
    paintDots();
    new MutationObserver(paintDots).observe(partySection, { childList: true, subtree: true });
    tabs.left.append(dots);
  }
  const mapPanel = document.querySelector(".adventure-map-panel");
  if (mapPanel !== null) {
    mapPanel.setAttribute("open", "");
    makeDrawer("bottom", words.map, mapPanel);
  }
  makeDrawer("right", words.story, panel);

  // The subtitle.
  const sub = document.createElement("div");
  sub.className = "lp-sub";
  sub.hidden = true;
  sub.setAttribute("role", "status");
  sub.setAttribute("aria-live", "polite");
  const subText = document.createElement("span");
  subText.className = "lp-sub-text";
  const subMore = document.createElement("small");
  subMore.textContent = words.more;
  sub.append(subText, subMore);
  document.querySelector(".live-scene")?.after(sub);
  sub.addEventListener("click", () => drawers.right.set(true));
  let fade = null;
  const show = (entry) => {
    clearTimeout(fade);
    const text = entry.kind === "combat" ? `${entry.who} ${entry.text} · ${entry.detail}` : entry.text;
    subText.textContent = text;
    sub.dataset.kind = entry.kind;
    if (entry.tone) sub.dataset.tone = entry.tone; else delete sub.dataset.tone;
    sub.dataset.fading = "false";
    sub.hidden = false;
    sub.classList.remove("is-new");
    void sub.offsetWidth;
    sub.classList.add("is-new");
    // Narration stays until something newer arrives; a combat line dims after six seconds and an alert after eight, but the strip keeps its height so nothing jumps.
    if (entry.kind === "combat") fade = setTimeout(() => { sub.dataset.fading = "true"; }, 6000);
    if (entry.kind === "alert") fade = setTimeout(() => { sub.dataset.fading = "true"; }, 8000);
  };

  const send = (entry) => {
    add(entry, true);
    // Rolls, actions and system lines go to the log only.
    if (["narration", "combat", "alert"].includes(entry.kind)) show(entry);
    if (drawers.right.drawer.dataset.open !== "true" && ["narration", "alert", "action", "roll"].includes(entry.kind)) {
      unread += 1;
      drawers.right.badge.textContent = String(unread);
      drawers.right.badge.hidden = false;
    }
  };
  // The first line is the newest of what the panel already holds.
  show({ kind: "narration", text: zh ? "哨兵發出低沉的轟鳴，石頭的裂縫中透出藍光。" : "The sentinel gives a low rumble, and blue light seeps through the cracks in its stone." });

  // Controls.
  const bar = document.createElement("div");
  bar.className = "lp-bar";
  const label = document.createElement("span");
  label.textContent = words.bar;
  bar.append(label);
  const control = (text, run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", run);
    bar.append(button);
    return button;
  };
  let nn = 0, nh = 0;
  control(words.narrate, () => { send({ kind: "narration", text: script.narrate[nn % script.narrate.length] }); nn += 1; });
  control(words.hit, () => { send(script.hit[nh % script.hit.length]); nh += 1; });
  control(words.down, () => send(script.down));
  control(words.slain, () => send(script.slain));
  // The map opens by itself when it is the player's turn to move, and closes once they have acted.
  let myTurn = false;
  const turn = control(words.turn, () => {
    myTurn = !myTurn;
    turn.textContent = myTurn ? words.turnDone : words.turn;
    drawers.bottom?.set(myTurn);
  });
  document.body.append(bar);
}
