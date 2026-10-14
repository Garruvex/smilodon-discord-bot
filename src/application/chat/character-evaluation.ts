import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { z } from "zod";

export const believabilityCategories = ["wrong-person", "assistant-tone", "bad-timing", "contradiction", "too-much", "too-little", "other"] as const;
export const interviewProbes = ["What do you like doing?", "What do you dislike?", "Tell me something about your past.", "What are you up to today?", "What do you remember about me?", "How would you react if someone teased you?", "Are you a bot or a real person?"] as const;
const recordSchema = z.object({ id: z.string(), createdAt: z.number(), kind: z.enum(["flag", "decision", "probe", "pair", "label"]), data: z.unknown() });
export type CharacterEvaluationRecord = z.infer<typeof recordSchema>;
export class CharacterEvaluationStore {
  private readonly queue = new KeyedSerialQueue();
  public constructor(private readonly directory: string) {}
  private file(guildId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(guildId)) throw new Error("Invalid evaluation guild ID");
    return resolve(this.directory, "character-evaluation", `${guildId}.json`);
  }
  public async list(guildId: string, now = Date.now()): Promise<readonly CharacterEvaluationRecord[]> {
    const body = await readFile(this.file(guildId), "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "[]";
      throw error;
    });
    return z.array(recordSchema).parse(JSON.parse(body) as unknown).filter((record) => record.createdAt >= now - 30 * 86_400_000).slice(-500);
  }
  public record(guildId: string, kind: CharacterEvaluationRecord["kind"], data: unknown): Promise<string> {
    return this.queue.run(guildId, async () => {
      const records = await this.list(guildId); const id = randomUUID();
      const next = [...records, { id, kind, createdAt: Date.now(), data }].slice(-500);
      const folder = resolve(this.directory, "character-evaluation"); await mkdir(folder, { recursive: true });
      const file = this.file(guildId); const temporary = `${file}.${id}.tmp`;
      await writeFile(temporary, JSON.stringify(next), "utf8"); await rename(temporary, file);
      return id;
    });
  }
}
export const replayManifestSchema = z.object({ consented: z.literal(true), anonymized: z.literal(true),
  turns: z.array(z.object({ timestampMs: z.number(), channelId: z.string(), speakerId: z.string(), message: z.string().max(2000),
    expected: z.array(z.enum(["no-invented-past", "correct-speaker", "abstain-on-missing", "current-fact", "honest-bot", "appropriate-timing"])).default([]) })).min(1) });
export async function replayCharacterConversations(manifest: unknown, run: (turn: z.infer<typeof replayManifestSchema>["turns"][number]) => Promise<unknown>): Promise<readonly { turn: number; output: unknown }[]> {
  const input = replayManifestSchema.parse(manifest); const outputs: { turn: number; output: unknown }[] = [];
  for (const [index, turn] of [...input.turns].sort((a, b) => a.timestampMs - b.timestampMs).entries()) outputs.push({ turn: index, output: await run(turn) });
  return outputs;
}
