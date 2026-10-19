import type { ContextProvenance } from "./context-provenance.js";

export type MessageOrigin = "chat" | "link_fix" | "tool" | "system" | "game";

export interface MessageOriginRecord {
  messageId: string;
  guildId: string;
  channelId: string;
  origin: MessageOrigin;
  sourceMessageId: string | null;
  createdAt: number;
  contextProvenance?: ContextProvenance | null;
}

export interface MessageOriginStore {
  invalidateContextSubject?(guildId: string, userId: string): Promise<void>;
  record(input: MessageOriginRecord): Promise<void>;
  find(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null>;
}

export class SocialOutputSuppressed extends Error {
  public constructor() { super("Social output is no longer eligible"); }
}
