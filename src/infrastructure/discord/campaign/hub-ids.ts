// Custom IDs for the hub's controls: "dndhub:<action>" followed by ":<part>"
// for each argument. Like the game controls they carry no authority: every
// click is checked against the server's saved settings and the saved game.
// The new-game wizard keeps its choices in the IDs themselves, so it needs no
// stored state and works after a restart.

export const hubIdPrefix = "dndhub";

export const hubActions = [
  "create",
  "wizLanguage",
  "wizPacing",
  "wizPlayers",
  "wizNext",
  "wizName",
  "manage",
  "do",
  "endAsk",
  "endYes",
] as const;
export type HubAction = (typeof hubActions)[number];

export interface ParsedHubId {
  readonly action: HubAction;
  readonly parts: readonly string[];
}

// The manager controls a game's manage view offers.
export const manageVerbs = ["pause", "resume", "closeRound", "retry", "shortRest", "longRest", "repair"] as const;
export type ManageVerb = (typeof manageVerbs)[number];

// The choices the new-game wizard has collected so far.
export interface WizardChoices {
  readonly language: "en" | "zh-TW";
  readonly pacing: "live" | "playByPost";
  readonly players: number;
}

export const defaultWizardChoices: WizardChoices = { language: "en", pacing: "live", players: 3 };

const maxLength = 100;

export function hubCustomId(action: HubAction, ...parts: readonly string[]): string {
  const id = [hubIdPrefix, action, ...parts].join(":");
  if (id.length > maxLength) throw new Error(`Custom ID "${id}" is longer than ${maxLength} characters.`);
  return id;
}

export function parseHubId(customId: string): ParsedHubId | null {
  const [prefix, action, ...parts] = customId.split(":");
  if (prefix !== hubIdPrefix || action === undefined || !(hubActions as readonly string[]).includes(action)) return null;
  return { action: action as HubAction, parts };
}

export function wizardState(choices: WizardChoices): string {
  return `${choices.language}.${choices.pacing}.${choices.players}`;
}

// A malformed or tampered state falls back to the defaults, field by field.
export function parseWizardState(state: string | undefined): WizardChoices {
  const [language, pacing, players] = (state ?? "").split(".");
  const count = Number(players);
  return {
    language: language === "zh-TW" ? "zh-TW" : "en",
    pacing: pacing === "playByPost" ? "playByPost" : "live",
    players: Number.isInteger(count) && count >= 1 && count <= 6 ? count : defaultWizardChoices.players,
  };
}

export function isManageVerb(value: string | undefined): value is ManageVerb {
  return (manageVerbs as readonly (string | undefined)[]).includes(value);
}
