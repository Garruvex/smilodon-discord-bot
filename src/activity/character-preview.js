// A local, disposable library for the design preview. No account or server writes are made.
const scores = (order) => Object.fromEntries(order.map((ability, index) => [ability, [15, 14, 13, 12, 10, 8][index]]));
const catalog = {
  races: ["human", "hill-dwarf", "high-elf", "wood-elf", "lightfoot-halfling", "half-elf", "half-orc", "tiefling"],
  skills: ["acrobatics", "animal-handling", "arcana", "athletics", "deception", "history", "insight", "intimidation", "investigation", "medicine", "nature", "perception", "performance", "persuasion", "religion", "sleight-of-hand", "stealth", "survival"],
  classes: [
    { id: "fighter", skillChoices: ["acrobatics", "animal-handling", "athletics", "history", "insight", "intimidation", "perception", "survival"], skillCount: 2, expertiseCount: 0, kits: ["knight", "skirmisher"], suggestedAbilities: scores(["str", "con", "dex", "wis", "int", "cha"]) },
    { id: "rogue", skillChoices: ["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight-of-hand", "stealth"], skillCount: 4, expertiseCount: 2, kits: ["shadow", "duelist"], suggestedAbilities: scores(["dex", "cha", "int", "con", "wis", "str"]) },
    { id: "wizard", skillChoices: ["arcana", "history", "insight", "investigation", "medicine", "religion"], skillCount: 2, expertiseCount: 0, kits: ["scholar", "wanderer"], suggestedAbilities: scores(["int", "con", "dex", "wis", "cha", "str"]) },
  ],
};

const sample = [
  { id: "preview-mira", versions: [
    { id: "mira-1", revision: 1, branch: "main", source: "builder", build: { name: "Mira Fen", race: "human", class: "fighter", appearance: "A travel-worn cloak and a silver clasp shaped like a crescent.", backstory: "Once a watch captain, now looking for the people who vanished beyond the old road.", kit: "knight", abilities: scores(["str", "con", "dex", "wis", "int", "cha"]), skills: ["athletics", "perception"], expertise: [] }, gear: { equipment: ["item:longsword", "item:chain-mail", "item:shield"] } },
    { id: "mira-2", revision: 2, branch: "main", source: "builder", build: { name: "Mira Fen", race: "human", class: "fighter", appearance: "A travel-worn cloak and a silver clasp shaped like a crescent.", backstory: "Once a watch captain, now looking for the people who vanished beyond the old road. She carries their names in a leather journal.", kit: "skirmisher", abilities: scores(["str", "con", "dex", "wis", "int", "cha"]), skills: ["athletics", "survival"], expertise: [] }, gear: { equipment: ["item:longsword", "item:shortsword", "item:longbow"] } },
  ] },
  { id: "preview-pip", versions: [
    { id: "pip-1", revision: 1, branch: "main", source: "builder", build: { name: "Pip Underbough", race: "lightfoot-halfling", class: "rogue", appearance: "Quick smile, ink-stained fingers, and a pocket full of borrowed maps.", backstory: "Pip collects secrets for a living and gives most of them away for free.", kit: "shadow", abilities: scores(["dex", "cha", "int", "con", "wis", "str"]), skills: ["acrobatics", "deception", "perception", "stealth"], expertise: ["deception", "stealth"] }, gear: { equipment: ["item:shortsword", "item:shortbow", "item:dagger", "item:leather-armor"] } },
  ] },
];

let library = structuredClone(sample);
let nextId = 1;
const copy = (value) => structuredClone(value);
const latest = (character) => character.versions.filter((version) => version.branch === "main").at(-1);
const summary = (character) => ({ id: character.id, name: latest(character).build.name, className: latest(character).build.class, race: latest(character).build.race, versionCount: character.versions.filter((version) => version.branch === "main").length });

export async function previewCharacterRequest(path, options = {}) {
  const id = path.split("/")[4];
  const character = library.find((item) => item.id === id);
  const method = options.method ?? "GET";
  if (method === "GET" && !id) return copy({ catalog, characters: library.map(summary) });
  if (method === "GET" && character) return copy({ character: { ...character, name: latest(character).build.name } });
  if (method === "POST") {
    const build = JSON.parse(options.body);
    const characterId = `preview-new-${nextId++}`;
    library.push({ id: characterId, versions: [{ id: `${characterId}-1`, revision: 1, branch: "main", source: "builder", build, gear: { equipment: [`item:${build.kit}`] } }] });
    return { characterId };
  }
  if (method === "PUT" && character) {
    const build = JSON.parse(options.body);
    const revision = character.versions.filter((version) => version.branch === "main").length + 1;
    character.versions.push({ id: `${id}-${revision}`, revision, branch: "main", source: "builder", build, gear: copy(latest(character).gear) });
    return { characterId: id };
  }
  if (method === "DELETE" && character) {
    library = library.filter((item) => item.id !== id);
    return {};
  }
  throw new Error("Character not found in preview.");
}
