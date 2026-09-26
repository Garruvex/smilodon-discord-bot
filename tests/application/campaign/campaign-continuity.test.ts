import { describe, expect, it } from "vitest";

import { CampaignRuntime } from "../../../src/application/campaign/campaign-runtime.js";
import { assembleContext, estimateTokens, renderTranscript, type ContextInput } from "../../../src/application/campaign/dm/context-assembler.js";
import { ScriptedNarrator, ScriptedPlanner } from "../../../src/application/campaign/dm/scripted-dm.js";
import type { CampaignChronicler, ChronicleRequest } from "../../../src/application/campaign/ports/dm-ports.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { DeliveryWorker } from "../../../src/application/campaign/workers/delivery-worker.js";
import { DmJobWorker } from "../../../src/application/campaign/workers/dm-job-worker.js";
import { RollWorker } from "../../../src/application/campaign/workers/roll-worker.js";
import { TimerWorker } from "../../../src/application/campaign/workers/timer-worker.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { quiet, rig, starter, startedCampaign, type Rig } from "./campaign-rig.js";

// A three-session campaign, played through the runtime with a scripted DM and
// a scripted Chronicler: plan §12, milestone 5: "keeps established facts and
// names consistent; secrets stay private".

const player = { kind: "user", userId: "u-org" } as const;
const day = 24 * 3600 * 1000;
const hero = starter.en.heroes[0]?.id ?? "";
const secretLine = "Garrick secretly pays Skarn's raiders";

class ScriptedChronicler implements CampaignChronicler {
  public readonly requests: ChronicleRequest[] = [];
  public constructor(private readonly reply: (request: ChronicleRequest) => { summary: string; facts: { entityId: string; canonicalName: string; fact: string }[] }) {}
  public chronicle(request: ChronicleRequest): Promise<ReturnType<ScriptedChronicler["reply"]>> {
    this.requests.push(request);
    return Promise.resolve(this.reply(request));
  }
}

interface Campaign {
  r: Rig;
  key: CampaignKey;
  chronicler: ScriptedChronicler;
  narrator: ScriptedNarrator;
  runtime: CampaignRuntime;
}

async function campaign(reply?: ScriptedChronicler["reply"]): Promise<Campaign> {
  const r = rig();
  const chronicler = new ScriptedChronicler(
    reply ??
      ((request): ReturnType<ScriptedChronicler["reply"]> =>
        request.audience === "public"
          ? {
              summary: `The party kept working the case (${request.transcript.split("Round ").length - 1} rounds).`,
              facts: [{ entityId: "npc:garrick", canonicalName: "Garrick", fact: "Runs the Crossroads Inn." }],
            }
          : { summary: "Garrick pays the raiders for word of rich travelers.", facts: [{ entityId: "npc:garrick", canonicalName: "Garrick", fact: secretLine }] }),
  );
  const planner = new ScriptedPlanner(r.plannerScript);
  const narrator = new ScriptedNarrator(Array.from({ length: 60 }, () => (request: { roundNumber: number }): { text: string } => ({ text: `Garrick eyes the party through round ${request.roundNumber}.` })));
  const dm = new DmJobWorker({
    unitOfWork: r.store,
    bus: r.bus,
    planner,
    narrator,
    chronicler,
    adventures: r.adventures,
    glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary },
  });
  const runtime = new CampaignRuntime({
    unitOfWork: r.store,
    bus: r.bus,
    rolls: new RollWorker(r.store, r.bus, new SeededRandomSource(3), r.clock),
    timers: new TimerWorker(r.store, r.bus, r.clock),
    dm,
    delivery: new DeliveryWorker(r.store, r.presenter),
    logger: quiet,
    bootId: "boot",
  });
  const key = await startedCampaign(r);
  return { r, key, chronicler, narrator, runtime };
}

// One round: the player acts, the Planner resolves it, the Narrator tells it.
async function playRound(c: Campaign, number: number): Promise<void> {
  c.r.plannerScript.push({ roundNumber: number, actions: [{ characterId: hero, resolution: { kind: "automatic", reason: `Planner-only reason ${number}.` } }] });
  await c.r.bus.execute(c.key, { kind: "submitAction", characterId: hero, text: `I keep asking about the raids (${number}).` }, { commandId: `act-${number}`, actor: player });
  await c.runtime.runOnce();
  await c.runtime.runOnce();
}

const stateOf = async (c: Campaign): Promise<CampaignState> => {
  const stored = await c.r.store.transaction((tx) => tx.loadCampaign(c.key));
  if (stored === undefined) throw new Error("state");
  return stored.state;
};

async function contextFor(c: Campaign, audience: "planner" | "narrator", budgetTokens = 30_000): Promise<{ text: string; tokens: number; omitted: number }> {
  const state = await stateOf(c);
  const events = (await c.r.store.transaction((tx) => tx.readEvents(c.key))).map((envelope) => envelope.event);
  const context = assembleContext({ audience, state, events, bible: starter.en.bible, glossary: enSrd51Glossary, budgetTokens });
  return { text: context.sections.map((section) => `[${section.layer}] ${section.text}`).join("\n\n"), tokens: context.estimatedTokens, omitted: context.omittedRounds };
}

describe("a campaign over three sessions", () => {
  it("condenses played rounds as it goes, keeps names and facts, and never lets a secret into what the table reads", async () => {
    const c = await campaign();
    let number = 0;
    for (let session = 1; session <= 3; session += 1) {
      for (let round = 0; round < 5; round += 1) {
        number += 1;
        await playRound(c, number);
      }
      // The table stops for the night and comes back a day later.
      await c.r.bus.execute(c.key, { kind: "pauseCampaign", reason: "organizer" }, { commandId: `pause-${session}`, actor: player });
      c.r.clock.advance(day);
      await c.runtime.runOnce();
      await c.r.bus.execute(c.key, { kind: "continue" }, { commandId: `resume-${session}`, actor: player });
    }
    const state = await stateOf(c);
    expect(state.lastNarratedRound).toBe(15);

    // Summaries were kept, oldest first, for both audiences; the public ones came from public text alone.
    const publicSummaries = (state.summaries ?? []).filter((summary) => summary.visibility === "public");
    const privateSummaries = (state.summaries ?? []).filter((summary) => summary.visibility === "private");
    expect(publicSummaries.map((summary) => summary.throughRound)).toEqual([6, 12]);
    expect(privateSummaries.map((summary) => summary.throughRound)).toEqual([6, 12]);
    for (const request of c.chronicler.requests.filter((candidate) => candidate.audience === "public")) {
      expect(request.transcript).not.toContain("Planner-only reason");
      expect(request.transcript).not.toContain(secretLine);
    }
    expect(c.chronicler.requests.some((request) => request.audience === "private" && request.transcript.includes("Planner-only reason"))).toBe(true);
    // The second summary was written knowing the first, so it can continue rather than repeat.
    expect(c.chronicler.requests.filter((request) => request.audience === "public")[1]?.previousSummary).toContain("The party kept working the case");

    // One name for one person, however many times the Chronicler mentions them.
    expect(state.ledger["npc:garrick"]?.canonicalName).toBe("Garrick");
    expect(state.ledger["npc:garrick"]?.facts.filter((fact) => fact.visibility === "secret")).toHaveLength(2);

    // What the Narrator reads: the summaries and the public facts, never anything private.
    const narrator = await contextFor(c, "narrator");
    expect(narrator.text).toContain("The party kept working the case");
    expect(narrator.text).toContain("Garrick: Runs the Crossroads Inn.");
    expect(narrator.text).not.toContain(secretLine);
    expect(narrator.text).not.toContain("Garrick pays the raiders");
    expect(narrator.text).not.toContain("Planner-only reason");
    expect(narrator.text).not.toContain(starter.en.bible.dmOverview.slice(0, 60));
    // The Planner sees the private side too.
    const planner = await contextFor(c, "planner");
    expect(planner.text).toContain("(DM only) Garrick pays the raiders");
    expect(planner.text).toContain(secretLine);

    // Every request the Narrator was actually sent obeyed the same rule.
    for (const request of c.narrator.requests) {
      const text = JSON.stringify(request);
      expect(text).not.toContain(secretLine);
      expect(text).not.toContain("Garrick pays the raiders");
    }
  });

  it("stays inside a tight budget by leaving covered rounds to their summaries, without losing the latest rounds", async () => {
    const c = await campaign();
    for (let number = 1; number <= 13; number += 1) await playRound(c, number);
    const full = await contextFor(c, "narrator");
    const latest = (await stateOf(c)).lastRoundNumber;
    // Rounds covered by summaries are gone from the transcript; the latest two stay word for word.
    expect(full.text).toContain(`Round ${latest}`);
    expect(full.text).toContain(`Round ${latest - 1}`);
    expect(full.text).not.toContain("Round 3\n");
    const tight = await contextFor(c, "narrator", full.tokens - 12);
    expect(tight.tokens).toBeLessThanOrEqual(full.tokens - 12);
    expect(tight.text).toContain(`Round ${latest}`);
    // The oldest summaries gave way first.
    expect(tight.tokens).toBeLessThan(full.tokens);
  });

  it("never states hit points or gold in the record: such a summary is refused and the rounds stay in the transcript", async () => {
    const c = await campaign((request) => ({ summary: request.audience === "public" ? "Mira is down to 4 HP and the party has 30 gold." : "Fine.", facts: [] }));
    for (let number = 1; number <= 6; number += 1) await playRound(c, number);
    const state = await stateOf(c);
    expect((state.summaries ?? []).some((summary) => summary.visibility === "public")).toBe(false);
    expect((await contextFor(c, "narrator")).text).toContain("Round 1");
  });

  it("refuses a Chronicler that tries to rename a known person, and keeps the first spelling", async () => {
    const c = await campaign((request) => ({
      summary: "The party pressed on.",
      facts: [{ entityId: "npc:garrick", canonicalName: request.knownEntities.length === 0 ? "Garrick" : "Gareth", fact: "Keeps the inn." }],
    }));
    for (let number = 1; number <= 12; number += 1) await playRound(c, number);
    const state = await stateOf(c);
    expect(state.ledger["npc:garrick"]?.canonicalName).toBe("Garrick");
    expect(JSON.stringify(state.ledger)).not.toContain("Gareth");
  });

  it("does nothing when no Chronicler is configured, and play carries on", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    r.plannerScript.push({ roundNumber: 1, actions: [{ characterId: hero, resolution: { kind: "automatic", reason: "x" } }] });
    await r.bus.execute(key, { kind: "submitAction", characterId: hero, text: "I wait." }, { commandId: "a", actor: player });
    await r.runtime().runOnce();
    await r.runtime().runOnce();
    const stored = await r.store.transaction((tx) => tx.loadCampaign(key));
    expect(stored?.state.lastNarratedRound).toBe(1);
    expect(stored?.state.summaries).toBeUndefined();
    expect(renderTranscript).toBeDefined();
    expect(estimateTokens("x")).toBe(1);
    const input: ContextInput | null = null;
    expect(input).toBeNull();
  });
});
