import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { importEdges, isUpward } from "./system-map.js";

// A ratchet (docs/dnd-engine-architecture.md §3, §10 step 1): the boundary
// violations that exist today are listed in a baseline and may only shrink.
// A new upward or sideways import between systems fails the test; removing one
// asks for the baseline entry to be deleted. Imports of the shared write path
// (state, events, commands, Decision) are counted, and the count may not grow.
const baselineFile = new URL("./boundary-baseline.json", import.meta.url);
const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")) as { violations: string[]; kernelImports: number };

describe("engine system boundaries", () => {
  const { edges, unassigned } = importEdges();
  const upward = edges.filter(isUpward);
  const key = (edge: (typeof edges)[number]): string => `${edge.fromSystem}:${edge.from} -> ${edge.toSystem}:${edge.to}`;
  const kernel = upward.filter((edge) => edge.toSystem === "Kernel");
  const others = upward.filter((edge) => edge.toSystem !== "Kernel").map(key).sort();

  it("assigns every file of the campaign domain to a system", () => {
    expect(unassigned).toEqual([]);
  });

  it("adds no upward or sideways import between systems", () => {
    expect(others.filter((violation) => !baseline.violations.includes(violation))).toEqual([]);
  });

  it("asks for a fixed violation to be removed from the baseline", () => {
    expect(baseline.violations.filter((violation) => !others.includes(violation))).toEqual([]);
  });

  it("does not let more of the systems reach into the shared write path", () => {
    expect(kernel.length).toBeLessThanOrEqual(baseline.kernelImports);
  });
});
