import { isDeepStrictEqual } from "node:util";

// Something keeping a guild's admin panel from looking after itself, for
// /status to show and the audit log to note.
export type AdminPanelIssue =
  // The bot can't post or edit in the panel channel.
  | { kind: "missing-permissions"; channelId: string; permissions: readonly string[] }
  // The bot can't stop members posting in the panel channel.
  | { kind: "cannot-lock"; channelId: string }
  // Panel messages kept being deleted, so reposting stopped until a repair.
  | { kind: "healing-paused"; channelId: string }
  // The panel channel was deleted, which cleared the setting.
  | { kind: "channel-deleted" };

// Per-guild panel health, in memory: the panel service writes it after
// each redraw, /status reads it. A restart starts clean and the first
// redraw finds any lasting problem again.
export class AdminPanelHealth {
  private readonly issues = new Map<string, readonly AdminPanelIssue[]>();

  public get(guildId: string): readonly AdminPanelIssue[] {
    return this.issues.get(guildId) ?? [];
  }

  // True when this changes what was known, so a caller warns once per
  // change rather than on every redraw.
  public set(guildId: string, issues: readonly AdminPanelIssue[]): boolean {
    if (isDeepStrictEqual(this.get(guildId), issues)) return false;
    if (issues.length === 0) this.issues.delete(guildId);
    else this.issues.set(guildId, issues);
    return true;
  }
}
