// The campaign ledger (plan §6, layer C): small, entity-keyed facts the
// world remembers. Facts never hold numbers such as HP or counts; those come
// only from live state.
export type LedgerVisibility = "public" | "secret";

export interface LedgerEntry {
  readonly entityId: string;
  // Locked once recorded, so the DM never re-spells or re-translates a name.
  readonly canonicalName: string;
  readonly facts: readonly LedgerFact[];
}

export interface LedgerFact {
  readonly text: string;
  readonly visibility: LedgerVisibility;
}

// "npc:garrick", "item:silver-key": a kind prefix and a slug.
export function isLedgerEntityId(value: string): boolean {
  return /^[a-z]+:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
