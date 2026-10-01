import { describe, expect, it } from "vitest";

import type { MapView } from "../../../../src/application/campaign/views/map-view.js";
import { renderMapImage } from "../../../../src/infrastructure/discord/campaign/map-image.js";

const labels = { unknown: "???", here: "You are here", deadEnd: "Dead end", locked: "Locked" };
const node = (id: string, state: "current" | "visited" | "unknown", column: number, row = 0): MapView["nodes"][number] => ({ id, ...(state === "unknown" ? {} : { title: id }), state, locked: false, deadEnd: false, column, row });

describe("the map picture", () => {
  it("draws a PNG, named after what it shows so an unchanged map is the same file", () => {
    const view: MapView = { nodes: [node("Inn", "visited", 0), node("Road", "current", 1), node("?", "unknown", 2)], edges: [{ from: "Inn", to: "Road", oneWay: true }, { from: "Road", to: "?", oneWay: false }] };
    const first = renderMapImage(view, labels);
    expect(first?.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(first?.name).toMatch(/^map-[0-9a-f]{12}\.png$/);
    expect(renderMapImage(view, labels)?.name).toBe(first?.name);
    expect(renderMapImage({ ...view, nodes: [node("Inn", "current", 0), ...view.nodes.slice(1)] }, labels)?.name).not.toBe(first?.name);
  });

  it("draws nothing for an empty map", () => {
    expect(renderMapImage({ nodes: [], edges: [] }, labels)).toBeUndefined();
  });
});
