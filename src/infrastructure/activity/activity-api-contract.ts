// The Activity's wire contract. The browser, request handler, and local API
// reference all use these action names and field descriptions.
export type ActivityFieldType =
  | "string" | "integer" | "boolean" | "string[]" | "string|null"
  | "integer|null" | "go|stay" | "short|long|none" | "short|long"
  | "buy|sell" | "accept|decline|cancel" | "ability[]" | "ability";

export type ActivityActionFields = Readonly<Record<string, ActivityFieldType>>;

// A trailing ? on a field name means it may be omitted. Null is distinct from
// omission for reaction, smite, and rest decisions.
export const activityActions = {
  chooseHero: { heroId: "string" },
  joinLobby: {},
  leaveLobby: {},
  requestJoin: {},
  chooseSaved: { snapshotId: "string" },
  startLobby: {},
  acceptInvite: {},
  joinHero: { heroRef: "string" },
  replaceHero: { heroRef: "string", "entrance?": "string" },
  withdrawJoin: {},
  submit: { text: "string", "roundNumber?": "integer", "sceneId?": "string" },
  speak: { text: "string" },
  pass: {},
  away: {},
  back: {},
  toggleMoveObjection: {},
  moveVote: { choice: "go|stay" },
  roll: {},
  ready: {},
  begin: {},
  continue: {},
  attack: { targetId: "string", weaponId: "string", "offHand?": "boolean", "nonlethal?": "boolean" },
  move: { zoneId: "string" },
  engage: { targetId: "string" },
  withdraw: {},
  dash: {},
  disengage: {},
  feature: { featureId: "string" },
  combatItem: { itemId: "string" },
  shield: { itemId: "string", on: "boolean" },
  wildShape: { monsterId: "string|null" },
  moveScene: { sceneId: "string" },
  endTurn: {},
  combatDodge: {},
  combatSpell: { spellId: "string", slotLevel: "integer", targetIds: "string[]" },
  teleport: { spellId: "string", slotLevel: "integer", zoneId: "string" },
  exploreSpell: { spellId: "string" },
  safetyStop: {},
  pause: {},
  queueRest: { rest: "short|long|none" },
  proposeRest: { rest: "short|long" },
  answerRestVote: { agree: "boolean" },
  spendHitDice: { count: "integer" },
  chooseAsi: { "plusTwo?": "ability", "plusOne?": "ability[]" },
  chooseClassLevel: { buildClass: "string", "skill?": "string" },
  chooseFightingStyle: { styleId: "string" },
  chooseWarlockOptions: { "invocations?": "string[]", "pactBoon?": "string" },
  healSpell: { spellId: "string", slotLevel: "integer", targetId: "string" },
  reviveSpell: { spellId: "string", slotLevel: "integer", targetId: "string" },
  summonCompanion: { spellId: "string", slotLevel: "integer" },
  askNpc: { npcId: "string", question: "string" },
  pressNpc: { npcId: "string", skill: "string" },
  shop: { npcId: "string", itemId: "string", direction: "buy|sell", "haggle?": "string" },
  dismissCompanion: { companionId: "string" },
  runGame: { verb: "string" },
  saveProgress: {},
  setHouseRule: { ruleId: "string", value: "string" },
  applyRulePreset: { presetId: "string" },
  reopen: {},
  raiseLevel: { level: "integer" },
  setWorld: { "day?": "integer", "time?": "string", "weather?": "string", "note?": "string" },
  setProxy: { userId: "string|null" },
  useItem: { itemId: "string" },
  stashItem: { itemId: "string" },
  takeFromStash: { itemId: "string" },
  giveItem: { itemId: "string", toCharacterId: "string" },
  offerResponse: { offerId: "string", answer: "accept|decline|cancel" },
  wearItem: { itemId: "string" },
  removeItem: { itemId: "string" },
  reaction: { spellId: "string|null", slotLevel: "integer|null" },
  smite: { slotLevel: "integer|null" },
  opportunityAttack: { accept: "boolean" },
} as const satisfies Readonly<Record<string, ActivityActionFields>>;

export type ActivityActionKind = keyof typeof activityActions;
export type ActivityAction = { readonly kind: ActivityActionKind } & Readonly<Record<string, unknown>>;

const abilities = new Set(["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]);
const choices = {
  "go|stay": ["go", "stay"],
  "short|long|none": ["short", "long", "none"],
  "short|long": ["short", "long"],
  "buy|sell": ["buy", "sell"],
  "accept|decline|cancel": ["accept", "decline", "cancel"],
} as const;

function matches(value: unknown, type: ActivityFieldType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string[]") return Array.isArray(value) && value.every((part) => typeof part === "string");
  if (type === "string|null") return value === null || typeof value === "string";
  if (type === "integer|null") return value === null || (typeof value === "number" && Number.isInteger(value));
  if (type === "ability") return typeof value === "string" && abilities.has(value);
  if (type === "ability[]") return Array.isArray(value) && value.every((part) => typeof part === "string" && abilities.has(part));
  return typeof value === "string" && (choices[type] as readonly string[]).includes(value);
}

export function parseActivityAction(input: unknown): ActivityAction | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const action = input as Record<string, unknown>;
  if (typeof action.kind !== "string" || !Object.hasOwn(activityActions, action.kind)) return null;
  const fields = activityActions[action.kind as ActivityActionKind] as ActivityActionFields;
  for (const [rawName, type] of Object.entries(fields)) {
    const optional = rawName.endsWith("?");
    const name = optional ? rawName.slice(0, -1) : rawName;
    if (action[name] === undefined && optional) continue;
    if (!matches(action[name], type)) return null;
  }
  return action as ActivityAction;
}
