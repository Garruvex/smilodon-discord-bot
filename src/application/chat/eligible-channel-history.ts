import type { ChannelHistoryMessage } from "./chat-provider.js";

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
    const allowance = Math.max(0, Math.min(remaining - metadataSize, Math.max(128, share - metadataSize)));
    // JSON escaping can cost more than one character; bound serialized size.
    let content = event.content.slice(0, allowance);
    while (content && JSON.stringify({ ...event, content, contentTruncated: true }).length > Math.min(remaining, Math.max(share, metadataSize + 128))) content = content.slice(0, Math.floor(content.length * 0.9));
    if (event.content && !content) continue;
    const message = { ...event, content, ...(content !== event.content ? { contentTruncated: true } : {}) };
    if (content !== event.content) truncated++;
    selected.push(message); remaining -= JSON.stringify(message).length;
  }
  return { messages: selected.reverse(), countOmitted: unique.length - candidates.length,
    budgetOmitted: candidates.length - selected.length, truncated };
}
