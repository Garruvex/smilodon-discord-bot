import type { PanelMode, PanelView } from "./campaign-views.js";

// Which controls the Adventure panel offers in each state (panel spec, State and
// control matrix), as plain data. The Discord panel draws these as buttons; any
// other front end draws the same list its own way. An action here is a hint for
// rendering: the engine and the click handlers still check every use.

// game: changes the campaign through the command bus. navigation: opens a
// private view and changes nothing. table: stops, pauses or marks presence.
export type PanelActionKind = "game" | "navigation" | "table";

export const panelActionKinds = {
  act: "game",
  speak: "game",
  pass: "game",
  roll: "game",
  ready: "game",
  begin: "game",
  continue: "game",
  turn: "game",
  endTurn: "game",
  stay: "game",
  myHero: "navigation",
  explore: "navigation",
  more: "navigation",
  away: "table",
  safety: "table",
} as const satisfies Readonly<Record<string, PanelActionKind>>;

export type PanelActionId = keyof typeof panelActionKinds;

export const panelActionKind = (action: PanelActionId): PanelActionKind => panelActionKinds[action];

const controlsFor: Readonly<Record<PanelMode, readonly PanelActionId[]>> = {
  opening: ["myHero", "away"],
  readyCheck: ["ready", "begin", "myHero", "away"],
  collecting: ["act", "speak", "pass", "myHero", "away"],
  planning: ["myHero", "away"],
  awaitingRolls: ["roll", "myHero", "away"],
  combat: ["myHero"],
  waiting: ["continue", "away", "myHero"],
  resting: ["continue", "myHero"],
  paused: ["myHero"],
  safety: ["myHero"],
  recovery: ["myHero"],
  archived: [],
};

// A fight the players play: Take turn opens the private turn menu.
const combatControls: readonly PanelActionId[] = ["turn", "endTurn", "speak", "myHero", "away"];

// The second row, in every state until the game is over: the way to stop play
// for a moment, and the help and links.
const safetyControls: readonly PanelActionId[] = ["safety", "more"];

export interface PanelActions {
  // The main controls for the state.
  readonly primary: readonly PanelActionId[];
  // The second row: Explore between fights, then the safety controls, then the
  // away toggle unless the main row already holds it. Empty once the game is over.
  readonly secondary: readonly PanelActionId[];
}

export function panelActions(view: Pick<PanelView, "mode" | "combat" | "pendingMove">): PanelActions {
  // A move proposal owns the next response window. Keep the vote prominent
  // and remove Act, Pass, and Explore until the destination is settled.
  if (view.pendingMove !== undefined && view.mode === "collecting") {
    return { primary: ["stay", "myHero", "away"], secondary: [...safetyControls] };
  }
  const primary = view.mode === "combat" && view.combat?.playersControl === true ? combatControls : controlsFor[view.mode];
  if (view.mode === "archived") return { primary, secondary: [] };
  // Pause, recovery, and safety are read-only modes. In particular, do not
  // leave Explore available here: it opens spells, travel, and other actions.
  // Away and back stays, so a player marked away is never stuck outside a paused table.
  if (view.mode === "paused" || view.mode === "safety" || view.mode === "recovery") return { primary, secondary: ["myHero", "away"] };
  // Resolution permits only the requested roll (plus safety and presence controls).
  if (view.mode === "planning" || view.mode === "awaitingRolls") {
    const toggle: readonly PanelActionId[] = primary.includes("away") ? [] : ["away"];
    return { primary, secondary: [...safetyControls, ...toggle] };
  }
  // Away and back are one toggle, present in every state so a player marked away can always return.
  const toggle: readonly PanelActionId[] = primary.includes("away") ? [] : ["away"];
  // Explore (people, shops, spells) is for between fights.
  const secondary: readonly PanelActionId[] = view.mode === "collecting" ? ["explore", ...safetyControls, ...toggle] : [...safetyControls, ...toggle];
  return { primary, secondary };
}
