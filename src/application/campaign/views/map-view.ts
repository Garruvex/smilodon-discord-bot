import type { AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import { requirementMet } from "../dm/interactions.js";

// The party's map: where it has been, the ways out it knows of, and nothing
// else. A scene the party has not visited is only ever "???" (never its name),
// and only when a scene it has visited lists it as an exit. Built from public
// facts alone, so the same view can be drawn by any front end.

export type MapNodeState = "current" | "visited" | "unknown";

export interface MapNode {
  readonly id: string;
  // Absent for a place the party has not been to.
  readonly title?: string;
  // What the adventure says about a place not yet visited, in place of "???".
  readonly hint?: string;
  readonly state: MapNodeState;
  // A way out the party cannot take yet (it needs something first).
  readonly locked: boolean;
  // Visited, and every way on from it was a way back: the party can see there is nothing more here.
  readonly deadEnd: boolean;
  // Column and row in the drawn map.
  readonly column: number;
  readonly row: number;
}

export interface MapEdge {
  readonly from: string;
  readonly to: string;
  // The way back is not listed from the other side.
  readonly oneWay: boolean;
}

export interface MapView {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
}

export function buildMapView(state: CampaignState, bible: AdventureBible): MapView {
  const scenes = new Map(bible.scenes.map((scene) => [scene.id as string, scene]));
  const visits = state.visits ?? [];
  const visited = new Set<string>([bible.startScene, ...(state.sceneId === null ? [] : [state.sceneId]), ...visits.map((visit) => visit.sceneId)]);
  const cameFrom = new Map<string, string>();
  const links = new Map<string, { readonly to: string; readonly locked: boolean }>();
  const hints = new Map<string, string>();
  const link = (from: string, to: string, locked: boolean): void => {
    if (from === to) return;
    const key = `${from}>${to}`;
    const known = links.get(key);
    if (known === undefined || (known.locked && !locked)) links.set(key, { to, locked });
  };
  // The way the party actually took, whatever the exits say (a story jump included).
  for (const visit of visits) {
    if (visit.cameFrom !== undefined) {
      link(visit.cameFrom, visit.sceneId, false);
      if (!cameFrom.has(visit.sceneId)) cameFrom.set(visit.sceneId, visit.cameFrom);
    }
  }
  // The ways on that the visited places list.
  for (const id of visited) {
    const scene = scenes.get(id);
    for (const exit of scene?.exits ?? []) {
      // A secret way stays off the map until the party has used it.
      if (exit.hidden === true && !visited.has(exit.to)) continue;
      link(id, exit.to, id === state.sceneId && !requirementMet(exit.requires, state));
      if (exit.hint !== undefined && !hints.has(exit.to)) hints.set(exit.to, exit.hint);
    }
  }

  const known = new Set<string>(visited);
  for (const key of links.keys()) {
    const [from, to] = key.split(">");
    if (from !== undefined && to !== undefined && visited.has(from) && scenes.has(to)) known.add(to);
  }
  const edges = [...links.entries()].flatMap(([key, value]) => {
    const from = key.slice(0, key.indexOf(">"));
    if (!known.has(from) || !known.has(value.to) || !visited.has(from)) return [];
    const there = scenes.get(value.to);
    const oneWay = visited.has(value.to) && there?.exits !== undefined && there.exits.length > 0 && !there.exits.some((back) => back.to === from) && !links.has(`${value.to}>${from}`);
    return [{ from, to: value.to, oneWay }];
  });

  // Columns by distance from the start, rows in the order places were found.
  const layer = new Map<string, number>([[bible.startScene, 0]]);
  const queue = [bible.startScene as string];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const depth = layer.get(next) ?? 0;
    for (const edge of edges) {
      const other = edge.from === next ? edge.to : edge.to === next ? edge.from : undefined;
      if (other !== undefined && !layer.has(other)) {
        layer.set(other, depth + 1);
        queue.push(other);
      }
    }
  }
  const order = [...known].sort((a, b) => (layer.get(a) ?? Infinity) - (layer.get(b) ?? Infinity));
  const rows = new Map<number, number>();
  const nodes = order.map((id): MapNode => {
    const scene = scenes.get(id);
    const column = layer.get(id) ?? Math.max(0, ...layer.values()) + 1;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    const seen = visited.has(id);
    const onward = (scene?.exits ?? []).filter((exit) => exit.to !== cameFrom.get(id));
    return {
      id,
      ...(seen && scene !== undefined ? { title: scene.title } : {}),
      ...(!seen && hints.has(id) ? { hint: hints.get(id) as string } : {}),
      state: id === state.sceneId ? "current" : seen ? "visited" : "unknown",
      locked: !seen && edges.some((edge) => edge.to === id && links.get(`${edge.from}>${id}`)?.locked === true) && !edges.some((edge) => edge.to === id && links.get(`${edge.from}>${id}`)?.locked === false),
      deadEnd: seen && id !== state.sceneId && id !== bible.startScene && scene?.exits !== undefined && onward.length === 0,
      column,
      row,
    };
  });
  return { nodes, edges };
}
