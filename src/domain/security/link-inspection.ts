import { domainToUnicode } from "node:url";

// Judging the links in a message without visiting them. Nothing here touches
// the network: a host is refused for what it is called, never for what it
// serves, so a member's links never leave the bot.

export type LinkReason = "blocked-domain" | "lookalike" | "homoglyph" | "ip-address" | "invite";

export interface LinkFinding {
  host: string;
  reason: LinkReason;
}

export interface LinkRules {
  blockedDomains: readonly string[];
  allowedDomains: readonly string[];
  suspicious: boolean;
  invites: boolean;
}

// Domains whose names contain a brand but really belong to it (or to a
// well-known project around it). A host under any of these is never called a
// lookalike.
const officialDomains: Readonly<Record<"discord" | "steam", readonly string[]>> = {
  discord: [
    "discord.com", "discord.gg", "discord.gift", "discord.new", "discord.media", "discord.design",
    "discordapp.com", "discordapp.net", "discordstatus.com", "discord.js.org", "discordjs.guide",
    "discordpy.readthedocs.io",
  ],
  steam: [
    "steampowered.com", "steamcommunity.com", "steamstatic.com", "steamusercontent.com",
    "steam-chat.com", "steamgames.com",
  ],
};

// A brand name next to one of these, on a host that isn't the brand's, is the
// shape of a fake giveaway or login page.
const baitWords = [
  "nitro", "gift", "free", "airdrop", "promo", "giveaway", "claim", "reward", "verify", "login",
  "auth", "trade", "bonus", "partner",
];

const digitLookalikes: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "l": "i" };

const trailingPunctuation = /[.,;:!?)\]>'"]+$/;
const schemeUrl = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const bareInvite = /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/gi;
const bareDomain = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const domainShape = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

export function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function listed(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => matchesDomain(host, domain));
}

function hostOf(raw: string): string | null {
  const text = raw.replace(trailingPunctuation, "");
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function lookalikeBrand(host: string): "discord" | "steam" | null {
  const squeezed = host.replaceAll("-", "").replaceAll(".", "");
  const leet = [...squeezed].map((char) => digitLookalikes[char] ?? char).join("");
  for (const brand of ["discord", "steam"] as const) {
    if (listed(host, officialDomains[brand])) continue;
    const plain = squeezed.includes(brand);
    // "disc0rd": the brand only appears once digits are read as letters.
    const disguised = !plain && leet.includes(brand);
    if (disguised) return brand;
    if (plain && baitWords.some((word) => squeezed.includes(word))) return brand;
  }
  // A fake Nitro page that never names Discord.
  if (squeezed.includes("nitro") && ["free", "gift", "airdrop", "claim", "promo", "giveaway"].some((word) => squeezed.includes(word))) {
    return "discord";
  }
  return null;
}

// Latin letters mixed with Cyrillic or Greek in one name: a host built to look
// like another. A name wholly in Chinese or Japanese is nothing of the sort.
function mixesScripts(host: string): boolean {
  const unicode = domainToUnicode(host);
  if (unicode === host) return false;
  return unicode.split(".").some((label) =>
    /[a-z]/i.test(label) && /[Ͱ-ϿЀ-ӿ]/.test(label));
}

// Every problem with the links in a message, one finding per host and reason.
export function inspectLinks(content: string, rules: LinkRules): LinkFinding[] {
  const findings: LinkFinding[] = [];
  const seen = new Set<string>();
  const add = (host: string, reason: LinkReason): void => {
    const key = `${host}|${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ host, reason });
  };

  const checkHost = (host: string, hasScheme: boolean): void => {
    if (listed(host, rules.allowedDomains)) return;
    if (listed(host, rules.blockedDomains)) add(host, "blocked-domain");
    // Lookalike checks read names, and a bare "discord.js" in a sentence is a
    // name too: only a real link (with a scheme or www) is held to them.
    if (!rules.suspicious || !hasScheme) return;
    if (ipv4.test(host)) add(host, "ip-address");
    else if (mixesScripts(host)) add(host, "homoglyph");
    else if (lookalikeBrand(host)) add(host, "lookalike");
  };

  const covered: string[] = [];
  for (const match of content.matchAll(schemeUrl)) {
    const host = hostOf(match[0]);
    if (!host) continue;
    covered.push(match[0]);
    checkHost(host, true);
  }

  if (rules.invites) {
    for (const match of content.matchAll(bareInvite)) {
      const host = match[0].toLowerCase().startsWith("discord.gg") ? "discord.gg" : "discord.com";
      if (!listed(host, rules.allowedDomains)) add(host, "invite");
    }
  }

  // Links typed without a scheme still turn into links in Discord, so a
  // blocked host is caught there too.
  if (rules.blockedDomains.length > 0) {
    const rest = covered.reduce((text, url) => text.replace(url, " "), content);
    for (const match of rest.matchAll(bareDomain)) {
      const host = match[0].toLowerCase();
      if (listed(host, rules.blockedDomains) && !listed(host, rules.allowedDomains)) add(host, "blocked-domain");
    }
  }
  return findings;
}

export interface DomainListResult {
  domains: string[];
  invalid: string[];
}

// "https://Evil.com/x, www.bad.net" → ["evil.com", "bad.net"]. What can't be a
// domain is reported rather than guessed at.
export function parseDomainList(text: string): DomainListResult {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const entry of text.split(/[\s,;]+/)) {
    if (entry.length === 0) continue;
    const host = entry.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] ?? "";
    if (!domainShape.test(host)) invalid.push(entry);
    else if (!domains.includes(host)) domains.push(host);
  }
  return { domains, invalid };
}
