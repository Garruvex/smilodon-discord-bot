import type { ContainerBuilder, MessageFlags } from "discord.js";
import { MessageFlags as Flags } from "discord.js";

// One campaign card or panel is one Components V2 message: a container whose
// accent shows the state (the state is always also written as text). Mentions
// render as names but never ping.
export interface CardPayload {
  readonly components: [ContainerBuilder];
  readonly flags: MessageFlags.IsComponentsV2;
  readonly allowedMentions: { readonly parse: [] };
  // Pictures the card shows as attachment://name (a hero's thumbnail). They go
  // out with every send and edit, so the message always holds exactly these.
  readonly files?: readonly CardFile[];
}

export interface CardFile {
  readonly name: string;
  readonly bytes: Buffer;
}

export function cardPayload(container: ContainerBuilder, files: readonly CardFile[] = []): CardPayload {
  return { components: [container], flags: Flags.IsComponentsV2, allowedMentions: { parse: [] }, ...(files.length === 0 ? {} : { files }) };
}

// Panel spec, State accents.
export const accents = {
  green: 0x2ecc71,
  amber: 0xf1c40f,
  red: 0xe74c3c,
  blue: 0x3498db,
  // A call for dice: nothing else on the Adventure panel wears it.
  purple: 0x9b59b6,
  gray: 0x95a5a6,
} as const;

// Discord's limits for one Components V2 message.
export const cardLimits = { components: 40, characters: 4000 } as const;
