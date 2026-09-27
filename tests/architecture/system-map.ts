import fs from "node:fs";
import path from "node:path";

// The systems of the campaign engine and how the files of src/domain/campaign
// belong to them (docs/dnd-engine-architecture.md §3). A system may import
// from systems of lower rank; importing from the same rank (another system) or
// a higher one is a boundary violation. "Kernel" is today's shared write path
// (state, events, commands, Decision): every system reaches into it, which is
// the coupling the migration plan removes, so those imports are counted apart.
export const systemRank = { Core: 0, Content: 1, Character: 2, Effects: 3, Inventory: 4, Magic: 5, Combat: 6, Exploration: 6, Table: 7, Kernel: 8 } as const;
export type System = keyof typeof systemRank;

const rules: readonly (readonly [RegExp, System])[] = [
  [/^core\//, "Core"],
  [/^dice\//, "Core"],
  [/^rules\//, "Content"],
  [/^content\//, "Content"],
  [/^adventure\//, "Content"],
  [/^character\//, "Character"],
  [/^engine\/rest\.ts$/, "Character"],
  [/^engine\/inventory\.ts$/, "Inventory"],
  [/^engine\/potions\.ts$/, "Inventory"],
  [/^engine\/combat\/combat-gear\.ts$/, "Inventory"],
  [/^combat\//, "Combat"],
  [/^engine\/combat\//, "Combat"],
  [/^engine\/(rounds|checks|round-plan)\.ts$/, "Exploration"],
  [/^ledger\//, "Exploration"],
  [/^lobby\//, "Table"],
  [/^engine\/(members|pause|reminders|speech|dm)\.ts$/, "Table"],
  [/^(state|events|commands)\//, "Kernel"],
  [/^engine\/(decide|decision|rejection|engine-request|ids|narration-limits)\.ts$/, "Kernel"],
];

export const domainRoot = "src/domain/campaign";

export function systemOf(relativePath: string): System | null {
  return rules.find(([pattern]) => pattern.test(relativePath))?.[1] ?? null;
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly fromSystem: System;
  readonly toSystem: System;
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

// Every import between two files of the campaign domain, with the systems they belong to.
export function importEdges(): { readonly edges: readonly Edge[]; readonly unassigned: readonly string[] } {
  const edges: Edge[] = [];
  const unassigned = new Set<string>();
  for (const file of sourceFiles(domainRoot)) {
    const from = path.relative(domainRoot, file).replaceAll("\\", "/");
    const fromSystem = systemOf(from);
    if (fromSystem === null) unassigned.add(from);
    for (const match of fs.readFileSync(file, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
      const to = path.relative(domainRoot, path.normalize(path.join(path.dirname(file), (match[1] ?? "").replace(/\.js$/, ".ts")))).replaceAll("\\", "/");
      if (to.startsWith("..")) continue;
      const toSystem = systemOf(to);
      if (toSystem === null) unassigned.add(to);
      if (fromSystem !== null && toSystem !== null && fromSystem !== toSystem) edges.push({ from, to, fromSystem, toSystem });
    }
  }
  return { edges, unassigned: [...unassigned].sort() };
}

// An import that goes up or sideways: a lower system depending on a higher or equal one.
export const isUpward = (edge: Edge): boolean => systemRank[edge.toSystem] >= systemRank[edge.fromSystem];
