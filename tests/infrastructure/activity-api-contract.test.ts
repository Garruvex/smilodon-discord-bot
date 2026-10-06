import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { activityActions, parseActivityAction } from "../../src/infrastructure/activity/activity-api-contract.js";
import { createActivityActionHandler } from "../../src/infrastructure/activity/activity-action-handler.js";
import { activityOpenApi, activityRoutes } from "../../src/infrastructure/activity/activity-openapi.js";
import type { CampaignLobbyService } from "../../src/application/campaign/campaign-lobby-service.js";
import type { CampaignPlayController } from "../../src/application/campaign/campaign-play-controller.js";

describe("Activity API contract", () => {
  it("covers every action dispatched by the server", () => {
    const handler = readFileSync(fileURLToPath(new URL("../../src/infrastructure/activity/activity-action-handler.ts", import.meta.url)), "utf8");
    const cases = [...handler.matchAll(/case "([^"]+)":/g)].map((match) => match[1]).sort();
    expect(Object.keys(activityActions).sort()).toEqual(cases);
  });

  it("covers the game actions emitted by the Activity client", () => {
    const modules = ["actions", "dice", "hero", "level-up", "map", "party", "table-controls", "lobby", "table-lifecycle", "session"];
    const emitted = new Set<string>();
    for (const module of modules) {
      const source = readFileSync(fileURLToPath(new URL(`../../src/activity/${module}.js`, import.meta.url)), "utf8");
      for (const match of source.matchAll(/kind: "([A-Za-z]+)"/g)) if (match[1] !== undefined) emitted.add(match[1]);
    }
    // Management uses /manage; openRoll opens a local dialog.
    for (const local of ["invite", "decide", "remove", "revoke", "presence", "resize", "openRoll"]) emitted.delete(local);
    expect([...emitted].filter((kind) => !Object.hasOwn(activityActions, kind))).toEqual([]);
  });

  it("validates action shapes before dispatch", () => {
    expect(parseActivityAction({ kind: "attack", targetId: "foe", weaponId: "item:sword" })?.kind).toBe("attack");
    expect(parseActivityAction({ kind: "attack", targetId: "foe" })).toBeNull();
    expect(parseActivityAction({ kind: "moveVote", choice: "maybe" })).toBeNull();
    expect(parseActivityAction({ kind: "unknown" })).toBeNull();
  });

  it("documents every listed route and action in OpenAPI", () => {
    const spec = activityOpenApi() as { paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { oneOf?: { title: string }[] } }> } }>> };
    expect(activityRoutes.length).toBeGreaterThan(15);
    for (const route of activityRoutes) expect(spec.paths[route.path]?.[route.method]).toBeDefined();
    const action = spec.paths["/api/activity/games/{campaignId}/action"]?.post;
    const names = action?.requestBody?.content["application/json"]?.schema.oneOf?.map((schema) => schema.title).sort();
    expect(names).toEqual(Object.keys(activityActions).sort());
    const server = readFileSync(fileURLToPath(new URL("../../src/infrastructure/activity/activity-server.ts", import.meta.url)), "utf8");
    const literalApiPaths = [...server.matchAll(/url\.pathname === "(\/api\/activity\/[^"]+)"/g)].map((match) => match[1]);
    for (const path of literalApiPaths) expect(activityRoutes.some((route) => route.path === path)).toBe(true);
  });

  it("accepts an opportunity attack without an unused target field", async () => {
    const combat = vi.fn().mockResolvedValue({ kind: "ok" });
    const onAccepted = vi.fn();
    const handler = createActivityActionHandler({
      lobby: {} as CampaignLobbyService,
      play: { combat } as unknown as CampaignPlayController,
      onAccepted,
    });
    const result = await handler({ guildId: "guild", campaignId: "campaign" }, "user", { kind: "opportunityAttack", accept: true });
    expect(result).toEqual({ kind: "ok" });
    expect(combat).toHaveBeenCalledOnce();
    const build = combat.mock.calls[0]?.[3] as (characterId: string) => unknown;
    expect(build("hero")).toEqual({ kind: "combatOpportunityAttack", combatantId: "hero", take: true });
    expect(onAccepted).toHaveBeenCalledOnce();
    await handler({ guildId: "guild", campaignId: "campaign" }, "user", { kind: "opportunityAttack", accept: "yes" });
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it("dispatches Disengage through the shared combat controller", async () => {
    const combat = vi.fn().mockResolvedValue({ kind: "ok" });
    const handler = createActivityActionHandler({ lobby: {} as CampaignLobbyService, play: { combat } as unknown as CampaignPlayController });
    expect(await handler({ guildId: "guild", campaignId: "campaign" }, "user", { kind: "disengage" })).toEqual({ kind: "ok" });
    const build = combat.mock.calls[0]?.[3] as (characterId: string) => unknown;
    expect(build("hero")).toEqual({ kind: "combatDisengage", combatantId: "hero" });
  });
});
