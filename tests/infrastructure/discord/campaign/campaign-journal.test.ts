import { describe, expect, it } from "vitest";

import { contentOf, harness, started, type Harness } from "./handler-harness.js";

const system = { kind: "system" } as const;

// Puts a narrated round and the Chronicler's records into the game.
async function withStory(t: Harness): Promise<void> {
  await started(t);
  await t.r.store.transaction(async (tx) => {
    const stored = await tx.loadCampaign(t.key);
    if (stored === undefined) throw new Error("state");
    await tx.saveCampaign(t.key, { ...stored.state, lastNarratedRound: 3, sceneChangedRound: 3 }, stored.revision);
  });
  const record = async (command: Parameters<Harness["r"]["bus"]["execute"]>[1], id: string): Promise<void> => {
    const outcome = await t.r.bus.execute(t.key, command, { commandId: id, actor: system });
    if (outcome.kind !== "accepted") throw new Error(`${id}: ${JSON.stringify(outcome)}`);
  };
  await record({ kind: "recordSummary", throughRound: 2, visibility: "public", text: "The party met Garrick at the inn." }, "s1");
  await record({ kind: "recordSummary", throughRound: 3, visibility: "public", text: "They found the tower." }, "s2");
  await record({ kind: "recordSummary", throughRound: 3, visibility: "private", text: "SECRET-DM-SUMMARY Garrick pays the raiders." }, "s3");
  await record({ kind: "recordLedgerFact", entityId: "npc:garrick", canonicalName: "Garrick", fact: "Keeps the Crossroads Inn.", visibility: "public" }, "f1");
  await record({ kind: "recordLedgerFact", entityId: "npc:garrick", canonicalName: "Garrick", fact: "SECRET-FACT he is a smuggler.", visibility: "secret" }, "f2");
}

describe("the journal and the recap", () => {
  it("shows the chapters so far and what the world remembers, and nothing the table must not know", async () => {
    const t = await harness();
    await withStory(t);
    const journal = contentOf(await t.press("journal", "u-org"));
    expect(journal).toContain("**Journal**");
    expect(journal).toContain("• Rounds 1-2: The party met Garrick at the inn.");
    expect(journal).toContain("• Rounds 3-3: They found the tower.");
    expect(journal).toContain("**Garrick:** Keeps the Crossroads Inn.");
    expect(journal).not.toContain("SECRET");
    expect(journal).not.toContain("smuggler");
  });

  it("catches someone up with the latest chapter and where the party is, from More and on coming back", async () => {
    const t = await harness();
    await withStory(t);
    const recap = contentOf(await t.press("recap", "u-org"));
    expect(recap).toContain("**Story so far**");
    expect(recap).toContain("They found the tower.");
    expect(recap).not.toContain("SECRET");
    await t.press("away", "u-org");
    expect(contentOf(await t.press("back", "u-org"))).toContain("They found the tower.");
  });

  it("says plainly that nothing is written yet, and speaks Traditional Chinese", async () => {
    const empty = await harness();
    await started(empty);
    expect(contentOf(await empty.press("journal", "u-org"))).toContain("Nothing has been written down yet.");
    const zh = await harness("zh-TW");
    await withStory(zh);
    expect(contentOf(await zh.press("journal", "u-org"))).toContain("**日誌**");
    expect(contentOf(await zh.press("recap", "u-org"))).toContain("**前情提要**");
  });

  it("keeps a long journal inside Discord's limit, dropping the oldest chapters first", async () => {
    const t = await harness();
    await started(t);
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("state");
      const summaries = Array.from({ length: 30 }, (_, index) => ({ throughRound: index + 1, visibility: "public" as const, text: `Chapter ${index + 1}: ${"story ".repeat(40)}` }));
      await tx.saveCampaign(t.key, { ...stored.state, summaries }, stored.revision);
    });
    const journal = contentOf(await t.press("journal", "u-org"));
    expect(journal.length).toBeLessThanOrEqual(1900);
    expect(journal).toContain("Chapter 30");
    expect(journal).not.toContain("Chapter 1:");
  });
});
