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
