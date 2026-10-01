import { describe, expect, it } from "vitest";

import { buildMapView } from "../../../src/application/campaign/views/map-view.js";
import type { AdventureBible, BibleScene } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignState, SceneVisit } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign } from "../../domain/campaign/campaign-fixtures.js";
import { starter } from "./campaign-rig.js";

const scene = (id: string, title: string, exits?: BibleScene["exits"]): BibleScene => ({ id: id as never, title, publicDescription: "", dmNotes: "", npcIds: [], ...(exits === undefined ? {} : { exits }) });
const to = (id: string): { to: never } => ({ to: id as never });

const bible = (scenes: readonly BibleScene[]): AdventureBible => ({ ...starter.en.bible, startScene: scenes[0]?.id as never, scenes });
const at = (sceneId: string, visits: readonly [string, string?][]): CampaignState => ({
  ...newCampaign(),
  sceneId: sceneId as never,
  visits: visits.map(([id, from], index): SceneVisit => ({ id: `visit-${index + 1}`, sceneId: id as never, arrivedRound: index, ...(from === undefined ? {} : { cameFrom: from as never }) })),
});

describe("the party's map", () => {
  const cave = bible([scene("scene:inn", "Inn", [to("scene:road")]), scene("scene:road", "Road", [to("scene:inn"), to("scene:cave"), to("scene:mill")]), scene("scene:cave", "Cave", [to("scene:road")]), scene("scene:mill", "Mill", [to("scene:road")])]);

  it("names the places visited and shows the rest only as unknown exits", () => {
    const view = buildMapView(at("scene:road", [["scene:inn"], ["scene:road", "scene:inn"]]), cave);
    const byId = Object.fromEntries(view.nodes.map((node) => [node.id, node]));
    expect(byId["scene:inn"]).toMatchObject({ title: "Inn", state: "visited" });
    expect(byId["scene:road"]).toMatchObject({ title: "Road", state: "current" });
    expect(byId["scene:cave"]).toMatchObject({ state: "unknown" });
    expect(byId["scene:cave"]?.title).toBeUndefined();
    expect(byId["scene:mill"]?.title).toBeUndefined();
  });

  it("leaves out places no visited scene leads to", () => {
    const far = bible([scene("scene:inn", "Inn", [to("scene:road")]), scene("scene:road", "Road", [to("scene:inn")]), scene("scene:vault", "Vault", [to("scene:road")])]);
    const view = buildMapView(at("scene:inn", [["scene:inn"]]), far);
    expect(view.nodes.map((node) => node.id).sort()).toEqual(["scene:inn", "scene:road"]);
  });

  it("marks a visited place with nothing on from it as a dead end", () => {
    const view = buildMapView(at("scene:road", [["scene:inn"], ["scene:road", "scene:inn"], ["scene:cave", "scene:road"], ["scene:road", "scene:cave"]]), cave);
    expect(view.nodes.find((node) => node.id === "scene:cave")).toMatchObject({ deadEnd: true, state: "visited" });
    expect(view.nodes.find((node) => node.id === "scene:inn")?.deadEnd).toBe(false);
  });

  it("marks an exit with no way back as one way, and a locked exit as locked", () => {
    const oneWay = bible([scene("scene:inn", "Inn", [to("scene:road")]), scene("scene:road", "Road", [to("scene:cave"), { to: "scene:vault", requires: { clues: ["clue:nope"] } }]), scene("scene:cave", "Cave", [to("scene:road")]), scene("scene:vault", "Vault")]);
    const view = buildMapView(at("scene:road", [["scene:inn"], ["scene:road", "scene:inn"]]), oneWay);
    expect(view.edges.find((edge) => edge.from === "scene:inn" && edge.to === "scene:road")?.oneWay).toBe(true);
    expect(view.nodes.find((node) => node.id === "scene:vault")).toMatchObject({ state: "unknown", locked: true });
    expect(view.nodes.find((node) => node.id === "scene:cave")?.locked).toBe(false);
  });

  it("draws the trail for an adventure with no exits, without inventing places", () => {
    const open = bible([scene("scene:inn", "Inn"), scene("scene:road", "Road"), scene("scene:cave", "Cave")]);
    const view = buildMapView(at("scene:road", [["scene:inn"], ["scene:road", "scene:inn"]]), open);
    expect(view.nodes.map((node) => node.id).sort()).toEqual(["scene:inn", "scene:road"]);
    expect(view.edges).toEqual([{ from: "scene:inn", to: "scene:road", oneWay: false }]);
  });

  it("keeps a secret exit off the map until it is used, and shows a hint instead of ??? when the adventure gives one", () => {
    const secret = bible([scene("scene:inn", "Inn", [to("scene:road")]), scene("scene:road", "Road", [{ to: "scene:vault", hidden: true }, { to: "scene:cave", hint: "A dark opening" }]), scene("scene:vault", "Vault", [to("scene:road")]), scene("scene:cave", "Cave", [to("scene:road")])]);
    const before = buildMapView(at("scene:road", [["scene:inn"], ["scene:road", "scene:inn"]]), secret);
    expect(before.nodes.map((node) => node.id)).not.toContain("scene:vault");
    expect(before.nodes.find((node) => node.id === "scene:cave")).toMatchObject({ state: "unknown", hint: "A dark opening" });
    const after = buildMapView(at("scene:vault", [["scene:inn"], ["scene:road", "scene:inn"], ["scene:vault", "scene:road"]]), secret);
    expect(after.nodes.find((node) => node.id === "scene:vault")).toMatchObject({ title: "Vault", state: "current" });
    // A hint never replaces the name of a place already visited.
    expect(after.nodes.find((node) => node.id === "scene:road")?.hint).toBeUndefined();
  });
});
