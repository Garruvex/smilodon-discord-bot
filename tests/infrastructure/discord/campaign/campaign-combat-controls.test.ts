import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../../src/domain/campaign/state/campaign-state.js";
import { quiet } from "../../../application/campaign/campaign-rig.js";
import { contentOf, fakeInteraction, harness, heroes, started, type Harness, type Sent } from "./handler-harness.js";

// One goblin in the party's own zone, so a hero can close in and hit it.
const scrap: EncounterSpec = {
  id: "enc-scrap",
  zones: [
    { id: "yard", name: "Yard" },
    { id: "gate", name: "Gate" },
  ],
  edges: [{ from: "yard", to: "gate", feet: 10 }],
  partyZoneId: "yard",
  monsters: [{ monsterId: "monster:goblin", zoneId: "yard", npcId: null, fleeBelowHpFraction: null }],
};

interface MenuShape {
  readonly selects: { readonly id: string; readonly options: { readonly value: string; readonly label: string }[]; readonly max: number }[];
  readonly buttons: { readonly id: string; readonly label: string }[];
}

function menuOf(sent: readonly Sent[]): MenuShape {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  const rows = ((last?.payload as { components?: { toJSON(): { components: Record<string, unknown>[] } }[] } | undefined)?.components ?? []).map((row) => row.toJSON().components);
  const selects: MenuShape["selects"][number][] = [];
  const buttons: MenuShape["buttons"][number][] = [];
  for (const component of rows.flat()) {
    if (Array.isArray(component.options)) {
      selects.push({ id: String(component.custom_id), options: component.options as { value: string; label: string }[], max: Number(component.max_values ?? 1) });
    } else buttons.push({ id: String(component.custom_id), label: String(component.label) });
  }
  return { selects, buttons };
}

const stateOf = async (t: Harness): Promise<CampaignState> => {
  const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
  if (stored === undefined) throw new Error("state");
  return stored.state;
};

// The game is running, the round is over, and the goblin scrap has begun; the
// engine has rolled initiative and any goblin turn before the hero's.
async function fighting(): Promise<Harness> {
  const t = await harness();
  await started(t);
  await t.r.store.transaction(async (tx) => {
    const stored = await tx.loadCampaign(t.key);
    if (stored === undefined) throw new Error("state");
    await tx.saveCampaign(t.key, { ...stored.state, round: null }, stored.revision);
  });
  const outcome = await t.r.bus.execute(t.key, { kind: "startEncounter", spec: scrap }, { commandId: "fight", actor: { kind: "user", userId: "u-org" } });
  if (outcome.kind !== "accepted") throw new Error("encounter");
  await t.r.runtime().runOnce();
  await t.cards.sync(t.key);
  return t;
}

async function interact(t: Harness, kind: "button" | "select", customId: string, values: string[] = [], userId = "u-org"): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId: `${customId}:${t.key.campaignId}`, userId, values, kind });
  await t.handler.execute({ interaction, logger: quiet as never });
  return sent;
}

describe("combat turn controls", () => {
  it("shows the panel Take turn and End turn buttons in a fight the players play", async () => {
    const t = await fighting();
    await t.cards.sync(t.key);
    const panel = t.messages.live("chan-adventure").at(-1);
    expect(JSON.stringify((panel?.payload as { components: { toJSON(): unknown }[] }).components.map((component) => component.toJSON()))).toContain("dnd:turn:");
  });

  it("opens a private turn menu with only legal actions, and asks for a target next", async () => {
    const t = await fighting();
    const hero = heroes[0]?.id ?? "";
    expect((await stateOf(t)).encounter?.order[(await stateOf(t)).encounter?.turnIndex ?? 0]).toBe(hero);

    const sent = await t.press("turn", "u-org");
    const menu = menuOf(sent);
    expect(contentOf(sent)).toContain("Action ✅");
    expect(contentOf(sent)).toContain("What do you do?");
    const values = menu.selects[0]?.options.map((option) => option.value) ?? [];
    // Nothing is in melee reach yet, so there is no Attack, but the hero can close in.
    expect(values).toContain("engage");
    expect(values).toContain("dodge");
    expect(values).toContain("move|gate");
    expect(values.some((value) => value.startsWith("attack|"))).toBe(false);
    expect(values.at(-1)).toBe("end");

    const picked = menuOf(await interact(t, "select", "dnd:pick", ["engage"]));
    expect(picked.selects[0]?.id).toBe(`dnd:aim:${t.key.campaignId}`);
    expect(picked.selects[0]?.options.map((option) => option.value)).toEqual(["engage>goblin"]);
  });

  it("closes in and attacks: the engine spends the turn once and the menu follows", async () => {
    const t = await fighting();
    const engaged = await interact(t, "select", "dnd:aim", ["engage>goblin"]);
    expect(contentOf(engaged)).toContain("Done.");
    expect((await stateOf(t)).encounter?.engagements).toEqual([[heroes[0]?.id, "goblin"]]);

    const menu = menuOf(await t.press("turn", "u-org"));
    const attack = menu.selects[0]?.options.find((option) => option.value.startsWith("attack|"));
    expect(attack?.label).toMatch(/^Attack with .* \(\+\d+, /);
    const aimed = menuOf(await interact(t, "select", "dnd:pick", [attack?.value ?? ""]));
    expect(aimed.selects[0]?.options[0]?.label).toMatch(/^Goblin · Yard, unhurt$/);

    const before = (await stateOf(t)).encounter?.sequence ?? 0;
    await interact(t, "select", "dnd:aim", [aimed.selects[0]?.options[0]?.value ?? ""]);
    await t.r.runtime().runOnce();
    expect(((await stateOf(t)).encounter?.sequence ?? 0)).toBeGreaterThan(before);
    // The action is spent: the menu no longer offers an attack.
    const after = menuOf(await t.press("turn", "u-org"));
    expect(after.selects[0]?.options.some((option) => option.value.startsWith("attack|"))).toBe(false);
  });

  it("asks before ending a turn with an action left, then ends it", async () => {
    const t = await fighting();
    const turnBefore = (await stateOf(t)).encounter?.turnNumber ?? 0;
    const confirm = await t.press("endTurn", "u-org");
    expect(contentOf(confirm)).toContain("End your turn anyway?");
    expect(menuOf(confirm).buttons.map((button) => button.id)).toEqual([`dnd:endTurn:${t.key.campaignId}:yes`, `dnd:turnRefresh:${t.key.campaignId}`]);
    expect((await stateOf(t)).encounter?.turnNumber).toBe(turnBefore);

    const yes = fakeInteraction({ customId: `dnd:endTurn:${t.key.campaignId}:yes`, userId: "u-org", kind: "button" });
    await t.handler.execute({ interaction: yes.interaction, logger: quiet as never });
    expect(contentOf(yes.sent)).toBe("You ended your turn.");
    expect((await stateOf(t)).encounter?.turnNumber).toBeGreaterThan(turnBefore);
  });

  it("refuses a stale or forged choice privately and explains when it is not your turn", async () => {
    const t = await fighting();
    expect(contentOf(await interact(t, "select", "dnd:pick", ["attack|not-an-item"]))).toContain("That is not possible right now.");
    expect(contentOf(await interact(t, "select", "dnd:aim", ["move|gate>x>y"]))).not.toBe("");
    // A stranger has no hero here.
    expect(contentOf(await t.press("turn", "u-stranger"))).toBe("You do not have a hero in this campaign.");
    // An action the engine refuses shows its reason above a fresh menu.
    const refused = await interact(t, "select", "dnd:aim", ["attack|item:shortbow>goblin"]);
    expect(contentOf(refused)).toContain("You do not carry that weapon.");
  });

  it("says so when there is no fight", async () => {
    const t = await harness();
    await started(t);
    expect(contentOf(await t.press("turn", "u-org"))).toBe("There is no fight right now.");
  });
});
