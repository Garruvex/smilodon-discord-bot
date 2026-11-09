import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { contextProvenanceSchema } from "./context-provenance.js";
import { isGuardedContext, type GuardedConversationContext } from "./guarded-conversation-context.js";
import { personaDriftPayload, type ScopedPersonaDrift } from "./persona-drift-provenance.js";
import type { ConversationModelGateway } from "../context/conversation-model-gateway.js";
import type { ChatSessionExchange } from "./chat-state-store.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";

const scopedDriftSchema = z.object({ guildId: z.string().min(1).max(128), channelId: z.string().min(1).max(128), epoch: z.string().uuid(), personalitySourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  text: z.string().max(1000), updatedAt: z.number().finite().nonnegative(), contextProvenance: contextProvenanceSchema }).strict();

// Only channel-scoped, source-backed drift can be read or evolved. Reset
// also erases legacy global files without promoting them into context.
export class PersonaDriftStore {
  private readonly queue = new KeyedSerialQueue();

  public constructor(
    private readonly runtimeDataDirectory: string,
    _logger: Logger | null = null,
  ) {}

  private path(guildId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(guildId)) throw new Error("Invalid drift scope");
    return resolve(this.runtimeDataDirectory, "guild-assets", guildId, "persona-drift.json");
  }

  private scopedPath(guildId: string, channelId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(channelId)) throw new Error("Invalid drift scope");
    return resolve(this.path(guildId), "..", `persona-drift.${channelId}.json`);
  }

  public async getScoped(guildId: string, channelId: string): Promise<ScopedPersonaDrift | null> {
    const raw = await readFile(this.scopedPath(guildId, channelId), "utf8").catch(() => null);
    if (!raw || raw.length > 52_000) return null;
    try { const result = scopedDriftSchema.safeParse(JSON.parse(raw) as unknown);
      return result.success && result.data.guildId === guildId && result.data.channelId === channelId ? result.data : null;
    } catch { return null; }
  }

  public async readScopedEpoch(guildId: string, channelId: string): Promise<string | null> {
    const path = this.scopedPath(guildId, channelId).replace(/\.json$/u, ".epoch.json");
    const raw = await readFile(path, "utf8").catch(() => "");
    return z.string().uuid().safeParse(raw.trim()).success ? raw.trim() : null;
  }

  public async evolveScoped(context: GuardedConversationContext, gateway: ConversationModelGateway, sessions: readonly ChatSessionExchange[], personalitySourceHash: string, now: number): Promise<void> {
    if (!isGuardedContext(context)) throw new SocialOutputSuppressed();
    if (!context.sharedMemoryAllowed) return;
    const { guildId, channelId } = context.scope;
    await this.queue.run(guildId, async () => {
      let epoch = await this.readScopedEpoch(guildId, channelId);
      if (!epoch) {
        epoch = randomUUID(); const path = this.scopedPath(guildId, channelId).replace(/\.json$/u, ".epoch.json");
        await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(`${path}.tmp`, epoch, "utf8"); await rename(`${path}.tmp`, path);
      }
      if (await context.resource({ kind: "persona_drift", id: epoch }) !== epoch) return;
      const previous = await this.getScoped(guildId, channelId);
      const next = await gateway.drift(context, sessions, previous, personalitySourceHash, epoch, now);
      if (!next || !await context.derived(next.contextProvenance, personaDriftPayload(next), "character_state") || !await context.validate()) return;
      const target = this.scopedPath(guildId, channelId); const temporary = `${target}.tmp`;
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(temporary, JSON.stringify(next), "utf8");
      if (!await context.validate()) { await rm(temporary, { force: true }); return; }
      await rename(temporary, target);
    });
  }

  // Explicit, admin-initiated "start the character over" — clears both the
  // current text and the audit history. Distinct from disabling the
  // guild's persona-drift toggle, which only pauses evolution/injection
  // without touching this file.
  public async reset(guildId: string): Promise<void> {
    await this.queue.run(guildId, async () => {
      const directory = resolve(this.path(guildId), "..");
      const files = await readdir(directory).catch(() => []);
      for (const file of files) if (/^persona-drift(?:\.[a-zA-Z0-9_-]+){0,2}\.json$/u.test(file)) await rm(resolve(directory, file), { force: true });
    });
  }

}
