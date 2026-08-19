export interface BilibiliLinkMatch {
  readonly originalUrl: string;
  // "video" links already carry a resolvable BV id in the path; "short"
  // links (b23.tv) are opaque redirects that must be resolved over the
  // network before a BV id is known.
  readonly kind: "video" | "short";
  readonly bvid: string | null;
}

const directHostnames = new Set(["bilibili.com"]);
const shortHostnames = new Set(["b23.tv"]);
const bvidPattern = /BV[0-9A-Za-z]{10}/;
const urlPattern = /https?:\/\/\S+/g;

function stripHostPrefix(hostname: string): string {
  return hostname.replace(/^(www|m)\./, "");
}

export function extractBilibiliLinks(content: string): BilibiliLinkMatch[] {
  const matches: BilibiliLinkMatch[] = [];
  const seen = new Set<string>();

  for (const raw of content.match(urlPattern) ?? []) {
    const trimmedUrl = raw.replace(/[)\]>,.!?]+$/, "");
    if (seen.has(trimmedUrl)) continue;

    let url: URL;
    try {
      url = new URL(trimmedUrl);
    } catch {
      continue;
    }

    const host = stripHostPrefix(url.hostname.toLowerCase());
    if (directHostnames.has(host)) {
      const bvid = url.pathname.match(bvidPattern)?.[0] ?? null;
      if (!bvid) continue;
      seen.add(trimmedUrl);
      matches.push({ originalUrl: trimmedUrl, kind: "video", bvid });
    } else if (shortHostnames.has(host)) {
      seen.add(trimmedUrl);
      matches.push({ originalUrl: trimmedUrl, kind: "short", bvid: null });
    }
  }

  return matches;
}
