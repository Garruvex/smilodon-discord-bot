import type { ContainerBuilder, MessageFlags } from "discord.js";
import { MessageFlags as Flags } from "discord.js";

// One campaign card or panel is one Components V2 message: a container whose
// accent shows the state (the state is always also written as text). Mentions
// render as names but never ping.
export interface CardPayload {
  readonly components: [ContainerBuilder];
  readonly flags: MessageFlags.IsComponentsV2;
  readonly allowedMentions: { readonly parse: [] };
}

export function cardPayload(container: ContainerBuilder): CardPayload {
  return { components: [container], flags: Flags.IsComponentsV2, allowedMentions: { parse: [] } };
}

// Panel spec, State accents.
export const accents = {
  green: 0x2ecc71,
  amber: 0xf1c40f,
  red: 0xe74c3c,
  blue: 0x3498db,
  gray: 0x95a5a6,
} as const;

// Discord's limits for one Components V2 message.
export const cardLimits = { components: 40, characters: 4000 } as const;
