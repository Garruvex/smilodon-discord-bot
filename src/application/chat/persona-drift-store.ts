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
import { safeFailure } from "../diagnostics/chat-diagnostics.js";

const scopedDriftSchema = z.object({ guildId: z.string().min(1).max(128), channelId: z.string().min(1).max(128), epoch: z.string().uuid(), personalitySourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  text: z.string().max(1000), updatedAt: z.number().finite().nonnegative(), contextProvenance: contextProvenanceSchema }).strict();

// A small, additive "current mood/quirk" layer that evolves slightly over
// time from actual conversation activity (see ChatConversationService's
// consolidation hook) — never the admin-authored personality.md, lore
// bundle, or examples.md, all of which stay untouched. Capped hard so no
// single cycle can swing the character far; `history` exists purely for
// admin auditability, not read at chat time.
// personalitySourceHash pins the drift to the personality.md content it last
// evolved from (same hashContent used for bundle staleness in
// file-persona-source.ts). A mismatch — the admin rewrote the personality
// since — means the drift text can no longer be trusted to agree with the
// character and the caller discards it rather than injecting it.
const personaDriftStateSchema = z.object({
  text: z.string(),
  updatedAt: z.number(),
  personalitySourceHash: z.string(),
  history: z.array(z.object({ text: z.string(), changedAt: z.number() })),
});

export type PersonaDriftState = z.infer<typeof personaDriftStateSchema>;

// Bounds how large persona-drift.json's audit trail can grow — old entries
// are dropped, not the recent ones, since only the tail is ever useful for
// "what changed recently."
const maxHistoryEntries = 50;

/**
 * Reads/writes guild-assets/{guildId}/persona-drift.json — a sidecar in the
 * same directory convention GuildAssetStore already uses, but app-managed
 * state rather than an admin-uploaded asset, so it creates its own
 * directory rather than depending on one already existing.
 */
export class PersonaDriftStore {
  private readonly queue = new KeyedSerialQueue();

  public constructor(
    private readonly runtimeDataDirectory: string,
    private readonly logger: Logger | null = null,
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

  public async get(guildId: string): Promise<PersonaDriftState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(guildId), "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = personaDriftStateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  // Appends `nextText` as the new current drift, keeping the prior text as
  // a history entry. Never throws — a write failure is logged and the drift
  // simply doesn't update this cycle, same fail-safe posture as
  // ChatConversationService's other consolidation-triggered writes.
  public async evolve(guildId: string, nextText: string, personalitySourceHash: string): Promise<void> {
    await this.queue.run(guildId, () => this.persistEvolution(guildId, nextText, personalitySourceHash));
  }

  // Serializes the entire read → model transform → write transaction per
  // guild. Chat turns are queued per guild+user, so different users can
  // otherwise evolve the same guild-wide drift from the same stale value.
  // `personalitySourceHash` is the hash of the personality content this
  // evolution cycle ran against; a prior drift hashed against a since-edited
  // personality is treated as stale and not fed into `transform`.
  public async evolveFrom(
    guildId: string,
    personalitySourceHash: string,
    transform: (currentText: string) => Promise<string>,
  ): Promise<void> {
    await this.queue.run(guildId, async () => {
      const stored = await this.get(guildId);
      const current = stored && stored.personalitySourceHash === personalitySourceHash ? stored : null;
      const currentText = current?.text ?? "";
      const nextText = (await transform(currentText)).trim();
      // "" is a valid, meaningful result — see PersonaDriftEvolver's doc
      // comment: it means "nothing worth noting yet," i.e. clear the
      // current mood, not "leave it as it is." Only skip the write when
      // nothing actually changed (including both being "").
      if (nextText === currentText) return;
      await this.persistEvolution(guildId, nextText, personalitySourceHash, current);
    });
  }

  private async persistEvolution(
    guildId: string,
    nextText: string,
    personalitySourceHash: string,
    knownCurrent?: PersonaDriftState | null,
  ): Promise<void> {
    try {
      const current = knownCurrent === undefined ? await this.get(guildId) : knownCurrent;
      const now = Date.now();
      const history = current
        ? [...current.history, { text: current.text, changedAt: current.updatedAt }].slice(-maxHistoryEntries)
        : [];
      await this.write(guildId, { text: nextText, updatedAt: now, personalitySourceHash, history });
    } catch (error) {
      this.logger?.warn({ failure: safeFailure(error), guildId }, "Persisting evolved persona drift failed; drift stays at its previous value");
    }
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

  private async write(guildId: string, state: PersonaDriftState): Promise<void> {
    const target = this.path(guildId);
    await mkdir(resolve(this.runtimeDataDirectory, "guild-assets", guildId), { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, target);
  }
}
