import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { modelBoundaryInventory } from "../helpers/model-boundary-inventory.js";

const root = path.resolve(__dirname, "../..");
describe("model consumer migration inventory", () => {
  it("requires every added or removed model-capability consumer to update the reviewed migration inventory", () => {
    const expected: unknown = JSON.parse(fs.readFileSync(path.join(root, "docs/model-consumer-inventory-2026-10-21.json"), "utf8"));
    expect(modelBoundaryInventory(root)).toEqual(expected);
  }, 60_000);
});
