import type { EncounterState, ZoneEdge, ZoneId } from "./combat-state.js";
import { areEngaged, type CombatantId } from "./combat-state.js";

// The positioning contract (plan §5): zones, not a grid.
export const engagedDistance = 5;
export const sameZoneDistance = 15;
export const engageCost = 10;
export const withdrawCost = 5;

// Shortest path in feet between two zones, or null if unreachable.
export function zoneDistance(edges: readonly ZoneEdge[], from: ZoneId, to: ZoneId): number | null {
  return shortestPath(edges, from, to)?.feet ?? null;
}

// The zones to walk through (excluding the start) and the total cost.
export function shortestPath(
  edges: readonly ZoneEdge[],
  from: ZoneId,
  to: ZoneId,
): { readonly zones: readonly ZoneId[]; readonly feet: number } | null {
  if (from === to) return { zones: [], feet: 0 };
  const distance = new Map<ZoneId, number>([[from, 0]]);
  const previous = new Map<ZoneId, ZoneId>();
  const open = new Set<ZoneId>([from]);
  while (open.size > 0) {
    // Few zones per scene: a linear scan is clearer than a heap.
    let current: ZoneId | null = null;
    for (const zone of open) {
      if (current === null || (distance.get(zone) ?? Infinity) < (distance.get(current) ?? Infinity)) current = zone;
    }
    if (current === null) break;
    open.delete(current);
    if (current === to) break;
    for (const edge of edges) {
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (next === null) continue;
      const candidate = (distance.get(current) ?? Infinity) + edge.feet;
      if (candidate < (distance.get(next) ?? Infinity)) {
        distance.set(next, candidate);
        previous.set(next, current);
        open.add(next);
      }
    }
  }
  const feet = distance.get(to);
  if (feet === undefined) return null;
  const zones: ZoneId[] = [];
  for (let zone: ZoneId | undefined = to; zone !== undefined && zone !== from; zone = previous.get(zone)) zones.unshift(zone);
  return { zones, feet };
}

export function edgeBetween(edges: readonly ZoneEdge[], a: ZoneId, b: ZoneId): ZoneEdge | undefined {
  return edges.find((edge) => (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a));
}

// Distance used for range: engaged 5 ft, same zone 15 ft, otherwise the path.
export function distanceBetween(encounter: EncounterState, a: CombatantId, b: CombatantId): number | null {
  const first = encounter.combatants[a];
  const second = encounter.combatants[b];
  if (first === undefined || second === undefined) return null;
  if (areEngaged(encounter, a, b)) return engagedDistance;
  if (first.zoneId === second.zoneId) return sameZoneDistance;
  return zoneDistance(encounter.edges, first.zoneId, second.zoneId);
}
