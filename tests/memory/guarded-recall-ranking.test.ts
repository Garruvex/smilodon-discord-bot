import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";
import { DefaultMemoryEngine, defaultMemoryEngineLimits } from "../../src/application/memory/memory-engine.js";
import type { CandidateQuery, RecallCandidates } from "../../src/application/memory/memory.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { fixtureMemoryIngest } from "../helpers/approved-memory-fixture.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

// The repository's candidate order is a storage detail. Recall must rank every eligible candidate
// before the prompt budget applies, so the order here is controlled to put the match last.
class OrderedRepository extends SqliteMemoryRepository {
  public order: readonly string[] = [];
  public override async findRecallCandidates(query: CandidateQuery): Promise<RecallCandidates> {
    const found = await super.findRecallCandidates(query);
    const rank = new Map(this.order.map((statement, index) => [statement, index]));
    return { ...found, memories: [...found.memories].sort((a, b) => (rank.get(a.statement) ?? 1e9) - (rank.get(b.statement) ?? 1e9)) };
  }
}

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
const limits = { ...defaultMemoryEngineLimits, maxStatementChars: 1_000 };
const target = "climbed kilimanjaro last spring";

interface Taught { statement: string; audience?: "guild" | "private"; owner?: string; slot?: string }
interface RecallOptions { embeddings?: EmbeddingsClient; audienceUserId?: string; maxSelectedChars?: number; logger?: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } }

// Guarded recall takes its query from the turn's own message, so the question is part of the setup.
async function setup(taught: readonly Taught[], question = "kilimanjaro?"): Promise<{
  repository: OrderedRepository; fixture: ReturnType<typeof guardedFixture>; sourceOf: Map<string, string>;
  recall: (options?: RecallOptions) => Promise<{ statements: string[]; dependencies: string[] }>;
}> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-recall-ranking-"))); close.push(() => connection.close());
  const repository = new OrderedRepository(connection.database);
  const engine = new DefaultMemoryEngine(repository, null, null, limits, null, null, null, () => true);
  const fixture = guardedFixture(guardedEvent("question", 90_000, question));
  fixture.actors.set("bob", { id: "bob", displayName: "bob", roleNames: [], kind: "human" });
  const sourceOf = new Map<string, string>();
  for (const [index, entry] of taught.entries()) {
    // Each claim cites its own message, so the output proof shows which claims were retained.
    const event = guardedEvent(`taught-${index}`, 1_000 + index, `note ${index}`, entry.owner ?? "alice");
    const teaching = guardedFixture(event); teaching.actors.set("bob", { id: "bob", displayName: "bob", roleNames: [], kind: "human" });
    if (entry.audience === "private") teaching.port.audienceUserId = entry.owner ?? "alice";
    const lease = await GuardedConversationContext.open(teaching.port, { count: 0, budget: 12_000, burstIds: [] });
    const owner = entry.owner ?? "alice";
    const result = await engine.ingest(fixtureMemoryIngest({ guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: owner,
      sourceMessageId: event.messageId, source: "live", now: 2_000 + index, context: lease,
      proposals: [{ action: "upsert", audience: entry.audience ?? "guild", kind: "fact", ownerUserId: entry.audience === "private" ? owner : null,
        subjectType: "member", subjectId: owner, topic: "profile", slot: entry.slot ?? `note.${index}`, statement: entry.statement, channelScoped: true }] }));
    expect(result.ingested).toHaveLength(1);
    fixture.add(event); sourceOf.set(entry.statement, event.messageId);
  }
  repository.order = taught.map((entry) => entry.statement);
  return { repository, fixture, sourceOf, recall: async (options = {}): Promise<{ statements: string[]; dependencies: string[] }> => {
    const recaller = new DefaultMemoryEngine(repository, options.embeddings ?? null, (options.logger ?? null) as never, { ...limits, maxSelectedChars: options.maxSelectedChars ?? limits.maxSelectedChars }, null, null, null, () => true);
    fixture.port.audienceUserId = options.audienceUserId ?? null;
    const lease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12_000, burstIds: [] });
    const result = await recaller.recall({ guildId: "guild", channelId: "channel", userId: "alice", message: question, recentHistory: [],
      subjectIds: ["alice"], now: 100_000, context: lease, requireTopicalMatch: true });
    return { statements: result.memories.map((memory) => memory.statement),
      dependencies: lease.provenance("answer")?.dependencies.map((dependency) => dependency.messageId) ?? [] };
  } };
}

const fillers = (count: number, length = 0): Taught[] => Array.from({ length: count }, (_value, index) => ({
  statement: length ? `owns bicycle ${index} `.padEnd(length, "x") : `owns bicycle ${index}`,
}));

describe("guarded recall ranks before it budgets", () => {
  it("returns the match at the head of the candidates, as before", async () => {
    const { recall } = await setup([{ statement: target }, ...fillers(20)]);
    expect((await recall()).statements).toEqual([target]);
  });

  it("returns the only exact match when twenty other claims come first", async () => {
    const { recall, sourceOf } = await setup([...fillers(20), { statement: target }]);
    const { statements, dependencies } = await recall();
    expect(statements).toEqual([target]);
    // Claims that were not selected add nothing to the reply's proof.
    expect(dependencies).toContain(sourceOf.get(target));
    for (const filler of fillers(20)) expect(dependencies).not.toContain(sourceOf.get(filler.statement));
  });

  it("returns the only exact match after three 1,000-character claims", async () => {
    const { recall } = await setup([...fillers(3, 1_000), { statement: target }]);
    expect((await recall()).statements).toEqual([target]);
  });

  it("still ranks lexically when the embedding call fails", async () => {
    const { recall } = await setup([...fillers(20), { statement: target }]);
    const failing: EmbeddingsClient = { modelId: "test-embeddings", embed: () => Promise.reject(new Error("embedding service down")) };
    expect((await recall({ embeddings: failing })).statements).toEqual([target]);
  });

  it("keeps a revoked match out even when it ranks first", async () => {
    const { recall, fixture, sourceOf } = await setup([{ statement: target }, ...fillers(20)]);
    fixture.denied.add(sourceOf.get(target)!);
    const { statements, dependencies } = await recall();
    expect(statements).toEqual([]);
    expect(dependencies).not.toContain(sourceOf.get(target));
  });

  it("keeps another member's private match out", async () => {
    const { recall } = await setup([{ statement: "bob climbed kilimanjaro", audience: "private", owner: "bob" }, ...fillers(20), { statement: target }]);
    expect((await recall({ audienceUserId: "alice" })).statements).toEqual([target]);
  });

  it("still applies the prompt's count and character limits to what it selects", async () => {
    const many = Array.from({ length: 30 }, (_value, index) => ({ statement: `kilimanjaro trip ${index}` }));
    const { recall } = await setup([...many, ...[0, 1, 2].map((index) => ({ statement: `kilimanjaro story ${index} `.padEnd(1_000, "x") }))]);
    // A large serialized budget, so the lease's own 20-claim and 3,000-character caps are what bind.
    const { statements } = await recall({ maxSelectedChars: 1_000_000 });
    expect(statements).toHaveLength(20);
    expect(statements.reduce((sum, statement) => sum + statement.length, 0)).toBeLessThanOrEqual(3_000);
  });
});

describe("guarded recall checks sources in batches", () => {
  const ports = (fixture: ReturnType<typeof guardedFixture>, revoked = new Set<string>(), forgotten = new Set<string>()): { revoked: number; allowed: number } => {
    const calls = { revoked: 0, allowed: 0 };
    fixture.port.revoked = (ids): Promise<readonly boolean[]> => { calls.revoked++; return Promise.resolve(ids.map((id) => revoked.has(id))); };
    fixture.port.sourcesAllowed = (cited): Promise<readonly boolean[]> => { calls.allowed++; return Promise.resolve(cited.map((item) => !forgotten.has(item.messageId))); };
    return calls;
  };

  it("asks for revocations and cited-source checks a fixed number of times, whatever the candidate count", async () => {
    const small = await setup([...fillers(3), { statement: target }]);
    const smallCalls = ports(small.fixture);
    expect((await small.recall()).statements).toEqual([target]);
    const large = await setup([...fillers(60), { statement: target }]);
    const largeCalls = ports(large.fixture);
    expect((await large.recall()).statements).toEqual([target]);
    expect(largeCalls).toEqual(smallCalls);
    expect(largeCalls.revoked + largeCalls.allowed).toBeLessThanOrEqual(6);
  });

  it("excludes high-scoring rows whose source is revoked or forgotten", async () => {
    const taught = [{ statement: "kilimanjaro summit at dawn" }, { statement: "kilimanjaro base camp" }, ...fillers(20), { statement: target }];
    const { recall, fixture, sourceOf } = await setup(taught);
    ports(fixture, new Set([sourceOf.get("kilimanjaro summit at dawn")!]), new Set([sourceOf.get("kilimanjaro base camp")!]));
    expect((await recall()).statements).toEqual([target]);
  });

  it("fails closed when the batched revocation check fails", async () => {
    const { recall, fixture } = await setup([{ statement: target }, ...fillers(5)]);
    // Only checks that reach the stored claims' sources fail; the turn's own message still checks out.
    fixture.port.revoked = (ids): Promise<readonly boolean[]> => ids.some((id) => id.startsWith("taught-"))
      ? Promise.reject(new Error("database unavailable")) : Promise.resolve(ids.map(() => false));
    expect((await recall()).statements).toEqual([]);
  });
});

describe("guarded recall ranking outcomes", () => {
  it("returns a correction, not the fact it superseded", async () => {
    const { recall } = await setup([{ statement: "lives in paris", slot: "home.city" }, ...fillers(5), { statement: "lives in berlin", slot: "home.city" }], "who lives where?");
    expect((await recall()).statements).toEqual(["lives in berlin"]);
  });

  it("returns nothing for an unrelated query", async () => {
    const { recall } = await setup([...fillers(10), { statement: target }], "quantum chromodynamics?");
    expect((await recall()).statements).toEqual([]);
  });

  it("counts authorization rejections apart from ranking misses", async () => {
    const { recall, fixture, sourceOf } = await setup([{ statement: "kilimanjaro summit at dawn" }, ...fillers(20), { statement: target }]);
    fixture.denied.add(sourceOf.get("kilimanjaro summit at dawn")!);
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect((await recall({ logger })).statements).toEqual([target]);
    const event = logger.info.mock.calls.map(([fields]) => fields as Record<string, unknown>).find((fields) => fields.event === "memory.recall.completed");
    expect(event).toMatchObject({ fetched: 22, bounded: 0, rejectedByAuthorization: 1, missedByRanking: 20, budgeted: 0, retained: 1 });
    expect(JSON.stringify(event)).not.toContain("kilimanjaro");
  });
});
