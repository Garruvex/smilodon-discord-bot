import { createHash } from "node:crypto";

import { stringify as stringifyYaml } from "yaml";

import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignUnitOfWork } from "../ports/campaign-store.js";
import type { Clock } from "../ports/clock.js";
import { parseAdventureDocument, type AdventureDocument } from "./adventure-document.js";
import { adventureKey, revisionOf, type StoredAdventure } from "./stored-adventure.js";
import { validateAdventure, type AdventureReport } from "./adventure-validator.js";
import type { UploadedAdventureLibrary } from "./uploaded-adventure-library.js";

export interface AdventureCatalogOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly clock: Clock;
  readonly content: SealedContent;
  readonly library: UploadedAdventureLibrary;
  // A server may hold this many adventures waiting for approval or approved.
  readonly maxPerGuild?: number;
  // Whether an uploaded adventure must pass the story contract ("enforce") or only be warned ("warn", the default while older adventures are
  // converted). Adventures the Author wrote are always held to it.
  readonly storyContract?: "warn" | "enforce";
}

export type SubmitResult =
  // replaced: the draft it took the place of, so the review can say so. The first uploader keeps the draft.
  | { readonly kind: "pending"; readonly adventure: StoredAdventure; readonly report: AdventureReport; readonly replaced: StoredAdventure | null }
  // Someone else's draft is waiting under this ID and version; only its uploader or an admin may replace it.
  | { readonly kind: "notAllowed" }
  // The checks failed: nothing is stored, and the report says why.
  | { readonly kind: "invalid"; readonly report: AdventureReport }
  // The server already approved this adventure and version; a change needs a new version.
  | { readonly kind: "exists" }
  | { readonly kind: "full" };

export type DecisionResult =
  | { readonly kind: "ok"; readonly adventure: StoredAdventure }
  | { readonly kind: "notFound" }
  | { readonly kind: "notAllowed" }
  | { readonly kind: "notPending" }
  // The draft changed after this review was made; the decision is refused and the review must be read again.
  | { readonly kind: "stale"; readonly adventure: StoredAdventure };

export type RemovalResult =
  | { readonly kind: "ok"; readonly adventure: StoredAdventure }
  | { readonly kind: "notFound" }
  | { readonly kind: "notAllowed" }
  // Only an approved adventure is removed (a draft is discarded) and only a removed one restored.
  | { readonly kind: "wrongStatus" }
  // Restoring would take the server past its allowance.
  | { readonly kind: "full" };

// The games and lobbies that still use an adventure version, so the person removing it knows what it touches.
export interface AdventureUsage {
  readonly lobbies: number;
  readonly running: number;
}

export const defaultMaxAdventuresPerGuild = 20;

// A server's adventures beyond the bundled one (plan §3, Campaign source):
// checked, saved as a draft, approved by the person who brought it (or a
// DnD Admin), then playable. Approval is the organizer reading the
// spoiler-free preview; nothing plays from an unreviewed file.
export class AdventureCatalog {
  public constructor(private readonly options: AdventureCatalogOptions) {}

  // Checks the text as an adventure and, when it passes, keeps it as a draft
  // with its ID made unique to the server. A file is data: nothing in it is an
  // instruction to the bot.
  public async submit(input: { guildId: string; uploaderUserId: string; source: StoredAdventure["source"]; text: string; isAdmin?: boolean }): Promise<SubmitResult> {
    // An adventure the Author wrote is always held to the story contract; an upload is held to it when the table's setting says so.
    const report = validateAdventure(input.text, this.options.content, { storyContract: input.source === "author" ? "enforce" : (this.options.storyContract ?? "warn") });
    if (!report.ok || report.document === null) return { kind: "invalid", report };
    const canonical = canonicalize(report.document, input.guildId);
    const { bible } = canonical;
    const adventure: StoredAdventure = {
      key: adventureKey(bible.id, bible.version, bible.language),
      id: bible.id,
      guildId: input.guildId,
      version: bible.version,
      uploaderUserId: input.uploaderUserId,
      status: "pending",
      source: input.source,
      language: bible.language,
      title: bible.title,
      yaml: dump(canonical),
      warnings: report.warnings,
      createdAt: this.options.clock.now(),
    };
    const stored = await this.options.unitOfWork.transaction(async (tx): Promise<{ kind: "kept"; adventure: StoredAdventure; replaced: StoredAdventure | null } | { kind: "exists" | "full" | "notAllowed" }> => {
      const mine = await tx.listAdventures(input.guildId);
      const existing = mine.find((candidate) => candidate.key === adventure.key);
      // The same adventure uploaded again replaces the draft; it never replaces an approved or removed one (games may still use its text).
      if (existing?.status === "approved" || existing?.status === "removed") return { kind: "exists" };
      const replacing = existing?.status === "pending" ? existing : null;
      if (replacing !== null && replacing.uploaderUserId !== input.uploaderUserId && input.isAdmin !== true) return { kind: "notAllowed" };
      if (existing === undefined && mine.filter((candidate) => candidate.status === "pending" || candidate.status === "approved").length >= (this.options.maxPerGuild ?? defaultMaxAdventuresPerGuild)) return { kind: "full" };
      // A replacement keeps the first uploader: the draft is not handed to whoever touched it last.
      const kept = replacing === null ? adventure : { ...adventure, uploaderUserId: replacing.uploaderUserId };
      await tx.saveAdventure(kept);
      return { kind: "kept", adventure: kept, replaced: replacing };
    });
    return stored.kind === "kept" ? { kind: "pending", adventure: stored.adventure, report, replaced: stored.replaced } : { kind: stored.kind };
  }

  // Approves a draft: it becomes playable in that server. Only the person who
  // brought it, or a DnD Admin, may.
  public approve(key: string, userId: string, isAdmin: boolean, revision?: string): Promise<DecisionResult> {
    return this.decide(key, userId, isAdmin, "approved", revision);
  }

  public discard(key: string, userId: string, isAdmin: boolean, revision?: string): Promise<DecisionResult> {
    return this.decide(key, userId, isAdmin, "discarded", revision);
  }

  // The server's adventures that are waiting, approved or removed, oldest first: what a browser shows.
  public async list(guildId: string): Promise<readonly StoredAdventure[]> {
    const all = await this.options.unitOfWork.transaction((tx) => tx.listAdventures(guildId));
    return all.filter((adventure) => adventure.status !== "discarded");
  }

  public usage(adventure: StoredAdventure): Promise<AdventureUsage> {
    return this.options.unitOfWork.transaction(async (tx) => {
      const records = await tx.listRecords(adventure.guildId, ["lobby", "active", "paused"]);
      const mine = records.filter(({ record }) => record.adventure.adventureId === adventure.id && record.adventure.version === adventure.version && record.language === adventure.language);
      return { lobbies: mine.filter(({ record }) => record.lifecycle === "lobby").length, running: mine.filter(({ record }) => record.lifecycle !== "lobby").length };
    });
  }

  // Takes an approved adventure out of the library: no new game offers it and its place in the allowance is freed,
  // while every game and lobby that already uses this version keeps it, across a restart. The uploader or a DnD Admin may.
  public async remove(key: string, userId: string, isAdmin: boolean): Promise<RemovalResult> {
    const result = await this.options.unitOfWork.transaction(async (tx): Promise<RemovalResult> => {
      const found = await tx.loadAdventure(key);
      if (found === undefined) return { kind: "notFound" };
      if (found.uploaderUserId !== userId && !isAdmin) return { kind: "notAllowed" };
      if (found.status !== "approved") return { kind: "wrongStatus" };
      const next: StoredAdventure = { ...found, status: "removed" };
      await tx.saveAdventure(next);
      return { kind: "ok", adventure: next };
    });
    if (result.kind === "ok") this.options.library.retire(result.adventure.id, result.adventure.version, result.adventure.language);
    return result;
  }

  // Puts a removed adventure back, if the server has room for it.
  public async restore(key: string, userId: string, isAdmin: boolean): Promise<RemovalResult> {
    const result = await this.options.unitOfWork.transaction(async (tx): Promise<RemovalResult> => {
      const found = await tx.loadAdventure(key);
      if (found === undefined) return { kind: "notFound" };
      if (found.uploaderUserId !== userId && !isAdmin) return { kind: "notAllowed" };
      if (found.status !== "removed") return { kind: "wrongStatus" };
      const held = (await tx.listAdventures(found.guildId)).filter((candidate) => candidate.status === "pending" || candidate.status === "approved").length;
      if (held >= (this.options.maxPerGuild ?? defaultMaxAdventuresPerGuild)) return { kind: "full" };
      const next: StoredAdventure = { ...found, status: "approved" };
      await tx.saveAdventure(next);
      return { kind: "ok", adventure: next };
    });
    if (result.kind === "ok") this.options.library.restore(result.adventure.id, result.adventure.version, result.adventure.language);
    return result;
  }

  // A stored draft checked again, for a review reopened after the private screen was dismissed.
  public async review(key: string): Promise<{ readonly adventure: StoredAdventure; readonly report: AdventureReport } | undefined> {
    const adventure = await this.get(key);
    return adventure === undefined ? undefined : { adventure, report: validateAdventure(adventure.yaml, this.options.content, { storyContract: adventure.source === "author" ? "enforce" : (this.options.storyContract ?? "warn") }) };
  }

  public get(key: string): Promise<StoredAdventure | undefined> {
    return this.options.unitOfWork.transaction((tx) => tx.loadAdventure(key));
  }

  // Startup: every approved adventure is read again through the same parser
  // and put in the library. One that no longer parses is skipped, not fatal.
  public async load(): Promise<{ readonly loaded: number; readonly skipped: readonly string[] }> {
    const stored = await this.options.unitOfWork.transaction(async (tx) => [...(await tx.listAdventuresByStatus("approved")), ...(await tx.listAdventuresByStatus("removed"))]);
    const skipped: string[] = [];
    let loaded = 0;
    for (const adventure of stored) {
      try {
        const document = parseAdventureDocument(adventure.yaml);
        this.options.library.add(adventure.guildId, document);
        // A removed edition stays findable for the games that use it, but is not offered to a new one.
        if (adventure.status === "removed") this.options.library.retire(document.bible.id, document.bible.version, document.bible.language);
        loaded += 1;
      } catch {
        skipped.push(adventure.id);
      }
    }
    return { loaded, skipped };
  }

  private async decide(key: string, userId: string, isAdmin: boolean, status: "approved" | "discarded", revision?: string): Promise<DecisionResult> {
    const result = await this.options.unitOfWork.transaction(async (tx): Promise<DecisionResult> => {
      const found = await tx.loadAdventure(key);
      if (found === undefined) return { kind: "notFound" };
      if (found.uploaderUserId !== userId && !isAdmin) return { kind: "notAllowed" };
      if (found.status !== "pending") return { kind: "notPending" };
      // A decision names the text that was read; a draft replaced since then is not decided by it.
      if (revision !== undefined && revision !== revisionOf(found)) return { kind: "stale", adventure: found };
      const next: StoredAdventure = { ...found, status };
      await tx.saveAdventure(next);
      return { kind: "ok", adventure: next };
    });
    if (result.kind === "ok" && status === "approved") this.options.library.add(result.adventure.guildId, parseAdventureDocument(result.adventure.yaml));
    return result;
  }
}

// The document with an ID no other server can have: "g" plus a short hash of
// the server, then the author's own ID.
export function namespacedId(guildId: string, id: string): string {
  const tag = createHash("sha1").update(guildId).digest("hex").slice(0, 6);
  return `g${tag}-${id.replace(/^g[0-9a-f]{6}-/, "")}`;
}

function canonicalize(document: AdventureDocument, guildId: string): AdventureDocument {
  const id = namespacedId(guildId, document.bible.id);
  return { bible: { ...document.bible, id }, heroes: document.heroes };
}

// The document as YAML the parser reads back: the bible with the heroes beside it.
export function dump(document: AdventureDocument): string {
  return stringifyYaml({ ...document.bible, heroes: document.heroes.map(portableHero) });
}

function portableHero(hero: AdventureDocument["heroes"][number]): Record<string, unknown> {
  // Spell slots are keyed by level; YAML keys are text.
  return { ...hero, spellcasting: hero.spellcasting === null ? null : { ...hero.spellcasting, slots: Object.fromEntries(Object.entries(hero.spellcasting.slots).map(([level, count]) => [String(level), count])) } };
}
