import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { guildKnowledgeLimits, maySelfConfirm } from "../../application/chat/guild-knowledge-policy.js";
import type { GuildKnowledgeRecord } from "../../application/chat/chat-provider.js";
import type { GuildKnowledgeStore } from "../../application/chat/guild-knowledge-store.js";

const recordSchema = z.object({
  id: z.string(), subjectType: z.enum(["guild", "member", "team", "project"]), subjectId: z.string(),
  topic: z.string(), slot: z.string(), statement: z.string(),
  status: z.enum(["candidate", "confirmed", "deprecated"]),
  source: z.enum(["self_report", "community", "administrator"]),
  assertedByUserIds: z.array(z.string()), confirmedByUserIds: z.array(z.string()),
  createdAt: z.number(), updatedAt: z.number(), expiresAt: z.number().nullable(),
  embedding: z.array(z.number()).nullable().default(null),
});
const documentSchema = z.object({
  version: z.literal(1), guildId: z.string(), records: z.array(recordSchema), updatedAt: z.number(),
});
type GuildDocument = z.infer<typeof documentSchema>;

export class LocalGuildKnowledgeStore implements GuildKnowledgeStore {
  private readonly chatRoot: string;
  public constructor(runtimeDataDirectory: string) {
    this.chatRoot = resolve(runtimeDataDirectory, "chat");
    mkdirSync(this.chatRoot, { recursive: true });
  }
  public initialize(): Promise<void> { return Promise.resolve(); }

  public loadConfirmed(guildId: string): Promise<readonly GuildKnowledgeRecord[]> {
    const records = this.read(guildId).records.filter((record) => record.status === "confirmed")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, guildKnowledgeLimits.maxConfirmedRecords).map((record) => ({
        id: record.id, subjectType: record.subjectType, subjectId: record.subjectId,
        topic: record.topic, slot: record.slot, statement: record.statement, source: record.source,
        updatedAt: record.updatedAt, embedding: record.embedding,
      }));
    const bounded: GuildKnowledgeRecord[] = [];
    let serializedChars = 0;
    for (const record of records) {
      // Excludes `embedding` — it's never sent to the model, so it must not
      // count against maxSerializedChars (a single embedding vector can be
      // tens of KB serialized, far larger than the text it's paired with).
      const promptFields = {
        id: record.id, subjectType: record.subjectType, subjectId: record.subjectId,
        topic: record.topic, slot: record.slot, statement: record.statement,
        source: record.source, updatedAt: record.updatedAt,
      };
      const size = JSON.stringify(promptFields).length;
      if (serializedChars + size > guildKnowledgeLimits.maxSerializedChars) break;
      bounded.push(record);
      serializedChars += size;
    }
    return Promise.resolve(bounded);
  }

  public propose(input: Parameters<GuildKnowledgeStore["propose"]>[0]): Promise<void> {
    if (input.candidates.length === 0) return Promise.resolve();
    const document = this.read(input.guildId);
    const records = document.records.filter((record) => record.status === "confirmed" || record.expiresAt === null || record.expiresAt > input.now);
    for (const candidate of input.candidates) {
      const existing = records.find((record) => record.status !== "deprecated" && record.subjectType === candidate.subjectType &&
        record.subjectId === candidate.subjectId && record.topic === candidate.topic && record.slot === candidate.slot);
      const selfConfirmed = maySelfConfirm(candidate, input.assertedByUserId);
      if (existing) {
        if (!existing.assertedByUserIds.includes(input.assertedByUserId)) existing.assertedByUserIds.push(input.assertedByUserId);
        if (selfConfirmed && !existing.confirmedByUserIds.includes(input.assertedByUserId)) {
          existing.confirmedByUserIds.push(input.assertedByUserId);
          existing.status = "confirmed";
          existing.source = "self_report";
          existing.expiresAt = null;
        }
        if (selfConfirmed || existing.statement === candidate.statement) {
          existing.statement = candidate.statement;
          existing.embedding = candidate.embedding;
        }
        existing.updatedAt = input.now;
        continue;
      }
      const confirmedCount = records.filter((record) => record.status === "confirmed").length;
      const candidateCount = records.filter((record) => record.status === "candidate").length;
      if (selfConfirmed && confirmedCount >= guildKnowledgeLimits.maxConfirmedRecords) continue;
      if (!selfConfirmed && candidateCount >= guildKnowledgeLimits.maxCandidateRecords) continue;
      records.push({
        ...candidate, id: randomUUID(), status: selfConfirmed ? "confirmed" : "candidate",
        source: selfConfirmed ? "self_report" : "community", assertedByUserIds: [input.assertedByUserId],
        confirmedByUserIds: selfConfirmed ? [input.assertedByUserId] : [], createdAt: input.now, updatedAt: input.now,
        expiresAt: selfConfirmed ? null : input.now + guildKnowledgeLimits.candidateTtlMs,
      });
    }
    this.write({ version: 1, guildId: input.guildId, records, updatedAt: input.now });
    return Promise.resolve();
  }

  private read(guildId: string): GuildDocument {
    const file = this.file(guildId);
    if (!existsSync(file)) return { version: 1, guildId, records: [], updatedAt: 0 };
    try {
      return documentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`Unable to read guild knowledge "${file}".`, { cause: error });
    }
  }
  private write(document: GuildDocument): void {
    const file = this.file(document.guildId);
    mkdirSync(dirname(file), { recursive: true });
    const temporaryFile = `${file}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporaryFile, file);
  }
  private file(guildId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(guildId)) throw new Error(`Unsafe guild identifier "${guildId}".`);
    return resolve(this.chatRoot, guildId, "guild-knowledge.json");
  }
}
