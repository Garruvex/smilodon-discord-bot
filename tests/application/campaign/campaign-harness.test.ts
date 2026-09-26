import { describe, expect, it } from "vitest";

import {
  AdventureDocumentError,
  checkAdventureContent,
  checkEditionsMatch,
  parseAdventureDocument,
} from "../../../src/application/campaign/adventures/adventure-document.js";
import { runHarness, type HarnessOptions } from "../../../src/application/campaign/harness/campaign-harness.js";
import { defaultHarnessPlayers } from "../../../src/application/campaign/harness/harness-personas.js";
import { renderReport, summarizeRun } from "../../../src/application/campaign/harness/harness-report.js";
import { RuleBasedPlanner, TemplateNarrator } from "../../../src/application/campaign/harness/rule-based-dm.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { CampaignLanguage } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import { loadStarterAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";

const starter = loadStarterAdventure();

function options(language: CampaignLanguage, overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  const content = ruleset().content;
  return {
    adventure: starter[language],
    players: defaultHarnessPlayers,
    dm: () => ({ planner: new RuleBasedPlanner(), narrator: new TemplateNarrator() }),
    random: new SeededRandomSource(3),
    rulesets: new RulesetCatalog([content]),
    rulesetPin: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    glossary: language === "en" ? enSrd51Glossary : zhTwSrd51Glossary,
    unitOfWork: new InMemoryCampaignStore(),
    rounds: 6,
    measure: () => 0,
    ...overrides,
  };
}

describe("starter adventure", () => {
  it("loads matching en and zh-TW editions with three preset heroes", () => {
    expect(starter.en.bible.title).toBe("Moonlit Ruins");
    expect(starter["zh-TW"].bible.title).toBe("月光廢墟");
    expect(starter.en.heroes.map((hero) => hero.class)).toEqual(["fighter", "rogue", "cleric"]);
    expect(checkEditionsMatch([starter.en, starter["zh-TW"]])).toEqual([]);
  });

  it("reports every structural problem in a document", () => {
    const source = `
id: broken
version: "1"
language: en
title: Broken
premise: p
dmOverview: o
startScene: scene:missing
scenes:
  - { id: scene:a, title: A, publicDescription: a, dmNotes: n, npcIds: [npc:ghost] }
  - { id: scene:a, title: A2, publicDescription: a, dmNotes: n, npcIds: [] }
npcs: []
heroes:
  - id: c-x
    name: X
    class: fighter
    abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
    proficiencyBonus: 2
    skills: { flying: proficient }
    savingThrows: [str]
    level: 1
    maxHp: 8
    hitDie: 10
    speed: 30
    equipment: [item:mace]
    features: []
`;
    try {
      parseAdventureDocument(source);
      expect.fail("Expected the document to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(AdventureDocumentError);
      expect((error as AdventureDocumentError).problems).toEqual([
        "scene scene:a is defined more than once.",
        "startScene scene:missing is not a scene.",
        "scene:a lists unknown npc:ghost.",
        'c-x has unknown skill "flying".',
      ]);
    }
  });

  it("checks authored encounters against scenes, zones, and NPCs", () => {
    const source = `
id: fights
version: "1"
language: en
title: Fights
premise: p
dmOverview: o
startScene: scene:a
scenes:
  - { id: scene:a, title: A, publicDescription: a, dmNotes: n, npcIds: [] }
npcs: []
encounters:
  - id: encounter:x
    sceneId: scene:b
    publicDescription: p
    dmNotes: n
    zones: [{ id: hall, name: Hall }, { id: hall, name: Hall again }]
    edges: [{ from: hall, to: yard, feet: 20 }]
    partyZoneId: gate
    monsters: [{ monsterId: monster:goblin, zoneId: roof, npcId: npc:boss }]
heroes:
  - id: c-x
    name: X
    class: fighter
    abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
    proficiencyBonus: 2
    skills: {}
    savingThrows: [str]
    level: 1
    maxHp: 8
    hitDie: 10
    speed: 30
    equipment: [item:mace]
    features: []
`;
    expect(() => parseAdventureDocument(source)).toThrow(AdventureDocumentError);
    try {
      parseAdventureDocument(source);
    } catch (error) {
      expect((error as AdventureDocumentError).problems).toEqual([
        "encounter:x is in unknown scene:b.",
        "encounter:x zone hall is defined more than once.",
        "encounter:x starts the party in unknown zone gate.",
        "encounter:x edge hall-yard names an unknown zone.",
        "encounter:x places monster:goblin in unknown zone roof.",
        "encounter:x names unknown npc:boss.",
      ]);
    }
  });

  it("flags editions that disagree on structure", () => {
    const changed = { ...starter["zh-TW"], heroes: starter["zh-TW"].heroes.slice(1) };
    expect(checkEditionsMatch([starter.en, changed])).toEqual(["The zh-TW edition does not match the en edition."]);
  });
});

describe("runHarness", () => {
  it("plays the starter adventure through the real engine in both languages", async () => {
    for (const language of ["en", "zh-TW"] as const) {
      const run = await runHarness(options(language));
      const report = summarizeRun(run);
      expect(report.roundsPlayed).toBe(6);
      expect(report.stoppedBecause).toBe("roundLimit");
      expect(report.checks.total).toBeGreaterThan(0);
      // Round 4 travels to the chapel; round 5 charges Skarn and the fight plays out.
      expect(run.finalState.sceneId).toBe("scene:ruined-chapel");
      expect(report.fights).toHaveLength(1);
      const [fight] = report.fights;
      expect(fight).toMatchObject({ id: "encounter:chapel-fight" });
      expect(["victory", "defeat"]).toContain(fight?.outcome);
      expect(fight?.flourishes).toBe(fight?.rounds);
      expect(report.narration.count).toBe(6 + (fight?.flourishes ?? 0));
      expect(report.leaks).toEqual([]);
      expect(report.simplifiedCharacters).toEqual([]);
      // The injection attempt was refused, not obeyed.
      expect(renderReport(run, report)).toMatch(/\+5 .*→ impossible/);
    }
  });

  it("marks the quiet player away after two silent rounds and brings them back", async () => {
    const run = await runHarness(options("en"));
    const events = run.events.map((envelope) => envelope.event);
    expect(events).toContainEqual({ kind: "memberMarkedAway", userId: "harness-jamie", reason: "missedTimers" });
    expect(events).toContainEqual({ kind: "memberReturned", userId: "harness-jamie" });
    expect(events.some((event) => event.kind === "checkRollStarted" && event.timedOut)).toBe(true);
  });

  it("repeats exactly with the same seed", async () => {
    const first = renderReport(...runAndSummarize(await runHarness(options("en"))));
    const second = renderReport(...runAndSummarize(await runHarness(options("en"))));
    expect(second).toBe(first);
  });

  it("catches a narrator that leaks a secret or drifts into Simplified characters", async () => {
    const secret = starter["zh-TW"].bible.npcs[0]?.secret ?? "";
    const leaky = {
      narrate: (): Promise<{ text: string }> => Promise.resolve({ text: `这是秘密：${secret}` }),
      narrateCombat: (): Promise<{ text: string }> => Promise.resolve({ text: "..." }),
    };
    const report = summarizeRun(await runHarness(options("zh-TW", { dm: () => ({ planner: new RuleBasedPlanner(), narrator: leaky }), rounds: 2 })));
    expect(report.leaks).toEqual([secret]);
    expect(report.simplifiedCharacters).toEqual(["这"]);
  });
});

function runAndSummarize(run: Awaited<ReturnType<typeof runHarness>>): [typeof run, ReturnType<typeof summarizeRun>] {
  return [run, summarizeRun(run)];
}

describe("adventure content check", () => {
  const content = ruleset().content;

  it("accepts the shipped starter adventure in both languages", () => {
    expect(checkAdventureContent(starter.en, content)).toEqual([]);
    expect(checkAdventureContent(starter["zh-TW"], content)).toEqual([]);
  });

  it("reports monsters, items, features, and spells the ruleset lacks or that are the wrong kind", () => {
    const [chapel] = starter.en.bible.encounters.slice(1);
    const [borin] = starter.en.heroes;
    if (chapel === undefined || borin === undefined) throw new Error("fixture changed");
    const broken = {
      bible: {
        ...starter.en.bible,
        encounters: [{ ...chapel, monsters: [{ ...chapel.monsters[0]!, monsterId: "monster:dragon" as const }, { ...chapel.monsters[0]!, monsterId: "item:longsword" as never }] }],
      },
      heroes: [{ ...borin, equipment: ["item:lightsaber" as const], features: ["spell:bless" as never] }],
    };
    expect(checkAdventureContent(broken, content)).toEqual([
      "c-borin uses item:lightsaber, which the ruleset does not have.",
      "c-borin uses spell:bless as a feature, but it is of kind spell.",
      "encounter:chapel-fight uses monster:dragon, which the ruleset does not have.",
      "encounter:chapel-fight uses item:longsword as a monster, but it is of kind item.",
    ]);
  });

  it("stops the harness before play when an adventure needs content the ruleset lacks", async () => {
    const bad = { ...starter.en, heroes: starter.en.heroes.map((hero) => ({ ...hero, equipment: ["item:lightsaber" as const] })) };
    await expect(runHarness(options("en", { adventure: bad }))).rejects.toThrow("item:lightsaber");
  });
});
