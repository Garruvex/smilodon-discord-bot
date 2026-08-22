import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";

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
    return resolve(this.runtimeDataDirectory, "guild-assets", guildId, "persona-drift.json");
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
      const nextText = (await transform(current?.text ?? "")).trim();
      if (!nextText || nextText === current?.text) return;
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
      this.logger?.warn({ error, guildId }, "Persisting evolved persona drift failed; drift stays at its previous value");
    }
  }

  // Explicit, admin-initiated "start the character over" — clears both the
  // current text and the audit history. Distinct from disabling the
  // guild's persona-drift toggle, which only pauses evolution/injection
  // without touching this file.
  public async reset(guildId: string): Promise<void> {
    await this.queue.run(guildId, () => rm(this.path(guildId), { force: true }));
  }

  private async write(guildId: string, state: PersonaDriftState): Promise<void> {
    const target = this.path(guildId);
    await mkdir(resolve(this.runtimeDataDirectory, "guild-assets", guildId), { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, target);
  }
}
