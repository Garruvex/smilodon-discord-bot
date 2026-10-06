import type { LinkFixPlatform } from "../../config/guild-configuration.js";

export interface LinkRewriteMatch {
  readonly platform: string;
  readonly originalUrl: string;
  readonly rewrittenUrl: string;
}

interface LinkRewriteRule {
  readonly key: LinkFixPlatform;
  readonly platform: string;
  readonly hostnames: ReadonlySet<string>;
  readonly rewriteHostname: string;
}

// Community-run "embed fix" proxies that mirror the original page but serve
// Discord-friendly Open Graph tags (video/image previews, inline players).
const rewriteRules: readonly LinkRewriteRule[] = [
  {
    key: "twitter",
    platform: "Twitter/X",
    hostnames: new Set(["twitter.com", "x.com"]),
    rewriteHostname: "fxtwitter.com",
  },
  {
    key: "threads",
    platform: "Threads",
    hostnames: new Set(["threads.net", "threads.com"]),
    rewriteHostname: "vxthreads.com",
  },
  {
    key: "tiktok",
    platform: "TikTok",
    hostnames: new Set(["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]),
    rewriteHostname: "tnktok.com",
  },
  {
    key: "instagram",
    platform: "Instagram",
    hostnames: new Set(["instagram.com"]),
    rewriteHostname: "uuinstagram.com",
  },
  {
    key: "reddit",
    platform: "Reddit",
    hostnames: new Set(["reddit.com", "old.reddit.com", "redd.it"]),
    rewriteHostname: "vxreddit.com",
  },
  {
    key: "bilibili",
    platform: "Bilibili",
    hostnames: new Set(["bilibili.com"]),
    rewriteHostname: "vxbilibili.com",
  },
  {
    key: "bilibili",
    platform: "Bilibili",
    hostnames: new Set(["b23.tv"]),
    rewriteHostname: "vxb23.tv",
  },
];

const trackingParams = new Set(["igshid", "si", "spm_id_from"]);
const urlPattern = /https?:\/\/\S+/g;

function stripHostPrefix(hostname: string): string {
  return hostname.replace(/^(www|m|mobile)\./, "");
}

function findRule(hostname: string): LinkRewriteRule | undefined {
  const normalized = stripHostPrefix(hostname.toLowerCase());
  return rewriteRules.find((rule) => rule.hostnames.has(normalized));
}

export function extractLinkRewrites(
  content: string,
  enabledPlatforms: ReadonlySet<LinkFixPlatform>,
): LinkRewriteMatch[] {
  const matches: LinkRewriteMatch[] = [];
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

    const rule = findRule(url.hostname);
    if (!rule || !enabledPlatforms.has(rule.key)) continue;
    seen.add(trimmedUrl);

    url.hostname = rule.rewriteHostname;
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || trackingParams.has(key)) {
        url.searchParams.delete(key);
      }
    }

    matches.push({ platform: rule.platform, originalUrl: trimmedUrl, rewrittenUrl: url.toString() });
  }

  return matches;
}
