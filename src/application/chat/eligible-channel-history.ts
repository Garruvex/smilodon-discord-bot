import type { ChannelHistoryMessage } from "./chat-provider.js";

// Retrieval counts authorized messages, independently of prompt size or age.
export const channelHistoryPolicy = {
  pageSize: 100, maxPages: 3, maxRawMessages: 300, maxOriginFetches: 20,
  maxRevalidationMessages: 600, maxRevalidationPasses: 12,
} as const;

export type HistoryOmission = "excluded" | "ineligible" | "unverifiable_bot" | "duplicate";
export interface HistoryCoverage {
  requested: number; fetched: number; examined: number; eligible: number; pages: number;
  selectedIds: string[];
  status: "filled" | "end" | "scan_cap" | "fetch_failed" | "no_progress" | "ineligible";
  omissions: Record<HistoryOmission, number>;
}

export async function collectEligibleHistory<T extends { id: string }>(input: {
  requested: number; before: string | null; excludeIds: ReadonlySet<string>;
  fetchPage: (before: string | null, limit: number) => Promise<readonly T[]>;
  authorize: (message: T) => Promise<HistoryOmission | null>;
}): Promise<{ messages: T[]; coverage: HistoryCoverage }> {
  const requested = Math.max(0, Math.min(channelHistoryPolicy.maxRawMessages, Math.floor(input.requested)));
  const coverage: HistoryCoverage = { requested, fetched: 0, examined: 0, eligible: 0, pages: 0,
    selectedIds: [], status: "filled", omissions: { excluded: 0, ineligible: 0, unverifiable_bot: 0, duplicate: 0 } };
  const selected: T[] = []; const seen = new Set<string>();
  let cursor = input.before;
  while (selected.length < requested && coverage.pages < channelHistoryPolicy.maxPages) {
    const limit = Math.min(channelHistoryPolicy.pageSize, channelHistoryPolicy.maxRawMessages - coverage.fetched);
    if (limit <= 0) { coverage.status = "scan_cap"; break; }
    let page: readonly T[];
    try { page = (await input.fetchPage(cursor, limit)).slice(0, limit); }
    catch { coverage.status = "fetch_failed"; break; }
    coverage.pages++; coverage.fetched += page.length;
    for (const message of page) {
      coverage.examined++;
      if (seen.has(message.id)) { coverage.omissions.duplicate++; continue; }
      seen.add(message.id);
      if (input.excludeIds.has(message.id)) { coverage.omissions.excluded++; continue; }
      const omission = await input.authorize(message).catch(() => "ineligible" as const);
      if (omission) { coverage.omissions[omission]++; continue; }
      selected.push(message); coverage.eligible++;
      if (selected.length >= requested) break;
    }
    if (selected.length >= requested) { coverage.status = "filled"; break; }
    if (page.length < limit) { coverage.status = "end"; break; }
    const next = page.at(-1)?.id ?? null;
    if (!next || next === cursor) { coverage.status = "no_progress"; break; }
    cursor = next;
    coverage.status = "scan_cap";
  }
  const messages = selected.reverse();
  coverage.selectedIds = messages.map((message) => message.id);
  return { messages, coverage };
}

// Allocate content fairly while preserving identity, timestamp and reply links.
// No derived summary is produced without source provenance/invalidation.
export function budgetEligibleHistory(events: readonly ChannelHistoryMessage[], count: number, budget: number): {
  messages: ChannelHistoryMessage[]; countOmitted: number; budgetOmitted: number; truncated: number;
} {
  const unique = [...new Map(events.map((event) => [event.messageId, event])).values()]
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const candidates = count > 0 ? unique.slice(-Math.floor(count)) : [];
  if (candidates.reduce((total, event) => total + JSON.stringify(event).length, 0) <= budget) return {
    messages: candidates, countOmitted: unique.length - candidates.length, budgetOmitted: 0, truncated: 0,
  };
  const selected: ChannelHistoryMessage[] = []; let remaining = Math.max(0, budget); let truncated = 0;
  const share = Math.floor(remaining / Math.max(1, candidates.length));
  for (const event of [...candidates].reverse()) {
    const metadataSize = JSON.stringify({ ...event, content: "", contentTruncated: true }).length;
    if (metadataSize > remaining) continue;
    const allowance = Math.max(0, Math.min(remaining - metadataSize, Math.max(0, share - metadataSize)));
    // JSON escaping can cost more than one character; bound serialized size.
    let content = event.content.slice(0, allowance);
    while (content && JSON.stringify({ ...event, content, contentTruncated: true }).length > Math.min(remaining, Math.max(share, metadataSize))) content = content.slice(0, Math.floor(content.length * 0.9));
    if (event.content && !content) continue;
    const message = { ...event, content, ...(content !== event.content ? { contentTruncated: true } : {}) };
    if (content !== event.content) truncated++;
    selected.push(message); remaining -= JSON.stringify(message).length;
  }
  return { messages: selected.reverse(), countOmitted: unique.length - candidates.length,
    budgetOmitted: candidates.length - selected.length, truncated };
}
