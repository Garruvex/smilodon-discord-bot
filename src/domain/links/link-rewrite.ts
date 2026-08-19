export interface LinkRewriteMatch {
  readonly platform: string;
  readonly originalUrl: string;
  readonly rewrittenUrl: string;
}

interface LinkRewriteRule {
  readonly platform: string;
  readonly hostnames: ReadonlySet<string>;
  readonly rewriteHostname: string;
}

// Community-run "embed fix" proxies that mirror the original page but serve
// Discord-friendly Open Graph tags (video/image previews, inline players).
// Bilibili has no comparable public proxy, so it's handled separately by
// BilibiliEmbedService, which builds a native Discord embed from Bilibili's
// own API instead of depending on a third-party domain.
const rewriteRules: readonly LinkRewriteRule[] = [
  {
    platform: "Twitter/X",
    hostnames: new Set(["twitter.com", "x.com"]),
    rewriteHostname: "fxtwitter.com",
  },
  {
    platform: "Threads",
    hostnames: new Set(["threads.net", "threads.com"]),
    rewriteHostname: "fixthreads.net",
  },
  {
    platform: "TikTok",
    hostnames: new Set(["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]),
    rewriteHostname: "vxtiktok.com",
  },
  {
    platform: "Instagram",
    hostnames: new Set(["instagram.com"]),
    rewriteHostname: "ddinstagram.com",
  },
  {
    platform: "Reddit",
    hostnames: new Set(["reddit.com"]),
    rewriteHostname: "rxddit.com",
  },
];

const trackingParamPrefixes = ["utm_", "igshid", "si", "spm_id_from"];
const urlPattern = /https?:\/\/\S+/g;

function stripHostPrefix(hostname: string): string {
  return hostname.replace(/^(www|m|mobile)\./, "");
}

function findRule(hostname: string): LinkRewriteRule | undefined {
  const normalized = stripHostPrefix(hostname.toLowerCase());
  return rewriteRules.find((rule) => rule.hostnames.has(normalized));
}

export function extractLinkRewrites(content: string): LinkRewriteMatch[] {
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
    if (!rule) continue;
    seen.add(trimmedUrl);

    url.hostname = rule.rewriteHostname;
    for (const key of [...url.searchParams.keys()]) {
      if (trackingParamPrefixes.some((prefix) => key.startsWith(prefix))) {
        url.searchParams.delete(key);
      }
    }

    matches.push({ platform: rule.platform, originalUrl: trimmedUrl, rewrittenUrl: url.toString() });
  }

  return matches;
}
