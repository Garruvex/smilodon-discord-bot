import { standardArray, classTemplates, isBuildClass, isBuildRace, type BuildClass, type BuildRace } from "../../../domain/campaign/character/character-build.js";
import { skills as allSkills, type Skill } from "../../../domain/campaign/character/character-sheet.js";
import { abilities, type Ability } from "../../../domain/campaign/rules/effects.js";

// Custom IDs for the character library screens: "dndchar:<action>[:<part>...]".
// Like every control they carry no authority: each click is checked against the
// clicking user's own library. The builder keeps its choices so far in the
// IDs themselves (a short token), so it needs no stored state and survives a
// restart or a dismissed message.

export const libraryIdPrefix = "dndchar";

export const libraryActions = [
  "home",
  // The language switch on the home screen: the target language is its one part.
  "lang",
  "view",
  "new",
  "bClass",
  "bRace",
  "bRaceAbility",
  "bRaceSkills",
  "bKit",
  "bSkills",
  "bExpert",
  "bScore",
  "bRecommended",
  "bName",
  "export",
  "deleteAsk",
  "deleteYes",
  // The portrait screens: home, the upload form, painting from the description, the
  // style menu on a preview, try again, use, discard, and remove the one in use.
  "pHome",
  "pUpload",
  "pSubmit",
  "pPaint",
  "pStyle",
  "pRetry",
  "pUse",
  "pDrop",
  "pRemove",
] as const;
export type LibraryAction = (typeof libraryActions)[number];

const maxLength = 100;

export function libraryCustomId(action: LibraryAction, ...parts: readonly string[]): string {
  const id = [libraryIdPrefix, action, ...parts].join(":");
  if (id.length > maxLength) throw new Error(`Custom ID "${id}" is longer than ${maxLength} characters.`);
  return id;
}

export type LibraryLanguage = "en" | "zh-TW";
const languageMarks: Readonly<Record<LibraryLanguage, string>> = { en: "~en", "zh-TW": "~zh" };

// A control carries the language its screen was shown in as a last part, so every later screen (and the form it opens)
// speaks the same language whatever the person's Discord client says. A control too long to carry it keeps its default.
export function withLanguage(customId: string, language: LibraryLanguage): string {
  const tagged = `${customId}:${languageMarks[language]}`;
  return tagged.length <= maxLength ? tagged : customId;
}

export function parseLibraryId(customId: string): { readonly action: LibraryAction; readonly parts: readonly string[]; readonly language?: LibraryLanguage } | null {
  const [prefix, action, ...all] = customId.split(":");
  if (prefix !== libraryIdPrefix || action === undefined || !(libraryActions as readonly string[]).includes(action)) return null;
  const last = all.at(-1);
  const language = (Object.keys(languageMarks) as LibraryLanguage[]).find((candidate) => languageMarks[candidate] === last);
  const parts = language === undefined ? all : all.slice(0, -1);
  return { action: action as LibraryAction, parts, ...(language === undefined ? {} : { language }) };
}

// The builder's choices so far. Every field is optional until chosen; a token
// that does not decode into something legal decodes to an empty draft.
export interface Draft {
  readonly class: BuildClass | null;
  readonly race: BuildRace | null;
  readonly raceAbilities: readonly Ability[];
  readonly raceSkills: readonly Skill[];
  readonly kit: string | null;
  readonly skills: readonly Skill[];
  readonly expertise: readonly Skill[];
  // The abilities in the order they were given 15, 14, 13, 12, 10, 8.
  readonly order: readonly Ability[];
}

export const emptyDraft: Draft = { class: null, race: null, raceAbilities: [], raceSkills: [], kit: null, skills: [], expertise: [], order: [] };

const classCodes: Readonly<Record<BuildClass, string>> = {
  fighter: "f",
  rogue: "r",
  cleric: "c",
  barbarian: "b",
  bard: "d",
  druid: "u",
  monk: "m",
  paladin: "p",
  ranger: "g",
  sorcerer: "o",
  warlock: "l",
  wizard: "z",
};
const abilityCodes: Readonly<Record<Ability, string>> = { str: "s", dex: "d", con: "c", int: "i", wis: "w", cha: "h" };
const raceCodes: Readonly<Record<BuildRace, string>> = {
  human: "h",
  elf: "e",
  dwarf: "w",
  halfling: "a",
  dragonborn: "n",
  gnome: "k",
  "half-elf": "x",
  "half-orc": "v",
  tiefling: "t",
  "hill-dwarf": "A",
  "mountain-dwarf": "B",
  "high-elf": "C",
  "wood-elf": "D",
  drow: "E",
  "lightfoot-halfling": "F",
  "stout-halfling": "G",
  "forest-gnome": "H",
  "rock-gnome": "I",
  "black-dragonborn": "J",
  "blue-dragonborn": "K",
  "brass-dragonborn": "L",
  "bronze-dragonborn": "M",
  "copper-dragonborn": "N",
  "gold-dragonborn": "O",
  "green-dragonborn": "P",
  "red-dragonborn": "Q",
  "silver-dragonborn": "R",
  "white-dragonborn": "S",
};
const skillCode = (skill: Skill): string => String.fromCharCode(97 + allSkills.indexOf(skill));

// "f0.ac.a.dcs": class fighter, kit 0, skills, expertise, abilities so far. A
// race, once chosen, rides between the class letter and the kit digits (a
// letter, never a digit, so decoding tells them apart without its own field).
export function encodeDraft(draft: Draft): string {
  const race = draft.race === null ? "" : raceCodes[draft.race];
  const kit = draft.class === null || draft.kit === null ? "" : String(classTemplates[draft.class].kits.findIndex((candidate) => candidate.id === draft.kit));
  return [
    `${draft.class === null ? "" : classCodes[draft.class]}${race}${kit}`,
    draft.skills.map(skillCode).join(""),
    draft.expertise.map(skillCode).join(""),
    draft.order.map((ability) => abilityCodes[ability]).join(""),
    draft.raceAbilities.map((ability) => abilityCodes[ability]).join(""),
    draft.raceSkills.map(skillCode).join(""),
  ].join(".");
}

export function decodeDraft(token: string | undefined): Draft {
  const [head = "", skillsPart = "", expertisePart = "", orderPart = "", raceAbilitiesPart = "", raceSkillsPart = ""] = (token ?? "").split(".");
  const classId = (Object.keys(classCodes) as BuildClass[]).find((id) => classCodes[id] === head[0]);
  if (classId === undefined || !isBuildClass(classId)) return emptyDraft;
  const template = classTemplates[classId];
  let rest = head.slice(1);
  const raceId = (Object.keys(raceCodes) as BuildRace[]).find((id) => raceCodes[id] === rest[0]);
  const race = raceId !== undefined && isBuildRace(raceId) ? raceId : null;
  if (race !== null) rest = rest.slice(1);
  const kitIndex = rest.length > 0 ? Number(rest) : Number.NaN;
  const kit = Number.isInteger(kitIndex) ? (template.kits[kitIndex]?.id ?? null) : null;
  const skills = readSkills(skillsPart, template.skillChoices);
  const chosen = readSkills(expertisePart, skills);
  const order: Ability[] = [];
  for (const char of orderPart) {
    const ability = abilities.find((candidate) => abilityCodes[candidate] === char);
    if (ability !== undefined && !order.includes(ability) && order.length < standardArray.length) order.push(ability);
  }
  const raceAbilities: Ability[] = [];
  if (race === "half-elf") for (const char of raceAbilitiesPart) {
    const ability = abilities.find((candidate) => abilityCodes[candidate] === char);
    if (ability !== undefined && ability !== "cha" && !raceAbilities.includes(ability) && raceAbilities.length < 2) raceAbilities.push(ability);
  }
  const raceSkills = race === "half-elf" ? readSkills(raceSkillsPart, allSkills).slice(0, 2) : [];
  return { class: classId, race, raceAbilities, raceSkills, kit, skills: kit === null ? [] : skills, expertise: kit === null ? [] : chosen, order };
}

function readSkills(part: string, allowed: readonly Skill[]): Skill[] {
  const found: Skill[] = [];
  for (const char of part) {
    const skill = allSkills[char.charCodeAt(0) - 97];
    if (skill !== undefined && allowed.includes(skill) && !found.includes(skill)) found.push(skill);
  }
  return found;
}

// The standard array dealt out in the order the abilities were chosen; the last
// ability, left alone, takes the last value.
export function scoresOf(order: readonly Ability[]): Partial<Record<Ability, number>> {
  const full = order.length === abilities.length - 1 ? [...order, ...abilities.filter((ability) => !order.includes(ability))] : order;
  return Object.fromEntries(full.map((ability, index) => [ability, standardArray[index] ?? 0]));
}
