import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { importEdges, isUpward } from "./system-map.js";

// The engine's systems may depend only on systems below them (docs/dnd-engine-architecture.md
// §3): an upward or sideways import between two systems fails this test. The shared write
// path (state, events, commands, Decision and Rejection: "Kernel") is the one thing every
// system reaches into; it is a deliberate shared vocabulary, but it may not grow, so its
// imports are counted against a ceiling that only goes down.
const baseline = JSON.parse(fs.readFileSync(new URL("./boundary-baseline.json", import.meta.url), "utf8")) as { kernelImports: number };

describe("engine system boundaries", () => {
  const { edges, unassigned } = importEdges();
  const upward = edges.filter(isUpward);
  const kernel = upward.filter((edge) => edge.toSystem === "Kernel");
  const others = upward.filter((edge) => edge.toSystem !== "Kernel").map((edge) => `${edge.fromSystem}:${edge.from} -> ${edge.toSystem}:${edge.to}`).sort();

  it("assigns every file of the campaign domain to a system", () => {
    expect(unassigned).toEqual([]);
  });

  it("has no upward or sideways import between systems", () => {
    expect(others).toEqual([]);
  });

  it("does not let more of the systems reach into the shared write path", () => {
    expect(kernel.length).toBeLessThanOrEqual(baseline.kernelImports);
  });
});
