// Loads each Activity preview variant with the old and the new build. By default it reports where the page HTML differs;
// with ?styles it compares the computed style of every element instead (animations switched off, a few extra states forced on,
// and a phone width as well as a desktop one so the media queries are compared too).
const stylesMode = new URLSearchParams(window.location.search).has("styles");
const languages = ["en", "zh-TW"];
const variants = ["", "journey", "vote", "vote&stay", "vote&away", "collect", "roll", "state-preview", "down-preview", "member-preview", "party-states", "join-preview", "lobby-preview", "journey&vote"];
// Extra states a preview cannot reach by itself: classes added to an element before the snapshot.
const forced = { roll: [["#dice-dialog", "is-landed is-success is-critical-success"], ["#dice-dialog", "is-landed is-failure is-critical-failure"], ["#dice-dialog", "is-rolling"], ["#dice-dialog", "is-settling"]] };
const normalize = (html) => html.replace(/\d+:\d\d/g, "M:SS").replace(/blob:[^"]+/g, "blob").replace(/\s+/g, " ");

const snapshot = (doc) => {
  const view = doc.defaultView;
  const rows = [];
  for (const element of doc.querySelectorAll("body *")) {
    const style = view.getComputedStyle(element);
    const parts = [];
    for (const name of style) parts.push(name + ":" + style.getPropertyValue(name));
    rows.push(element.tagName + "#" + element.id + "." + element.className + " " + parts.join(";"));
  }
  return rows;
};

const load = (src, variant, width = 1200) => new Promise((done) => {
  const frame = document.createElement("iframe");
  frame.style.cssText = `width:${width}px;height:6000px`;
  frame.onload = () => setTimeout(() => {
    const doc = frame.contentDocument;
    if (!stylesMode) { const html = normalize(doc.body.innerHTML); frame.remove(); done(html); return; }
    const off = doc.createElement("style");
    off.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";
    doc.head.append(off);
    const states = [snapshot(doc)];
    for (const [selector, classes] of forced[variant.split("&")[0]] ?? []) {
      const element = doc.querySelector(selector);
      element.className = element.className.replace(/(^|\s)is-\S+/g, " ").trim();
      element.classList.add(...classes.split(" "));
      states.push(snapshot(doc));
    }
    frame.remove();
    done(states.map((state) => state.join("\n")).join("\n=====\n"));
  }, 900);
  frame.src = src;
  document.body.append(frame);
});

const firstDifference = (a, b) => {
  if (stylesMode) {
    const left = a.split("\n"), right = b.split("\n");
    const at = left.findIndex((line, i) => line !== right[i]);
    if (at < 0) return "length differs";
    const x = left[at].split(";"), y = right[at].split(";");
    const changed = x.filter((part, i) => part !== y[i]).slice(0, 6).map((part) => part + " -> " + y[x.indexOf(part)]);
    return left[at].split(" ")[0] + " " + changed.join(" | ");
  }
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return `${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
};

const widths = stylesMode ? [1200, 390] : [1200];
const results = [];
let bad = 0;
// The first load of each build is cold and can lay out differently, so it is thrown away.
await load("/old/?design-preview", "");
await load("/new/?design-preview", "");
for (const width of widths) {
  for (const language of width === 1200 ? languages : ["en"]) {
    for (const variant of variants) {
      const query = `?design-preview&language=${language}${variant ? `&${variant}` : ""}`;
      const a = await load(`/old/${query}`, variant, width);
      const b = await load(`/new/${query}`, variant, width);
      if (a !== b) bad += 1;
      results.push(`${a === b ? "same" : "DIFF"} ${width}px ${query}${a === b ? "" : `  ${firstDifference(a, b)}`}`);
    }
  }
}
document.getElementById("out").textContent = `${bad === 0 ? "ALL SAME" : `${bad} DIFFER`}\n${results.join("\n")}`;
