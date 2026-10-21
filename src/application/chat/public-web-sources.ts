import { isIP } from "node:net";
import type { ChatSource } from "./chat-provider.js";

// Native search runs at the configured provider, without Discord credentials.
// Citations are display metadata, never permission to fetch a private source.
export function publicWebSources(sources: readonly ChatSource[]): ChatSource[] {
  const selected = new Map<string, ChatSource>();
  for (const source of sources.slice(0, 20)) {
    try {
      if (source.url.length > 2048) continue;
      const url = new URL(source.url);
      const host = url.hostname.toLowerCase().replace(/\.$/u, "");
      if (!/^https?:$/u.test(url.protocol) || url.username || url.password || isIP(host.replace(/^\[|\]$/gu, "")) ||
          !host.includes(".") || /\.(?:localhost|local|internal|test|invalid)$/u.test(host) ||
          /(?:^|\.)(?:discord\.com|discordapp\.com)$/u.test(host) && url.pathname.startsWith("/channels/")) continue;
      selected.set(url.href, { url: url.href, title: source.title.slice(0, 300) });
      if (selected.size === 5) break;
    } catch { /* Invalid citation metadata is not a usable public source. */ }
  }
  return [...selected.values()];
}
