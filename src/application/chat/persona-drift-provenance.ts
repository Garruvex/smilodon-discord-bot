import type { ContextProvenance } from "./context-provenance.js";

export interface ScopedPersonaDrift {
  guildId: string; channelId: string; epoch: string; personalitySourceHash: string; text: string; updatedAt: number;
  contextProvenance: ContextProvenance;
}
export function personaDriftPayload(state: Omit<ScopedPersonaDrift, "contextProvenance">): string {
  return JSON.stringify({ guildId: state.guildId, channelId: state.channelId, epoch: state.epoch, personalitySourceHash: state.personalitySourceHash, text: state.text, updatedAt: state.updatedAt });
}
