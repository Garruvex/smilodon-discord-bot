import { standardArray, classTemplates, isBuildClass, type BuildClass } from "../../../domain/campaign/character/character-build.js";
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
  "view",
  "new",
  "bClass",
  "bKit",
  "bSkills",
  "bExpert",
  "bScore",
  "bRecommended",
  "bName",
  "export",
  "deleteAsk",
  "deleteYes",
] as const;
export type LibraryAction = (typeof libraryActions)[number];

const maxLength = 100;

export function libraryCustomId(action: LibraryAction, ...parts: readonly string[]): string {
  const id = [libraryIdPrefix, action, ...parts].join(":");
  if (id.length > maxLength) throw new Error(`Custom ID "${id}" is longer than ${maxLength} characters.`);
  return id;
}

export function parseLibraryId(customId: string): { readonly action: LibraryAction; readonly parts: readonly string[] } | null {
  const [prefix, action, ...parts] = customId.split(":");
  if (prefix !== libraryIdPrefix || action === undefined || !(libraryActions as readonly string[]).includes(action)) return null;
  return { action: action as LibraryAction, parts };
}

// The builder's choices so far. Every field is optional until chosen; a token
// that does not decode into something legal decodes to an empty draft.
export interface Draft {
  readonly class: BuildClass | null;
  readonly kit: string | null;
  readonly skills: readonly Skill[];
  readonly expertise: readonly Skill[];
  // The abilities in the order they were given 15, 14, 13, 12, 10, 8.
  readonly order: readonly Ability[];
}

export const emptyDraft: Draft = { class: null, kit: null, skills: [], expertise: [], order: [] };

const classCodes: Readonly<Record<BuildClass, string>> = { fighter: "f", rogue: "r", cleric: "c" };
const abilityCodes: Readonly<Record<Ability, string>> = { str: "s", dex: "d", con: "c", int: "i", wis: "w", cha: "h" };
const skillCode = (skill: Skill): string => String.fromCharCode(97 + allSkills.indexOf(skill));

// "f0.ac.a.dcs": class fighter, kit 0, skills, expertise, abilities so far.
export function encodeDraft(draft: Draft): string {
  const kit = draft.class === null || draft.kit === null ? "" : String(classTemplates[draft.class].kits.findIndex((candidate) => candidate.id === draft.kit));
  return [
    `${draft.class === null ? "" : classCodes[draft.class]}${kit}`,
    draft.skills.map(skillCode).join(""),
    draft.expertise.map(skillCode).join(""),
    draft.order.map((ability) => abilityCodes[ability]).join(""),
  ].join(".");
}

export function decodeDraft(token: string | undefined): Draft {
  const [head = "", skillsPart = "", expertisePart = "", orderPart = ""] = (token ?? "").split(".");
  const classId = (Object.keys(classCodes) as BuildClass[]).find((id) => classCodes[id] === head[0]);
  if (classId === undefined || !isBuildClass(classId)) return emptyDraft;
  const template = classTemplates[classId];
  const kitIndex = head.length > 1 ? Number(head.slice(1)) : Number.NaN;
  const kit = Number.isInteger(kitIndex) ? (template.kits[kitIndex]?.id ?? null) : null;
  const skills = readSkills(skillsPart, template.skillChoices);
  const chosen = readSkills(expertisePart, skills);
  const order: Ability[] = [];
  for (const char of orderPart) {
    const ability = abilities.find((candidate) => abilityCodes[candidate] === char);
    if (ability !== undefined && !order.includes(ability) && order.length < standardArray.length) order.push(ability);
  }
  return { class: classId, kit, skills: kit === null ? [] : skills, expertise: kit === null ? [] : chosen, order };
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
