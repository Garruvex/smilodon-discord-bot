// A revocation records that a Discord message was deleted while the guild honours deleted sources.
// It is keyed by guild, channel and message only, so it works for bot-authored messages and for
// delete events that arrive without author information. Readers consult it before any author rule.

export interface MessageRevocationKey {
  guildId: string;
  channelId: string;
  messageId: string;
}

export interface MessageRevocationInput {
  guildId: string;
  channelId: string;
  messageIds: readonly string[];
  revokedAt: number;
}

export interface MessageRevocationResult {
  /** Message IDs revoked by this call; IDs already revoked are left as they were. */
  revoked: readonly string[];
  /** The channel's revocation revision after this call. It only increases. */
  revision: number;
}

export type MessageCleanupState = "pending" | "claimed" | "done";

export interface MessageCleanupWork extends MessageRevocationKey {
  state: MessageCleanupState;
  attempts: number;
  nextAt: number;
}

export interface MessageRevocationStore {
  /**
   * Revokes messages and queues their cleanup in one transaction. Revocations in one channel are
   * serialized, so a reader that sees a revision also sees every revocation committed before it.
   */
  revoke(input: MessageRevocationInput): Promise<MessageRevocationResult>;
  /** For each key, in order, whether it has a committed revocation. */
  revoked(keys: readonly MessageRevocationKey[]): Promise<readonly boolean[]>;
  /** The channel's current revocation revision; 0 when nothing in it was revoked. */
  revision(guildId: string, channelId: string): Promise<number>;
  /** Cleanup work queued for these keys, for inspection; the worker API arrives with durable intake. */
  cleanupWork(keys: readonly MessageRevocationKey[]): Promise<readonly (MessageCleanupWork | null)[]>;
}

/** Batches of keys are looked up per channel with at most this many message IDs per query. */
export const messageRevocationLookupChunk = 500;

export function groupRevocationKeys(keys: readonly MessageRevocationKey[]): Map<string, { guildId: string; channelId: string; messageIds: string[] }> {
  const groups = new Map<string, { guildId: string; channelId: string; messageIds: string[] }>();
  for (const key of keys) {
    const scope = JSON.stringify([key.guildId, key.channelId]);
    const group = groups.get(scope) ?? { guildId: key.guildId, channelId: key.channelId, messageIds: [] };
    group.messageIds.push(key.messageId);
    groups.set(scope, group);
  }
  return groups;
}

export function revocationKey(key: MessageRevocationKey): string {
  return JSON.stringify([key.guildId, key.channelId, key.messageId]);
}

export function chunked<T>(items: readonly T[], size = messageRevocationLookupChunk): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
