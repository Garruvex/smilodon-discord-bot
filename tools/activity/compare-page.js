// Loads each Activity preview variant with the old and the new bundle and reports where the page HTML differs.
const variants = ["", "journey", "vote", "vote&stay", "collect", "roll", "state-preview", "down-preview", "member-preview", "party-states", "join-preview", "lobby-preview", "journey&vote"];
const languages = ["en", "zh-TW"];
const normalize = (html) => html.replace(/\d+:\d\d/g, "M:SS").replace(/blob:[^"]+/g, "blob").replace(/\s+/g, " ");
const load = (src) => new Promise((done) => {
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:1200px;height:900px";
  frame.onload = () => setTimeout(() => { const html = normalize(frame.contentDocument.body.innerHTML); frame.remove(); done(html); }, 900);
  frame.src = src;
  document.body.append(frame);
});
const firstDifference = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i += 1; return `${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`; };
const lines = [];
let bad = 0;
for (const language of languages) {
  for (const variant of variants) {
    const query = `?design-preview&language=${language}${variant ? `&${variant}` : ""}`;
    const a = await load(`/old/${query}`);
    const b = await load(`/new/${query}`);
    if (a !== b) bad += 1;
    lines.push(`${a === b ? "same" : "DIFF"} ${query}${a === b ? "" : `  ${firstDifference(a, b)}`}`);
  }
}
document.getElementById("out").textContent = `${bad === 0 ? "ALL SAME" : `${bad} DIFFER`}\n${lines.join("\n")}`;
