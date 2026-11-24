import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import type { ContextProvenance } from "../../src/application/chat/context-provenance.js";
import type { MessageOriginStore } from "../../src/application/chat/message-origin-store.js";
import type { MessageRevocationStore } from "../../src/application/chat/message-revocation-store.js";

// A copy of a migrations folder whose journal stops before the newest migration: the v1 schema.
export function migrationsBeforeLatest(folder: string): { previous: string; latestTag: string } {
  const previous = mkdtempSync(join(tmpdir(), "provenance-v1-migrations-"));
  cpSync(folder, previous, { recursive: true });
  const journalPath = join(previous, "meta", "_journal.json");
  const journal = z.object({ entries: z.array(z.object({ tag: z.string() }).passthrough()) }).passthrough().parse(JSON.parse(readFileSync(journalPath, "utf8")));
  const latest = journal.entries.at(-1)!;
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }));
  return { previous, latestTag: latest.tag };
}

const digest = (letter: string): string => letter.repeat(64);
export const v1Proof: ContextProvenance = { version: 1, purpose: "reply", coverage: "complete", audience: { guildId: "guild", channelId: "channel", userId: null },
  outputHash: digest("a"), dependencies: [{ guildId: "guild", channelId: "channel", messageId: "question", authorId: "alice", timestampMs: 1_000, representationHash: digest("b") }], unresolved: [] };

// v1 rows as the v1 stores wrote them, in v1's own columns. Today's stores only run after migrating.
export async function populateV1(execute: (statement: string) => Promise<void>, dialect: "sqlite" | "postgres"): Promise<void> {
  const time = (ms: number): string => dialect === "sqlite" ? String(ms) : `to_timestamp(${ms / 1000})`;
  await execute(`INSERT INTO message_revocations (guild_id, channel_id, message_id, revoked_at, revision) VALUES ('guild', 'channel', 'deleted', ${time(5_000)}, 1)`);
  await execute("INSERT INTO message_revocation_scopes (guild_id, channel_id, revision) VALUES ('guild', 'channel', 1)");
  await execute(`INSERT INTO message_cleanup_work (guild_id, channel_id, message_id, state, attempts, next_at) VALUES ('guild', 'channel', 'deleted', 'pending', 0, ${time(5_000)})`);
  await execute(`INSERT INTO message_origins (message_id, guild_id, channel_id, origin, source_message_id, context_provenance, created_at)
    VALUES ('reply', 'guild', 'channel', 'chat', 'question', '${JSON.stringify(v1Proof)}', ${time(2_000)})`);
}

export async function expectV1ReadsAfterMigration(revocations: MessageRevocationStore, origins: MessageOriginStore): Promise<void> {
  expect(await revocations.revoked([{ guildId: "guild", channelId: "channel", messageId: "deleted" }])).toEqual([true]);
  expect(await revocations.revision("guild", "channel")).toBe(1);
  expect((await origins.find("guild", "channel", "reply"))?.contextProvenance).toEqual(v1Proof);
  // The scope row gained an ordinal; revoking through it still advances the revision.
  expect((await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["later"], revokedAt: 6_000 })).revision).toBe(2);
}

export interface RevisionRow {
  id: string; guildId: string; channelId: string; kind: "reply_part"; artifactId: string; version: number; ordinal: number;
  state: "published"; completeness: "complete"; outputHash: string; createdAt: Date;
}
export const revisionRow = (id: string, version: number, ordinal: number, outputHash = digest(String(version))): RevisionRow => ({
  id, guildId: "guild", channelId: "channel", kind: "reply_part", artifactId: "reply", version, ordinal, state: "published",
  completeness: "complete", outputHash, createdAt: new Date(1_000 + ordinal),
});
