// Custom ids on settings controls — the admin panel's (prefix "adm") and
// guided setup's ("wiz:<step>"). A registry path ("chat.abilities.web-search")
// and option names contain no ":", so it's a safe separator.
export type ControlAction =
  // Re-render the whole panel.
  | { kind: "refresh" }
  // Toggle button. `value` is what the click sets — not "flip" — so two
  // admins clicking the same stale button can't undo each other.
  | { kind: "toggle"; path: string; option: string; value: boolean }
  // Select menus: a choice, a channel or role, a multi-select list.
  | { kind: "choice"; path: string; option: string }
  | { kind: "channel"; path: string; option: string }
  | { kind: "role"; path: string; option: string }
  | { kind: "list"; path: string; option: string }
  // A node's form: the Edit button (or an action with parameters) opens it;
  // `form` is its submit.
  | { kind: "edit"; path: string }
  | { kind: "form"; path: string }
  // An action's button, and the confirmation for one that asks first.
  | { kind: "run"; path: string }
  | { kind: "confirm"; path: string };

const codes = {
  refresh: "refresh",
  toggle: "t",
  choice: "c",
  channel: "ch",
  role: "r",
  list: "l",
  edit: "e",
  form: "f",
  run: "x",
  confirm: "y",
} as const satisfies Record<ControlAction["kind"], string>;

const kindsByCode = new Map<string, ControlAction["kind"]>(
  Object.entries(codes).map(([kind, code]) => [code, kind as ControlAction["kind"]]),
);

export interface ControlIds {
  encode(action: ControlAction): string;
  // Null for anything that isn't a well-formed id under this prefix.
  parse(customId: string): ControlAction | null;
}

export function controlIds(prefix: string): ControlIds {
  return {
    encode: (action) => [prefix, codes[action.kind], ...partsOf(action)].join(":"),
    parse: (customId) => (customId.startsWith(`${prefix}:`) ? parseBody(customId.slice(prefix.length + 1)) : null),
  };
}

function partsOf(action: ControlAction): string[] {
  switch (action.kind) {
    case "refresh":
      return [];
    case "toggle":
      return [action.path, action.option, action.value ? "1" : "0"];
    case "choice":
    case "channel":
    case "role":
    case "list":
      return [action.path, action.option];
    case "edit":
    case "form":
    case "run":
    case "confirm":
      return [action.path];
  }
}

function parseBody(body: string): ControlAction | null {
  const [code, path, option, value, ...rest] = body.split(":");
  const kind = code === undefined ? undefined : kindsByCode.get(code);
  if (!kind || rest.length > 0) return null;
  switch (kind) {
    case "refresh":
      return path === undefined ? { kind } : null;
    case "toggle":
      return path && option && (value === "1" || value === "0") ? { kind, path, option, value: value === "1" } : null;
    case "choice":
    case "channel":
    case "role":
    case "list":
      return path && option && value === undefined ? { kind, path, option } : null;
    case "edit":
    case "form":
    case "run":
    case "confirm":
      return path && option === undefined ? { kind, path } : null;
  }
}
