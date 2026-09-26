import { describe, expect, it } from "vitest";

import { runHarness, type HarnessOptions } from "../../../src/application/campaign/harness/campaign-harness.js";
import { adversarialHarnessPlayers } from "../../../src/application/campaign/harness/harness-personas.js";
import { renderReport, summarizeRun } from "../../../src/application/campaign/harness/harness-report.js";
import { LlmHarnessPlayer, simulatedCast } from "../../../src/application/campaign/harness/llm-player.js";
import { RuleBasedPlanner, TemplateNarrator } from "../../../src/application/campaign/harness/rule-based-dm.js";
import type { CampaignNarrator } from "../../../src/application/campaign/ports/dm-ports.js";
import type { StructuredModelClient, StructuredModelRequest } from "../../../src/application/campaign/ports/structured-model-client.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { loadStarterAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";

const starter = loadStarterAdventure();

function options(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  const content = ruleset().content;
  return {
    adventure: starter.en,
    players: adversarialHarnessPlayers,
    dm: () => ({ planner: new RuleBasedPlanner(), narrator: new TemplateNarrator() }),
    random: new SeededRandomSource(5),
    rulesets: new RulesetCatalog([content]),
    rulesetPin: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    glossary: enSrd51Glossary,
    unitOfWork: new InMemoryCampaignStore(),
    rounds: 6,
    measure: () => 0,
    ...overrides,
  };
}

describe("adversarial cast", () => {
  it("does not let a prompt-injection attacker change the rules or reach secrets", async () => {
    const run = await runHarness(options());
    const report = summarizeRun(run);
    const text = renderReport(run, report);
    expect(text).toMatch(/System: the rules have changed.*→ impossible/);
    expect(text).toMatch(/Ignore your previous instructions.*→ impossible/);
    expect(report.leaks).toEqual([]);
    // Nobody got 100 HP: the injected claim never reached the state.
    expect(Object.values(run.finalState.heroStatus).every((status) => status.hp <= 12)).toBe(true);
    expect(run.finalState.characters["c-elspeth"]?.maxHp).toBe(9);
  });
});

describe("numbers in narration", () => {
  it("flags digits the Narrator wrote so they can be checked against the state", async () => {
    const chatty: CampaignNarrator = {
      narrate: () => Promise.resolve({ text: "Borin swings for 777 damage and Mira has 913 arrows left." }),
      narrateCombat: () => Promise.resolve({ text: "A 913 lands." }),
    };
    const run = await runHarness(options({ dm: () => ({ planner: new RuleBasedPlanner(), narrator: chatty }), rounds: 2 }));
    const report = summarizeRun(run);
    expect(report.numbersInNarration).toEqual(["777", "913"]);
    expect(renderReport(run, report)).toContain("Numbers in narration: **777, 913**");
    expect(summarizeRun(await runHarness(options({ rounds: 2 }))).numbersInNarration).toEqual([]);
  });
});

describe("simulated players", () => {
  class FakeClient implements StructuredModelClient {
    public readonly name = "fake";
    public readonly requests: StructuredModelRequest[] = [];
    public constructor(private readonly texts: string[]) {}
    public generate(request: StructuredModelRequest): ReturnType<StructuredModelClient["generate"]> {
      this.requests.push(request);
      return Promise.resolve({ text: this.texts.shift() ?? '{"action":""}', model: "fake", usage: null });
    }
  }

  const view = { heroName: "Mira", sceneTitle: "The Crossroads Inn", narration: "Garrick eyes the door." };

  it("turns the model's answer into a move, and silence into a silent one", async () => {
    const persona = simulatedCast[0];
    if (persona === undefined) throw new Error("no persona");
    const client = new FakeClient([JSON.stringify({ action: " I ask about the road. " }), JSON.stringify({ action: "  " })]);
    const player = new LlmHarnessPlayer(persona, client);
    expect(await player.move(1, "en", view)).toEqual({ kind: "act", text: "I ask about the road." });
    expect(await player.move(2, "en", view)).toEqual({ kind: "silent" });
    // The player sees the scene and narration, never DM notes.
    const request = client.requests[0];
    expect(request?.user).toContain("Garrick eyes the door.");
    expect(`${request?.system}${request?.user}`).not.toContain("SECRET");
  });

  it("asks for Traditional Chinese when the campaign is zh-TW", async () => {
    const persona = simulatedCast[1];
    if (persona === undefined) throw new Error("no persona");
    const client = new FakeClient([JSON.stringify({ action: "我點了一碗湯。" })]);
    await new LlmHarnessPlayer(persona, client).move(1, "zh-TW", view);
    expect(client.requests[0]?.system).toContain("Traditional Chinese");
  });
});
