/* global fetch, URL, process */
// Compare local SRD spell labels with the public page titles linked by dnd5e-2.
// Run with: node tools/srd/audit-dnd5e-2.mjs
import { readFileSync } from "node:fs";

const url = "https://sites.google.com/view/dnd5e-2/%E7%A8%AE%E6%97%8F/%E5%9F%BA%E7%A4%8E%E5%86%92%E9%9A%AA%E8%80%85";
const html = await (await fetch(url)).text();
const local = JSON.parse(readFileSync(new URL("./zh-tw-spell-names.json", import.meta.url), "utf8"));
const otherNames = JSON.parse(readFileSync(new URL("./zh-tw-names.json", import.meta.url), "utf8"));
const linked = new Map();
const slugs = Object.keys(local).sort((a, b) => b.length - a.length);
for (const match of html.matchAll(/href="([^"]+)"/g)) {
  const raw = match[1].replaceAll("&amp;", "&");
  if (!raw.includes("/關於法術/") && !raw.includes("/%E9%97%9C%E6%96%BC%E6%B3%95%E8%A1%93/")) continue;
  let path;
  try { path = decodeURIComponent(new URL(raw, url).pathname); } catch { continue; }
  const last = path.split("/").at(-1);
  const slug = slugs.find((candidate) => last.endsWith(`-${candidate}`));
  if (slug) {
    const label = last.slice(0, -slug.length - 1);
    if (!/[a-z]/i.test(label)) linked.set(slug, label);
  }
}
const matches = [], differences = [], missing = [];
for (const [slug, label] of Object.entries(local)) {
  const reference = linked.get(slug);
  if (!reference) missing.push({ slug, local: label });
  else if (reference === label) matches.push(slug);
  else differences.push({ slug, local: label, reference });
}
const monsters = Object.entries(otherNames).filter(([id]) => id.startsWith("monster:"));
const items = Object.entries(otherNames).filter(([id]) => id.startsWith("item:"));
process.stdout.write(JSON.stringify({
  source: url,
  referenceSpellLinks: linked.size,
  localSpells: Object.keys(local).length,
  matches: matches.length,
  differences,
  missing,
  coverageLimit: "The reference site has no indexed SRD monster catalog and no complete machine-readable item catalog. These entries are inventoried but not claimed as verified.",
  monstersNotVerified: Object.fromEntries(monsters),
  itemsNotVerified: Object.fromEntries(items),
}, null, 2));
