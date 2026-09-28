// Component custom IDs for campaign controls: "dnd:<action>:<campaignId>",
// optionally followed by ":<argument>". The registry routes on the "dnd"
// prefix; everything after it is parsed here. IDs carry no authority: every
// click is checked against saved campaign state (panel spec, Principles).

export const campaignIdPrefix = "dnd";

export const campaignActions = [
  "join",
  "leave",
  "pickHero",
  "heroChoice",
  "newHero",
  "start",
  "act",
  "pass",
  "roll",
  "myHero",
  "away",
  "back",
  "continue",
  "details",
  "ready",
  "begin",
  "gear",
  // Combat: open the private turn menu, refresh it, pick an action, pick its
  // targets, end the turn.
  "turn",
  "turnRefresh",
  "pick",
  "aim",
  "endTurn",
  // Inventory: the pack menu, choosing who gets a gift, and answering an offer.
  "pack",
  "giveTo",
  "offerYes",
  "offerNo",
  "offerCancel",
  // Speak in character, the anonymous pause, and the help and links menu.
  "speak",
  "safety",
  "safetyPause",
  "more",
  // The Table rules screen (a private view): open it, pick a bundle, pick an
  // option, pick its value.
  "rules",
  "rulePreset",
  "ruleOption",
  "ruleValue",
  // Saved characters: confirm playing one, and save a hero's progress back.
  "useSaved",
  "saveProgress",
  // The story so far, and a catch-up for someone coming back.
  "journal",
  "recap",
  // Naming a proxy for fights while away (a menu on My Hero).
  "proxy",
  // A reaction window (Shield): cast one of the offered spells, or take the hit.
  "reactCast",
  "reactDecline",
  // A smite window: spend the given slot for Divine Smite's bonus damage, or skip it.
  "smiteChoose",
  "smiteSkip",
] as const;
export type CampaignAction = (typeof campaignActions)[number];

export interface ParsedCampaignId {
  readonly action: CampaignAction;
  readonly campaignId: string;
  readonly argument: string | null;
}

// Discord limits a custom ID to 100 characters.
const maxLength = 100;

export function campaignCustomId(action: CampaignAction, campaignId: string, argument?: string): string {
  const id = [campaignIdPrefix, action, campaignId, ...(argument === undefined ? [] : [argument])].join(":");
  if (id.length > maxLength) throw new Error(`Custom ID "${id}" is longer than ${maxLength} characters.`);
  return id;
}

export function parseCampaignId(customId: string): ParsedCampaignId | null {
  const [prefix, action, campaignId, ...rest] = customId.split(":");
  if (prefix !== campaignIdPrefix || action === undefined || campaignId === undefined || campaignId.length === 0) return null;
  if (!(campaignActions as readonly string[]).includes(action)) return null;
  return { action: action as CampaignAction, campaignId, argument: rest.length === 0 ? null : rest.join(":") };
}
