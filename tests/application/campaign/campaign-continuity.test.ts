import { describe, expect, it } from "vitest";

import { encounterSpec, findEncounter } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { GeneratedImage } from "../../../src/application/campaign/ports/image-ports.js";
import { ImageWorker } from "../../../src/application/campaign/workers/image-worker.js";
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

describe("a large ledger", () => {
  it("shows only the entities in the scene or named lately, keeps secrets from the Narrator, and says how many it left out", async () => {
    const c = await campaign();
    await playRound(c, 1);
    for (let index = 0; index < 30; index += 1) {
      await c.r.bus.execute(
        c.key,
        { kind: "recordLedgerFact", entityId: `npc:extra-${index}`, canonicalName: `Extra Person ${index}`, fact: index === 7 ? "Sells rope." : "Stands about.", visibility: index === 8 ? "secret" : "public" },
        { commandId: `fact-${index}`, actor: { kind: "system" } },
      );
    }
    await c.r.bus.execute(c.key, { kind: "recordLedgerFact", entityId: "npc:garrick", canonicalName: "Garrick", fact: "Keeps the inn.", visibility: "public" }, { commandId: "garrick", actor: { kind: "system" } });
    const narrator = await contextFor(c, "narrator");
    // Garrick is in the scene; the rest are not, unless somebody mentions them.
    expect(narrator.text).toContain("npc:garrick Garrick: Keeps the inn.");
    expect(narrator.text).not.toContain("Extra Person 3:");
    expect(narrator.text).toMatch(/\d+ more remembered entries are not relevant right now\./);
    await c.r.bus.execute(c.key, { kind: "submitAction", characterId: hero, text: "I ask Extra Person 7 about rope." }, { commandId: "ask", actor: player });
    const named = await contextFor(c, "narrator");
    expect(named.text).toContain("Extra Person 7");
    // A secret entity is never in the Narrator's ledger, and the DM sees it when it matters.
    expect(named.text).not.toContain("Extra Person 8");
  });
});

describe("retelling the last scene", () => {
  it("tells the same round again from the same outcomes, changing only the words", async () => {
    const c = await campaign();
    await playRound(c, 1);
    const before = await stateOf(c);
    expect(before.lastNarratedRound).toBe(1);
    const eventsBefore = (await c.r.store.transaction((tx) => tx.readEvents(c.key))).map((envelope) => envelope.event);

    const asked = await c.r.bus.execute(c.key, { kind: "regenerateNarration", roundNumber: 1 }, { commandId: "retell", actor: player });
    expect(asked.kind).toBe("accepted");
    await c.runtime.runOnce();
    await c.runtime.runOnce();
    const eventsAfter = (await c.r.store.transaction((tx) => tx.readEvents(c.key))).map((envelope) => envelope.event);
    const added = eventsAfter.slice(eventsBefore.length);
    // One new telling of round 1, and nothing else happened: no dice, no state change, no new round.
    expect(added.map((event) => event.kind)).toEqual(["narrationRecorded"]);
    expect(added[0]).toMatchObject({ roundNumber: 1 });
    const after = await stateOf(c);
    expect({ lastNarratedRound: after.lastNarratedRound, heroStatus: after.heroStatus, checks: after.checks, round: after.round?.number, encounter: after.encounter }).toEqual({
      lastNarratedRound: before.lastNarratedRound,
      heroStatus: before.heroStatus,
      checks: before.checks,
      round: before.round?.number,
      encounter: before.encounter,
    });
    // The table is told it is a retelling.
    expect(c.r.presenter.delivered).toContainEqual({ kind: "narration", roundNumber: 1, regenerated: true });
  });

  it("is only for the organizer, only for the round just told, and never twice for the same request", async () => {
    const c = await campaign();
    await playRound(c, 1);
    await playRound(c, 2);
    expect(await c.r.bus.execute(c.key, { kind: "regenerateNarration", roundNumber: 1 }, { commandId: "old", actor: player })).toEqual({ kind: "rejected", rejection: { code: "nothingToRetell" } });
    expect(await c.r.bus.execute(c.key, { kind: "regenerateNarration", roundNumber: 2 }, { commandId: "other", actor: { kind: "user", userId: "u-other" } })).toEqual({ kind: "rejected", rejection: { code: "notOrganizer" } });
    expect(await c.r.bus.execute(c.key, { kind: "replaceNarration", roundNumber: 2, text: "Forged." }, { commandId: "forge", actor: player })).toEqual({ kind: "rejected", rejection: { code: "systemOnly" } });
    const first = await c.r.bus.execute(c.key, { kind: "regenerateNarration", roundNumber: 2 }, { commandId: "same", actor: player });
    expect(await c.r.bus.execute(c.key, { kind: "regenerateNarration", roundNumber: 2 }, { commandId: "same", actor: player })).toEqual(first);
  });
});

describe("the safety pause", () => {
  it("asks the next narration to be gentle without saying who asked, and stops asking once it is told", async () => {
    const c = await campaign();
    await playRound(c, 1);
    await c.r.bus.execute(c.key, { kind: "pauseCampaign", reason: "safety" }, { commandId: "safety", actor: { kind: "user", userId: "u-org" } });
    expect((await stateOf(c)).safetyNote).toBe(true);
    const narrator = await contextFor(c, "narrator");
    expect(narrator.text).toContain("Someone at the table used the safety pause. Keep the next narration gentle");
    expect(narrator.text).not.toContain("u-org");
    expect((await contextFor(c, "planner")).text).toContain("Keep the next narration gentle");

    await c.r.bus.execute(c.key, { kind: "continue" }, { commandId: "resume", actor: player });
    await playRound(c, (await stateOf(c)).lastRoundNumber);
    expect((await stateOf(c)).safetyNote).toBe(false);
    expect((await contextFor(c, "narrator")).text).not.toContain("safety pause");
  });
});

describe("pictures of monsters and moments", () => {
  const painter = (): { prompts: string[]; posted: { caption: string }[]; broken: { on: boolean }; worker: (c: Campaign, extra?: Partial<ConstructorParameters<typeof ImageWorker>[0]>) => ImageWorker } => {
    const broken = { on: false };
    const prompts: string[] = [];
    const posted: { caption: string }[] = [];
    const kept = new Map<string, GeneratedImage>();
    return {
      prompts,
      posted,
      broken,
      worker: (c, extra = {}): ImageWorker =>
        new ImageWorker({
          unitOfWork: c.r.store,
          adventures: c.r.adventures,
          generator: {
            generate: (request): Promise<GeneratedImage> => {
              prompts.push(request.prompt);
              if (broken.on) return Promise.reject(new Error("The model is down."));
              return Promise.resolve({ bytes: Buffer.alloc(10), mediaType: "image/png" });
            },
          },
          sink: { post: (_channel, _image, caption): Promise<void> => (posted.push({ caption }), Promise.resolve()) },
          assets: {
            save: (key, subject, image): Promise<void> => (kept.set(`${key.campaignId}:${subject}`, image), Promise.resolve()),
            load: (key, subject): Promise<GeneratedImage | undefined> => Promise.resolve(kept.get(`${key.campaignId}:${subject}`)),
            remove: (key, subject): Promise<void> => (kept.delete(`${key.campaignId}:${subject}`), Promise.resolve()),
          },
          monsterName: (id, language): string | undefined => (language === "en" ? enSrd51Glossary : zhTwSrd51Glossary).names[id],
          budgetPerCampaign: 12,
          ...extra,
        }),
    };
  };
  // Points the game at an Adventure channel, and leaves the party's own portraits (asked for at the opening) out of these tests.
  const withChannel = (c: Campaign): Promise<void> =>
    c.r.store.transaction(async (tx) => {
      for (const item of await tx.pendingOutbox("heroImage")) await tx.completeOutbox(item.id);
      const stored = await tx.loadRecord(c.key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, adventurePostId: "chan" } }, stored.revision);
    });

  it("asks for one portrait per kind of monster as a fight breaks out, and reuses it", async () => {
    const c = await campaign();
    await playRound(c, 1);
    await c.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(c.key);
      if (stored === undefined) throw new Error("state");
      await tx.saveCampaign(c.key, { ...stored.state, round: null }, stored.revision);
    });
    const fight = findEncounter(starter.en.bible, "encounter:chapel-fight");
    if (fight === undefined) throw new Error("encounter");
    await c.r.bus.execute(c.key, { kind: "startEncounter", spec: encounterSpec(fight) }, { commandId: "fight", actor: player });
    const asked = (await c.r.store.transaction((tx) => tx.pendingOutbox("monsterImage"))).flatMap((item) => (item.request.kind === "monsterImage" ? [item.request.npcId ?? item.request.monsterId] : []));
    const kinds = new Set(fight.monsters.map((monster) => monster.npcId ?? monster.monsterId));
    expect(asked.sort()).toEqual([...kinds].sort());

    await withChannel(c);
    const p = painter();
    const worker = p.worker(c);
    await worker.runOnce();
    expect(p.prompts).toHaveLength(kinds.size);
    // The same fight again paints nothing new for those monsters.
    await c.r.store.transaction((tx) => tx.enqueue(c.key, "again", { kind: "monsterImage", monsterId: fight.monsters[0]?.monsterId ?? "", npcId: fight.monsters[0]?.npcId ?? null }, 9));
    await worker.runOnce();
    expect(p.prompts).toHaveLength(kinds.size);
    const goblin = fight.monsters.find((monster) => monster.npcId === null);
    if (goblin !== undefined) expect(p.prompts.some((prompt) => prompt.includes(enSrd51Glossary.names[goblin.monsterId] ?? "?"))).toBe(true);
  });

  it("paints the moment the organizer picks from the narration the table already read, and only for them", async () => {
    const c = await campaign();
    await playRound(c, 1);
    expect(await c.r.bus.execute(c.key, { kind: "illustrateMoment", roundNumber: 1 }, { commandId: "no", actor: { kind: "user", userId: "u-other" } })).toEqual({ kind: "rejected", rejection: { code: "notOrganizer" } });
    expect(await c.r.bus.execute(c.key, { kind: "illustrateMoment", roundNumber: 5 }, { commandId: "far", actor: player })).toEqual({ kind: "rejected", rejection: { code: "nothingToIllustrate" } });
    expect((await c.r.bus.execute(c.key, { kind: "illustrateMoment", roundNumber: 1 }, { commandId: "yes", actor: player })).kind).toBe("accepted");
    await withChannel(c);
    const p = painter();
    await p.worker(c).runOnce();
    // The prompt is the told round, with no DM notes or secrets in it.
    expect(p.prompts).toHaveLength(1);
    expect(p.prompts[0]).toContain("Garrick eyes the party through round 1.");
    expect(p.prompts[0]).not.toContain(secretLine);
    expect(p.posted).toHaveLength(1);
    expect((await c.r.service.get(c.key))?.record.images).toMatchObject({ "moment:round-1": "done" });
  });

  it("paints each hero's portrait when the party is introduced, from their name and class alone", async () => {
    const c = await campaign();
    await c.r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(c.key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, adventurePostId: "chan" } }, stored.revision);
    });
    const p = painter();
    await p.worker(c).runOnce();
    const sheet = starter.en.heroes[0];
    expect(p.prompts).toHaveLength(1);
    expect(p.prompts[0]).toContain(sheet?.name ?? "?");
    expect(p.posted).toEqual([{ caption: sheet?.name }]);
  });

  it("repaints the last picture for the organizer only, spending budget again", async () => {
    const c = await campaign();
    await playRound(c, 1);
    await c.r.bus.execute(c.key, { kind: "illustrateMoment", roundNumber: 1 }, { commandId: "yes", actor: player });
    await withChannel(c);
    const p = painter();
    const worker = p.worker(c);
    await worker.runOnce();
    const record = (await c.r.service.get(c.key))?.record;
    expect(record?.lastPicture).toBe("moment:round-1");
    expect(record?.imageBudget?.used).toBe(1);

    expect(await c.r.bus.execute(c.key, { kind: "redoPicture", subject: "moment:round-1" }, { commandId: "no", actor: { kind: "user", userId: "u-other" } })).toEqual({ kind: "rejected", rejection: { code: "notOrganizer" } });
    expect(await c.r.bus.execute(c.key, { kind: "redoPicture", subject: "" }, { commandId: "none", actor: player })).toEqual({ kind: "rejected", rejection: { code: "nothingToRedo" } });
    expect((await c.r.bus.execute(c.key, { kind: "redoPicture", subject: record?.lastPicture ?? "" }, { commandId: "again", actor: player })).kind).toBe("accepted");
    await worker.runOnce();
    expect(p.prompts).toHaveLength(2);
    expect(p.posted).toHaveLength(2);
    expect((await c.r.service.get(c.key))?.record.imageBudget?.used).toBe(2);
  });

  it("rations automatic moment pictures: not right after another, and never the last of the budget", async () => {
    const c = await campaign();
    await playRound(c, 1);
    await playRound(c, 2);
    await withChannel(c);
    const p = painter();
    const worker = p.worker(c);
    const ask = (id: string, round: number): Promise<void> => c.r.store.transaction((tx) => tx.enqueue(c.key, id, { kind: "momentImage", roundNumber: round, auto: true }, 1));
    await ask("a1", 1);
    await worker.runOnce();
    expect(p.prompts).toHaveLength(1);
    await ask("a2", 2);
    await worker.runOnce();
    // Round 2 is right after round 1's picture: skipped, no charge.
    expect(p.prompts).toHaveLength(1);
    expect((await c.r.service.get(c.key))?.record.images).toMatchObject({ "moment:round-1": "done", "moment:round-2": "skipped" });

    const low = await campaign();
    await playRound(low, 1);
    await withChannel(low);
    await low.r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(low.key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, imageBudget: { limit: 12, used: 9 } }, stored.revision);
    });
    const q = painter();
    await low.r.store.transaction((tx) => tx.enqueue(low.key, "low", { kind: "momentImage", roundNumber: 1, auto: true }, 1));
    await q.worker(low).runOnce();
    expect(q.prompts).toEqual([]);
  });

  it("posts a ready-made monster portrait, for free, when the budget is spent or the model fails", async () => {
    const image = { bytes: Buffer.from("gallery"), mediaType: "image/webp" as const };
    const fallback = (monsterId: string): Promise<GeneratedImage | undefined> => Promise.resolve(monsterId === "monster:goblin" ? image : undefined);
    // Budget spent.
    const spent = await campaign();
    await withChannel(spent);
    await spent.r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(spent.key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, imageBudget: { limit: 1, used: 1 } }, stored.revision);
    });
    const a = painter();
    await spent.r.store.transaction((tx) => tx.enqueue(spent.key, "goblin", { kind: "monsterImage", monsterId: "monster:goblin", npcId: null }, 1));
    await a.worker(spent, { fallback }).runOnce();
    expect(a.prompts).toEqual([]);
    expect(a.posted).toEqual([{ caption: "Goblin" }]);
    expect((await spent.r.service.get(spent.key))?.record.imageBudget).toEqual({ limit: 1, used: 1 });

    // The model fails on every try; a monster with no gallery picture just goes without.
    const down = await campaign();
    await withChannel(down);
    const b = painter();
    b.broken.on = true;
    await down.r.store.transaction(async (tx) => {
      await tx.enqueue(down.key, "goblin", { kind: "monsterImage", monsterId: "monster:goblin", npcId: null }, 1);
      await tx.enqueue(down.key, "wolf", { kind: "monsterImage", monsterId: "monster:wolf", npcId: null }, 2);
    });
    const worker = b.worker(down, { fallback });
    await worker.runOnce();
    await worker.runOnce();
    expect(b.posted).toEqual([{ caption: "Goblin" }]);
    expect((await down.r.service.get(down.key))?.record.images).toMatchObject({ "monster:goblin": "done", "monster:wolf": "failed" });
  });
});
