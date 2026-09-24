// Custom ids on the admin panel's controls. Setting and option names are
// kebab-case, so ":" is a safe separator. Every id starts with the component
// prefix so ComponentRegistry routes it to AdminPanelComponentHandler.
export const adminPanelPrefix = "adm";

export type AdminPanelAction =
  // Header: re-render every message.
  | { kind: "refresh" }
  // Toggle button. `value` is the value the click sets — not "flip" — so two
  // admins clicking the same stale button can't undo each other.
  | { kind: "toggle"; setting: string; option: string; value: boolean }
  // Select menus (string choice, channel, role, multi-select list).
  | SelectAction<"choice">
  | SelectAction<"channel">
  | SelectAction<"role">
  | SelectAction<"list">
  // Edit button (opens the row's modal) and that modal's submit. A setting
  // split across sections (chatbot) has a different modal in each, so these
  // name the section too.
  | ModalAction<"edit">
  | ModalAction<"modal">;

interface SelectAction<Kind extends string> { kind: Kind; setting: string; option: string }
interface ModalAction<Kind extends string> { kind: Kind; section: string; setting: string }

const codes = {
  refresh: "refresh",
  toggle: "t",
  choice: "c",
  channel: "ch",
  role: "r",
  list: "l",
  edit: "e",
  modal: "m",
} as const satisfies Record<AdminPanelAction["kind"], string>;

const kindsByCode = new Map<string, AdminPanelAction["kind"]>(
  Object.entries(codes).map(([kind, code]) => [code, kind as AdminPanelAction["kind"]]),
);

export function encodeAdminPanelId(action: AdminPanelAction): string {
  const code = codes[action.kind];
  switch (action.kind) {
    case "refresh":
      return `${adminPanelPrefix}:${code}`;
    case "edit":
    case "modal":
      return `${adminPanelPrefix}:${code}:${action.section}:${action.setting}`;
    case "toggle":
      return `${adminPanelPrefix}:${code}:${action.setting}:${action.option}:${action.value ? "1" : "0"}`;
    case "choice":
    case "channel":
    case "role":
    case "list":
      return `${adminPanelPrefix}:${code}:${action.setting}:${action.option}`;
  }
}

// Null for anything that isn't a well-formed admin-panel id.
export function parseAdminPanelId(customId: string): AdminPanelAction | null {
  const [prefix, code, setting, option, value, ...rest] = customId.split(":");
  if (prefix !== adminPanelPrefix || rest.length > 0 || code === undefined) return null;
  const kind = kindsByCode.get(code);
  switch (kind) {
    case "refresh":
      return setting === undefined ? { kind } : null;
    case "edit":
    case "modal":
      // Positional: here the third part is the section, the fourth the setting.
      return setting && option && value === undefined ? { kind, section: setting, setting: option } : null;
    case "toggle":
      return setting && option && (value === "1" || value === "0")
        ? { kind, setting, option, value: value === "1" }
        : null;
    case "choice":
    case "channel":
    case "role":
    case "list":
      return setting && option && value === undefined ? { kind, setting, option } : null;
    case undefined:
      return null;
  }
}
