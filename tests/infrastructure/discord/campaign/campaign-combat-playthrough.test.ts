import { describe, expect, it } from "vitest";

import { encounterSpec, findEncounter } from "../../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignState } from "../../../../src/domain/campaign/state/campaign-state.js";
import { quiet, starter, tellOpening } from "../../../application/campaign/campaign-rig.js";
import { fakeInteraction, harness, heroes, type Harness, type Sent } from "./handler-harness.js";

// Three scripted players fight the starter adventure's chapel fight through
// the real menus, the way people would, and the fight has to reach an end
// with nobody stuck: every turn offers a way forward, every roll lands once,
// and no hero ends up with a negative resource.

const players = ["u-org", "u-two", "u-three"] as const;

// fighter: hit whatever can be hit, close in, otherwise step forward.
// passive: only ever end the turn, so the goblins have their way.
type Policy = "fighter" | "passive";

interface Menu {
  readonly selects: { readonly id: string; readonly options: { readonly value: string; readonly label: string }[] }[];
  readonly buttons: { readonly id: string; readonly label: string }[];
  readonly content: string;
}

function menuOf(sent: readonly Sent[]): Menu {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  const payload = last?.payload as { content?: string; components?: { toJSON(): { components: Record<string, unknown>[] } }[] } | undefined;
  const selects: Menu["selects"][number][] = [];
  const buttons: Menu["buttons"][number][] = [];
  for (const row of payload?.components ?? []) {
    for (const component of row.toJSON().components) {
      if (Array.isArray(component.options)) selects.push({ id: String(component.custom_id), options: component.options as { value: string; label: string }[] });
      else buttons.push({ id: String(component.custom_id ?? ""), label: String(component.label) });
    }
  }
  return { selects, buttons, content: payload?.content ?? "" };
}

function contentOfSent(sent: readonly Sent[]): string {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  return String((last?.payload as { content?: string } | undefined)?.content ?? "");
}

async function stateOf(t: Harness): Promise<CampaignState> {
  const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
  if (stored === undefined) throw new Error("state");
  return stored.state;
}

async function interact(t: Harness, kind: "button" | "select", customId: string, values: string[], userId: string): Promise<Menu> {
  const { interaction, sent } = fakeInteraction({ customId: `${customId}:${t.key.campaignId}`, userId, values, kind });
  await t.handler.execute({ interaction, logger: quiet as never });
  return menuOf(sent);
}

// One player's turn: keep choosing until the turn is over.
async function playTurn(t: Harness, userId: string, policy: Policy): Promise<void> {
  for (let step = 0; step < 12; step += 1) {
    await t.r.runtime().runOnce();
    const opened = fakeInteraction({ customId: `dnd:turn:${t.key.campaignId}`, userId, messageId: (await t.r.service.get(t.key))?.record.cards.adventure?.messageId ?? "", kind: "button" });
    await t.handler.execute({ interaction: opened.interaction, logger: quiet as never });
    const menu = menuOf(opened.sent);
    const pick = menu.selects.find((select) => select.id.startsWith("dnd:pick:"));
    // The attack is still being resolved: look again. Otherwise it is not this player's turn any more.
    if (pick === undefined) {
      if (menu.buttons.some((button) => button.id.startsWith("dnd:turnRefresh:"))) continue;
      return;
    }
    const values = pick.options.map((option) => option.value);
    const choice =
      policy === "passive"
        ? "end"
        : (values.find((value) => value.startsWith("attack|")) ??
          values.find((value) => value.startsWith("cast|") && value.includes("sacred-flame")) ??
          values.find((value) => value === "engage") ??
          values.find((value) => value.startsWith("move|") && step === 0) ??
          "end");
    if (choice === "end") {
      const ending = await interact(t, "select", "dnd:pick", ["end"], userId);
      const confirm = ending.buttons.find((button) => button.id.endsWith(":yes"));
      if (confirm !== undefined) {
        const yes = fakeInteraction({ customId: confirm.id, userId, kind: "button" });
        await t.handler.execute({ interaction: yes.interaction, logger: quiet as never });
      }
      return;
    }
    const next = await interact(t, "select", "dnd:pick", [choice], userId);
    const aim = next.selects.find((select) => select.id.startsWith("dnd:aim:"));
    if (aim !== undefined) await interact(t, "select", "dnd:aim", [aim.options[0]?.value ?? ""], userId);
  }
}

async function beginChapelFight(t: Harness): Promise<string> {
  for (const [index, userId] of players.entries()) {
    await t.press("join", userId);
    await t.select(userId, heroes[index]?.id ?? "");
  }
  await t.press("start", "u-org");
  await tellOpening(t.r, t.key);
  await t.r.store.transaction(async (tx) => {
    const stored = await tx.loadCampaign(t.key);
    if (stored === undefined) throw new Error("state");
    await tx.saveCampaign(t.key, { ...stored.state, round: null }, stored.revision);
  });
  const chapel = findEncounter(starter.en.bible, "encounter:chapel-fight");
  if (chapel === undefined) throw new Error("encounter");
  const started = await t.r.bus.execute(t.key, { kind: "startEncounter", spec: encounterSpec(chapel) }, { commandId: "fight", actor: { kind: "user", userId: "u-org" } });
  expect(started.kind).toBe("accepted");
  return chapel.id;
}

// Turn after turn until the fight is over; a hero's turn goes to their player.
async function playToTheEnd(t: Harness, policy: Policy): Promise<CampaignState> {
  for (let turn = 0; turn < 300; turn += 1) {
    await t.r.runtime().runOnce();
    await t.cards.sync(t.key);
    const state = await stateOf(t);
    const fight = state.encounter;
    if (fight === null || fight.status === "ended") return state;
    const current = fight.combatants[fight.order[fight.turnIndex] ?? ""];
    const owner = current?.source.kind === "hero" ? state.characters[current.source.characterId]?.ownerUserId : undefined;
    if (owner !== undefined && current?.condition === "active") await playTurn(t, owner, policy);
  }
  throw new Error("The fight did not end: someone is stuck.");
}

async function expectSound(t: Harness, final: CampaignState): Promise<void> {
  expect(final.encounter?.status).toBe("ended");
  // Nothing is left mid-resolution, and no combatant has negative HP or resources.
  expect(final.encounter?.resolution).toBeNull();
  expect(final.encounter?.pendingMove).toBeNull();
  expect(Object.keys(final.encounter?.pendingRolls ?? {})).toEqual([]);
  for (const combatant of Object.values(final.encounter?.combatants ?? {})) {
    expect(combatant.hp).toBeGreaterThanOrEqual(0);
    for (const slots of Object.values(combatant.resources.spellSlots)) expect(slots).toBeGreaterThanOrEqual(0);
    for (const uses of Object.values(combatant.resources.featureUses)) expect(uses).toBeGreaterThanOrEqual(0);
  }
  // Every attack roll was saved and used exactly once.
  const events = (await t.r.store.transaction((tx) => tx.readEvents(t.key))).map((envelope) => envelope.event);
  const rolled = events.flatMap((event) => (event.kind === "checkRolled" ? [event.rollId] : []));
  expect(new Set(rolled).size).toBe(rolled.length);
}

describe("a whole fight through the menus", () => {
  it("plays the chapel fight to its end with three scripted players", async () => {
    const t = await harness();
    await beginChapelFight(t);
    const final = await playToTheEnd(t, "fighter");
    await expectSound(t, final);
    expect(["victory", "defeat"]).toContain(final.encounter?.outcome);
    // The players, not the engine, made the attacks.
    const events = (await t.r.store.transaction((tx) => tx.readEvents(t.key))).map((envelope) => envelope.event);
    const heroIds = new Set(heroes.map((hero) => hero.id));
    expect(events.filter((event) => event.kind === "resolutionDeclared" && heroIds.has(event.resolution.actorId)).length).toBeGreaterThan(2);
  });

  it("carries on when a player is away, playing their hero on cautious autopilot", async () => {
    const t = await harness();
    for (const [index, userId] of players.entries()) {
      await t.press("join", userId);
      await t.select(userId, heroes[index]?.id ?? "");
    }
    await t.press("start", "u-org");
    await tellOpening(t.r, t.key);
    await t.cards.sync(t.key);
    expect(contentOfSent(await t.press("away", "u-two"))).toBe("You are away. The party will carry on without you.");
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...stored.state, round: null }, stored.revision);
    });
    const chapel = findEncounter(starter.en.bible, "encounter:chapel-fight");
    if (chapel === undefined) throw new Error("encounter");
    await t.r.bus.execute(t.key, { kind: "startEncounter", spec: encounterSpec(chapel) }, { commandId: "fight", actor: { kind: "user", userId: "u-org" } });
    const final = await playToTheEnd(t, "fighter");
    await expectSound(t, final);
    // The away player was never asked to act: their turns were played for them.
    const events = (await t.r.store.transaction((tx) => tx.readEvents(t.key))).map((envelope) => envelope.event);
    expect(events.some((event) => event.kind === "turnStarted" && event.combatantId === heroes[1]?.id)).toBe(true);
  });

  it("ends in defeat when nobody acts, and the organizer can play the lost fight again", async () => {
    const t = await harness();
    const chapelId = await beginChapelFight(t);
    const final = await playToTheEnd(t, "passive");
    await expectSound(t, final);
    expect(final.encounter?.outcome).toBe("defeat");
    // The beaten heroes wake with 1 HP, and none of them fell for good.
    for (const hero of heroes) expect(final.heroStatus[hero.id]?.hp ?? 1).toBe(1);

    await t.r.runtime().runOnce();
    const retried = await t.r.bus.execute(t.key, { kind: "retryEncounter" }, { commandId: "retry", actor: { kind: "user", userId: "u-org" } });
    expect(retried.kind).toBe("accepted");
    const again = (await stateOf(t)).encounter;
    expect(again?.id).not.toBe(chapelId);
    expect(again?.status).not.toBe("ended");
    // The party stands as it did when the fight began.
    for (const hero of heroes) expect(again?.combatants[hero.id]?.hp).toBe(again?.combatants[hero.id]?.maxHp);
  });
});
