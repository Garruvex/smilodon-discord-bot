import { z } from "zod";
import { parseContextProvenance } from "./context-provenance.js";

// Both persistence backends must preserve the same provenance fields. A bad
// optional proof fails closed without losing an otherwise readable session.
export const chatSessionExchangesSchema = z.array(z.object({
  user: z.object({ content: z.string(), createdAt: z.number(), sourceMessageId: z.string().nullable().optional(),
    channelMemoryMode: z.enum(["shared", "isolated", "session_only", "disabled"]).optional() }),
  assistant: z.object({ content: z.string(), createdAt: z.number(), messageIds: z.array(z.string().min(1).max(128)).max(32).optional() }),
  contextProvenance: z.unknown().transform(parseContextProvenance).optional(),
}));

export function boundedDeliveryMessageIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128).slice(0, 32);
}
