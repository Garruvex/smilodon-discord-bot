// Design preview only (?design-preview&story): a story panel with made-up entries, in four places, so the placement can be chosen by looking at it.
// It builds its own markup and styles and touches nothing else on the page. Switch the place with the bar at the top, or with &placement=scene|side|drawer|subtitle.
const zh = new URLSearchParams(window.location.search).get("language") === "zh-TW";
const words = zh
  ? { title: "故事", story: "故事", combat: "戰鬥", all: "全部", newEntries: (n) => `${n} 則新訊息`, jump: "跳到最新", simulate: "模擬新事件", places: { scene: "場景下方", side: "右側欄", drawer: "底部抽屜", subtitle: "場景字幕" }, bar: "故事面板位置", empty: "還沒有故事。", expand: "展開", collapse: "收合" }
  : { title: "Story", story: "Story", combat: "Combat", all: "All", newEntries: (n) => `${n} new`, jump: "Jump to latest", simulate: "Simulate an event", places: { scene: "Under the scene", side: "Side column", drawer: "Bottom drawer", subtitle: "Scene subtitle" }, bar: "Story panel placement", empty: "Nothing told yet.", expand: "Expand", collapse: "Collapse" };

const entries = zh ? [
  { kind: "narration", text: "月光穿過坍塌的穹頂，照在灰塵瀰漫的聖堂裡。空氣中有一股潮濕的鐵鏽味。" },
  { kind: "action", who: "艾莉亞・維爾", text: "舉起提燈，慢慢走向祭壇。" },
  { kind: "roll", who: "艾莉亞・維爾", text: "奧秘檢定", total: 17, dc: 15, ok: true },
  { kind: "narration", text: "符文在燈光下微微發亮。艾莉亞認出這是守衛咒文：祭壇後面有東西在醒來。" },
  { kind: "system", text: "戰鬥開始" },
  { kind: "combat", who: "霍洛哨兵", text: "用石拳攻擊 艾莉亞・維爾", detail: "命中 (19 對 AC 16)，造成 8 點傷害" },
  { kind: "combat", who: "艾莉亞・維爾", text: "施放魔法飛彈", detail: "3 發飛彈，共 11 點力場傷害" },
  { kind: "combat", who: "皮普", text: "用短弓射擊 霍洛哨兵", detail: "未命中 (9 對 AC 17)" },
  { kind: "narration", text: "哨兵發出低沉的轟鳴，石頭的裂縫中透出藍光。" },
] : [
  { kind: "narration", text: "Moonlight falls through the broken dome onto a chapel thick with dust. The air smells of wet iron." },
  { kind: "action", who: "Aria Vell", text: "raises the lantern and walks slowly toward the altar." },
  { kind: "roll", who: "Aria Vell", text: "Arcana check", total: 17, dc: 15, ok: true },
  { kind: "narration", text: "The runes glow faintly in the lamplight. Aria knows a warding spell when she sees one: something behind the altar is waking." },
  { kind: "system", text: "Combat begins" },
  { kind: "combat", who: "Hollow Sentinel", text: "attacks Aria Vell with a stone fist", detail: "Hit (19 vs AC 16), 8 damage" },
  { kind: "combat", who: "Aria Vell", text: "casts Magic Missile", detail: "3 darts, 11 force damage" },
  { kind: "combat", who: "Pip", text: "shoots the Hollow Sentinel with a shortbow", detail: "Miss (9 vs AC 17)" },
  { kind: "narration", text: "The sentinel gives a low rumble, and blue light seeps through the cracks in its stone." },
];

const more = zh ? [
  { kind: "combat", who: "霍洛哨兵", text: "用石拳攻擊 皮普", detail: "命中 (17 對 AC 14)，造成 6 點傷害" },
  { kind: "narration", text: "皮普被擊退，撞在冰冷的石柱上，喘不過氣來。" },
  { kind: "roll", who: "皮普", text: "體質豁免", total: 12, dc: 13, ok: false },
] : [
  { kind: "combat", who: "Hollow Sentinel", text: "attacks Pip with a stone fist", detail: "Hit (17 vs AC 14), 6 damage" },
  { kind: "narration", text: "Pip is thrown back against a cold pillar, the wind knocked out of them." },
  { kind: "roll", who: "Pip", text: "Constitution save", total: 12, dc: 13, ok: false },
];

const css = `
.sp-bar { position: fixed; z-index: 90; top: 8px; right: 8px; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end; max-width: calc(100% - 16px); padding: 5px 6px; border: 1px solid #796546; border-radius: 10px; background: #211e1bf2; color: #eee7d9; font: 700 11px/1 system-ui, sans-serif; box-shadow: 0 6px 24px #0008; }
.sp-bar span { padding: 0 6px; color: #c8b794; }
.sp-bar button { padding: 6px 9px; border: 1px solid #5d4d38; border-radius: 7px; background: #2c2620; color: inherit; font: inherit; cursor: pointer; }
.sp-bar button[aria-pressed="true"] { border-color: #e5c988; background: #4a3b27; color: #fff1cf; }
.sp { display: flex; flex-direction: column; min-height: 0; border: 1px solid #9c7a4b; border-radius: 10px; background: #f3e7cb; color: #33241a; box-shadow: 0 4px 18px #0004; overflow: hidden; font-family: Georgia, "Noto Serif TC", serif; }
.sp-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #c4a874; background: #e8d6af; font: 800 12px/1 system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: #5c4128; }
.sp-head h2 { margin: 0; font: inherit; flex: 1; }
.sp-tabs { display: flex; gap: 4px; }
.sp-tabs button, .sp-head .sp-fold { padding: 5px 9px; border: 1px solid #b39a70; border-radius: 6px; background: #f6ebd0; color: #513b29; font: 700 11px/1 system-ui, sans-serif; cursor: pointer; }
.sp-tabs button[aria-pressed="true"] { border-color: #87332b; background: #a43c31; color: #fff0d4; }
.sp-feed { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 9px; scroll-behavior: smooth; }
.sp-entry { margin: 0; font-size: 15px; line-height: 1.5; }
.sp-entry[data-kind="narration"] { padding-left: 12px; border-left: 3px solid #a98550; font-style: italic; }
.sp-entry[data-kind="action"] { font-size: 13px; color: #4b3827; }
.sp-entry[data-kind="action"] b, .sp-entry[data-kind="combat"] b, .sp-entry[data-kind="roll"] b { font-family: system-ui, sans-serif; font-size: 12px; }
.sp-entry[data-kind="roll"] { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; padding: 4px 10px; border: 1px solid #b39a70; border-radius: 999px; background: #efe0bd; font: 600 12px/1.3 system-ui, sans-serif; }
.sp-entry[data-kind="roll"] i { font-style: normal; font-weight: 800; }
.sp-entry[data-kind="roll"][data-ok="true"] i { color: #2f6b3a; }
.sp-entry[data-kind="roll"][data-ok="false"] i { color: #9b2f26; }
.sp-entry[data-kind="combat"] { font: 13px/1.4 system-ui, sans-serif; color: #4b3827; }
.sp-entry[data-kind="combat"] small { display: block; color: #7a6244; font-size: 11px; }
.sp-entry[data-kind="system"] { align-self: center; padding: 2px 12px; border-radius: 999px; background: #d9c48f; color: #5c4128; font: 800 10px/1.6 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; }
.sp-entry.is-new { animation: sp-new 1.6s ease-out; }
@keyframes sp-new { from { background: #f5d98a; } to { background: transparent; } }
.sp-jump { align-self: center; position: sticky; bottom: 0; padding: 5px 12px; border: 0; border-radius: 999px; background: #a43c31; color: #fff0d4; font: 800 11px/1 system-ui, sans-serif; cursor: pointer; box-shadow: 0 3px 10px #0006; }
.sp-jump[hidden] { display: none; }
.sp-empty { color: #7a6244; font: italic 13px system-ui, sans-serif; }
/* under the scene */
.sp-place-scene .sp { max-height: 300px; margin: 12px 0; }
/* side column: the page makes room on the right */
.sp-place-side .live-shell { padding-right: 372px; }
.sp-place-side .sp { position: fixed; z-index: 40; top: 54px; right: 12px; bottom: 12px; width: 348px; }
/* bottom drawer */
.sp-place-drawer .live-shell { padding-bottom: 76px; }
.sp-place-drawer .sp { position: fixed; z-index: 40; left: 50%; bottom: 0; width: min(920px, 100%); transform: translateX(-50%); border-radius: 12px 12px 0 0; max-height: 46vh; }
.sp-place-drawer .sp[data-open="false"] { max-height: none; }
.sp-place-drawer .sp[data-open="false"] .sp-feed { overflow: hidden; max-height: 38px; flex-direction: row; align-items: center; }
.sp-place-drawer .sp[data-open="false"] .sp-entry:not(:last-child), .sp-place-drawer .sp[data-open="false"] .sp-tabs, .sp-place-drawer .sp[data-open="false"] .sp-jump { display: none; }
.sp-place-drawer .sp[data-open="true"] { height: 46vh; }
/* subtitle on the scene art */
.sp-place-subtitle .sp { position: absolute; z-index: 5; left: 12px; right: 12px; bottom: 12px; border-color: #ffffff22; background: #17120ee8; color: #f2e8d2; }
.sp-place-subtitle .sp-head { background: transparent; border-color: #ffffff1c; color: #d9c48f; }
.sp-place-subtitle .sp-tabs button, .sp-place-subtitle .sp-fold { background: #2b231c; border-color: #5d4d38; color: #eee7d9; }
.sp-place-subtitle .sp-tabs button[aria-pressed="true"] { background: #a43c31; color: #fff0d4; }
.sp-place-subtitle .sp-entry { color: #f2e8d2; }
.sp-place-subtitle .sp-entry[data-kind="combat"] small, .sp-place-subtitle .sp-entry[data-kind="action"] { color: #cdbd9f; }
.sp-place-subtitle .sp-entry[data-kind="roll"] { background: #2b231c; border-color: #5d4d38; color: #eee7d9; }
.sp-place-subtitle .sp[data-open="false"] .sp-feed { max-height: 88px; overflow: hidden; }
.sp-place-subtitle .sp[data-open="true"] .sp-feed { max-height: 280px; }
.sp-place-subtitle .live-scene { position: relative; }
@media (max-width: 900px) {
  .sp-place-side .live-shell { padding-right: 0; padding-bottom: 76px; }
  .sp-place-side .sp { top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 46vh; border-radius: 12px 12px 0 0; }
}
`;

function entryNode(entry, fresh) {
  const node = document.createElement("p");
  node.className = `sp-entry${fresh ? " is-new" : ""}`;
  node.dataset.kind = entry.kind;
  node.dataset.group = entry.kind === "narration" || entry.kind === "action" ? "story" : "combat";
  if (entry.kind === "roll") {
    node.dataset.ok = String(entry.ok);
    node.dataset.group = "story";
    const who = document.createElement("b");
    who.textContent = entry.who;
    const mark = document.createElement("i");
    mark.textContent = String(entry.total);
    node.append(who, ` · ${entry.text} `, mark, ` ${zh ? "對" : "vs"} DC ${entry.dc} ${entry.ok ? "✓" : "✗"}`);
  } else if (entry.kind === "action") {
    const who = document.createElement("b");
    who.textContent = entry.who;
    node.append(who, ` ${entry.text}`);
  } else if (entry.kind === "combat") {
    const who = document.createElement("b");
    who.textContent = entry.who;
    const detail = document.createElement("small");
    detail.textContent = entry.detail;
    node.append(who, ` ${entry.text}`, detail);
  } else {
    node.textContent = entry.text;
    if (entry.kind === "system") node.dataset.group = "all";
  }
  return node;
}

export function mountStoryPreview() {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);

  const panel = document.createElement("section");
  panel.className = "sp";
  panel.dataset.open = "true";
  panel.setAttribute("aria-label", words.title);
  const head = document.createElement("header");
  head.className = "sp-head";
  const title = document.createElement("h2");
  title.textContent = words.title;
  const tabs = document.createElement("div");
  tabs.className = "sp-tabs";
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "sp-fold";
  head.append(title, tabs, fold);
  const feed = document.createElement("div");
  feed.className = "sp-feed";
  feed.setAttribute("role", "log");
  feed.setAttribute("aria-live", "polite");
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "sp-jump";
  jump.hidden = true;
  panel.append(head, feed);

  let filter = "story";
  let unread = 0;
  const tabButtons = new Map();
  for (const key of ["story", "combat", "all"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = words[key];
    button.addEventListener("click", () => { filter = key; applyFilter(); });
    tabButtons.set(key, button);
    tabs.append(button);
  }
  const applyFilter = () => {
    for (const [key, button] of tabButtons) button.setAttribute("aria-pressed", String(key === filter));
    for (const node of feed.querySelectorAll(".sp-entry")) node.hidden = !(filter === "all" || node.dataset.group === filter || node.dataset.kind === "system");
    if (![...feed.querySelectorAll(".sp-entry")].some((node) => !node.hidden)) feed.dataset.empty = "true"; else delete feed.dataset.empty;
    feed.scrollTop = feed.scrollHeight;
  };
  const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const add = (entry, fresh) => {
    const stick = atBottom();
    feed.insertBefore(entryNode(entry, fresh), jump);
    applyFilter();
    if (stick) feed.scrollTop = feed.scrollHeight;
    else { unread += 1; jump.hidden = false; jump.textContent = `${words.newEntries(unread)} · ${words.jump}`; }
  };
  feed.append(jump);
  jump.addEventListener("click", () => { unread = 0; jump.hidden = true; feed.scrollTop = feed.scrollHeight; });
  feed.addEventListener("scroll", () => { if (atBottom()) { unread = 0; jump.hidden = true; } });
  for (const entry of entries) add(entry, false);
  applyFilter();

  const setOpen = (open) => {
    panel.dataset.open = String(open);
    fold.textContent = open ? words.collapse : words.expand;
    feed.scrollTop = feed.scrollHeight;
  };
  fold.addEventListener("click", () => setOpen(panel.dataset.open !== "true"));
  setOpen(true);

  const place = (where) => {
    for (const name of Object.keys(words.places)) document.body.classList.toggle(`sp-place-${name}`, name === where);
    if (where === "scene") document.querySelector(".live-scene")?.after(panel);
    else if (where === "subtitle") document.querySelector(".live-scene")?.append(panel);
    else document.body.append(panel);
    fold.hidden = where === "scene" || where === "side";
    if (where === "drawer" || where === "subtitle") setOpen(false); else setOpen(true);
    for (const button of bar.querySelectorAll("button[data-place]")) button.setAttribute("aria-pressed", String(button.dataset.place === where));
    try { const url = new URL(window.location.href); url.searchParams.set("placement", where); history.replaceState(null, "", url); } catch { /* the address bar is only a convenience */ }
  };

  const bar = document.createElement("div");
  bar.className = "sp-bar";
  const label = document.createElement("span");
  label.textContent = words.bar;
  bar.append(label);
  for (const where of Object.keys(words.places)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.place = where;
    button.textContent = words.places[where];
    button.addEventListener("click", () => place(where));
    bar.append(button);
  }
  const simulate = document.createElement("button");
  simulate.type = "button";
  simulate.textContent = words.simulate;
  let next = 0;
  simulate.addEventListener("click", () => { add(more[next % more.length], true); next += 1; });
  bar.append(simulate);
  document.body.append(bar);

  const asked = new URLSearchParams(window.location.search).get("placement");
  place(asked !== null && asked in words.places ? asked : "scene");
}
