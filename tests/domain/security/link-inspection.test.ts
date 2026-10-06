import { describe, expect, it } from "vitest";

import { inspectLinks, parseDomainList, type LinkRules } from "../../../src/domain/security/link-inspection.js";

const rules = (overrides: Partial<LinkRules> = {}): LinkRules => ({
  blockedDomains: [],
  allowedDomains: [],
  suspicious: true,
  invites: false,
  ...overrides,
});

const reasons = (content: string, overrides: Partial<LinkRules> = {}): string[] =>
  inspectLinks(content, rules(overrides)).map((finding) => `${finding.host}:${finding.reason}`);

describe("inspectLinks", () => {
  it("lets ordinary links through", () => {
    expect(reasons("see https://example.com/page and https://github.com/x/y")).toEqual([]);
  });

  it("refuses a blocked site and its subdomains, with or without a scheme", () => {
    const blocked = { blockedDomains: ["evil.com"] };
    expect(reasons("https://evil.com/a", blocked)).toEqual(["evil.com:blocked-domain"]);
    expect(reasons("https://login.evil.com", blocked)).toEqual(["login.evil.com:blocked-domain"]);
    expect(reasons("go to evil.com/claim now", blocked)).toEqual(["evil.com:blocked-domain"]);
    expect(reasons("notevil.com", blocked)).toEqual([]);
  });

  it("lets the allow list win over everything", () => {
    expect(reasons("https://evil.com", { blockedDomains: ["evil.com"], allowedDomains: ["evil.com"] })).toEqual([]);
  });

  describe("lookalikes", () => {
    it.each([
      "https://discord-nitro-free.com/claim",
      "https://dlscord.gift/x",
      "https://disc0rd.com",
      "https://steamcommunlty-trade.com/offer",
      "https://free-nitro.xyz",
    ])("flags %s", (url) => {
      expect(reasons(url)).toHaveLength(1);
    });

    it.each([
      "https://discord.com/channels/1/2",
      "https://discord.gg/abc",
      "https://discord.gift/xyz",
      "https://cdn.discordapp.com/attachments/1/2/a.png",
      "https://discord.js.org/docs",
      "https://store.steampowered.com/app/1",
      "https://steamcommunity.com/id/me",
      "https://example.com/discord-bot-guide",
    ])("leaves %s alone", (url) => {
      expect(reasons(url)).toEqual([]);
    });

    it("doesn't hold a bare word like discord.js to the lookalike rule", () => {
      expect(reasons("I use discord.js and steam.exe")).toEqual([]);
    });

    it("can be turned off", () => {
      expect(reasons("https://discord-nitro-free.com", { suspicious: false })).toEqual([]);
    });
  });

  it("flags raw IP links only when they're real links", () => {
    expect(reasons("http://192.168.0.1/login")).toEqual(["192.168.0.1:ip-address"]);
    expect(reasons("server at 192.168.0.1:27015")).toEqual([]);
  });

  it("flags an address that mixes Latin with Cyrillic, but not a wholly Chinese or Japanese one", () => {
    // The second letter of "discord" below is Cyrillic і (U+0456).
    expect(reasons("https://dіscord.com").map((entry) => entry.split(":")[1])).toEqual(["homoglyph"]);
    expect(reasons("https://例え.jp/x")).toEqual([]);
    expect(reasons("https://中文.com")).toEqual([]);
  });

  describe("invites", () => {
    it("are allowed unless asked about", () => {
      expect(reasons("https://discord.gg/abc")).toEqual([]);
    });

    it("are refused when asked, in every spelling", () => {
      expect(reasons("https://discord.gg/abc", { invites: true })).toEqual(["discord.gg:invite"]);
      expect(reasons("join discord.gg/abc", { invites: true })).toEqual(["discord.gg:invite"]);
      expect(reasons("https://discord.com/invite/abc", { invites: true })).toEqual(["discord.com:invite"]);
    });

    it("can be allowed by name", () => {
      expect(reasons("https://discord.gg/abc", { invites: true, allowedDomains: ["discord.gg"] })).toEqual([]);
    });
  });

  it("strips trailing punctuation from a link", () => {
    expect(reasons("(https://evil.com/x).", { blockedDomains: ["evil.com"] })).toEqual(["evil.com:blocked-domain"]);
  });

  it("reports each host and reason once", () => {
    expect(reasons("https://evil.com https://evil.com/b evil.com", { blockedDomains: ["evil.com"] })).toHaveLength(1);
  });
});

describe("parseDomainList", () => {
  it("normalizes schemes, paths, ports, www and case, and drops repeats", () => {
    expect(parseDomainList("https://www.Evil.com/x, bad.net:8080 evil.com").domains).toEqual(["evil.com", "bad.net"]);
  });

  it("reports what isn't a domain instead of guessing", () => {
    expect(parseDomainList("ok.com, nope, a b").invalid).toEqual(["nope", "a", "b"]);
  });

  it("is empty for empty text", () => {
    expect(parseDomainList("  ").domains).toEqual([]);
  });
});
