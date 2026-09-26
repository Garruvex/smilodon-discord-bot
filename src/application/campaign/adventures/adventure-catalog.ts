import { createHash } from "node:crypto";

import { stringify as stringifyYaml } from "yaml";

import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignUnitOfWork } from "../ports/campaign-store.js";
import type { Clock } from "../ports/clock.js";
import { parseAdventureDocument, type AdventureDocument } from "./adventure-document.js";
import { adventureKey, type StoredAdventure } from "./stored-adventure.js";
import { validateAdventure, type AdventureReport } from "./adventure-validator.js";
import type { UploadedAdventureLibrary } from "./uploaded-adventure-library.js";

export interface AdventureCatalogOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly clock: Clock;
  readonly content: SealedContent;
  readonly library: UploadedAdventureLibrary;
  // A server may hold this many adventures waiting for approval or approved.
  readonly maxPerGuild?: number;
}

export type SubmitResult =
  | { readonly kind: "pending"; readonly adventure: StoredAdventure; readonly report: AdventureReport }
  // The checks failed: nothing is stored, and the report says why.
  | { readonly kind: "invalid"; readonly report: AdventureReport }
  // The server already approved this adventure and version; a change needs a new version.
  | { readonly kind: "exists" }
  | { readonly kind: "full" };

export type DecisionResult =
  | { readonly kind: "ok"; readonly adventure: StoredAdventure }
  | { readonly kind: "notFound" }
  | { readonly kind: "notAllowed" }
  | { readonly kind: "notPending" };

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
  public async submit(input: { guildId: string; uploaderUserId: string; source: StoredAdventure["source"]; text: string }): Promise<SubmitResult> {
    const report = validateAdventure(input.text, this.options.content);
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
    const stored = await this.options.unitOfWork.transaction(async (tx): Promise<"kept" | "exists" | "full"> => {
      const mine = await tx.listAdventures(input.guildId);
      const existing = mine.find((candidate) => candidate.key === adventure.key);
      // The same adventure uploaded again replaces the draft; it never replaces an approved one.
      if (existing?.status === "approved") return "exists";
      if (existing === undefined && mine.filter((candidate) => candidate.status !== "discarded").length >= (this.options.maxPerGuild ?? defaultMaxAdventuresPerGuild)) return "full";
      await tx.saveAdventure(adventure);
      return "kept";
    });
    return stored === "kept" ? { kind: "pending", adventure, report } : { kind: stored };
  }

  // Approves a draft: it becomes playable in that server. Only the person who
  // brought it, or a DnD Admin, may.
  public approve(key: string, userId: string, isAdmin: boolean): Promise<DecisionResult> {
    return this.decide(key, userId, isAdmin, "approved");
  }

  public discard(key: string, userId: string, isAdmin: boolean): Promise<DecisionResult> {
    return this.decide(key, userId, isAdmin, "discarded");
  }

  public get(key: string): Promise<StoredAdventure | undefined> {
    return this.options.unitOfWork.transaction((tx) => tx.loadAdventure(key));
  }

  // Startup: every approved adventure is read again through the same parser
  // and put in the library. One that no longer parses is skipped, not fatal.
  public async load(): Promise<{ readonly loaded: number; readonly skipped: readonly string[] }> {
    const approved = await this.options.unitOfWork.transaction((tx) => tx.listAdventuresByStatus("approved"));
    const skipped: string[] = [];
    let loaded = 0;
    for (const adventure of approved) {
      try {
        this.options.library.add(adventure.guildId, parseAdventureDocument(adventure.yaml));
        loaded += 1;
      } catch {
        skipped.push(adventure.id);
      }
    }
    return { loaded, skipped };
  }

  private async decide(key: string, userId: string, isAdmin: boolean, status: "approved" | "discarded"): Promise<DecisionResult> {
    const result = await this.options.unitOfWork.transaction(async (tx): Promise<DecisionResult> => {
      const found = await tx.loadAdventure(key);
      if (found === undefined) return { kind: "notFound" };
      if (found.uploaderUserId !== userId && !isAdmin) return { kind: "notAllowed" };
      if (found.status !== "pending") return { kind: "notPending" };
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
