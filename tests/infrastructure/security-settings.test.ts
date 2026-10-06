import { describe, expect, it } from "vitest";

import { pickTrapChannelName, trapNoticeContent } from "../../src/infrastructure/discord/security/trap-channel.js";
import { engineFixture, slashValues } from "../helpers/settings-fixtures.js";

const channel = { id: "600000000000000001" };

describe("security settings", () => {
  it("starts everything off, with the trap timing out for 28 days", () => {
    const security = engineFixture().profiles.current().security;
    expect(security.trap).toEqual({ enabled: false, channelId: null, action: "timeout", deleteWindow: "1h", timeout: "28d" });
    expect(security.spam).toMatchObject({ enabled: false, channels: 3, window: "1m", action: "timeout" });
    expect(security.links).toMatchObject({ enabled: false, action: "delete", suspicious: true, invites: false, blockedDomains: [] });
    expect(security.raid).toMatchObject({ enabled: false, joins: 10, window: "30s", action: "alert", accountAgeDays: 0 });
    expect(security.exemptRoleIds).toEqual([]);
    expect(security.logChannelId).toBeNull();
  });

  it("changes spam detection's thresholds and response", async () => {
    const fixture = engineFixture();
    await fixture.run("security.spam", slashValues({ enabled: true, channels: 5, window: "5m", action: "kick" }));
    expect(fixture.profiles.current().security.spam).toMatchObject({ enabled: true, channels: 5, window: "5m", action: "kick" });
  });

  it("rejects a spam threshold outside its range", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("security.spam", slashValues({ channels: 1 }));
    expect(result.kind).toBe("rejected");
    expect(fixture.profiles.current().security.spam.channels).toBe(3);
  });

  it("stores blocked and allowed sites as clean domains", async () => {
    const fixture = engineFixture();
    await fixture.run("security.links", slashValues({
      "blocked-domains": "https://www.Evil.com/x, bad.net  evil.com",
      "allowed-domains": "discord.js.org",
    }));
    expect(fixture.profiles.current().security.links).toMatchObject({
      blockedDomains: ["evil.com", "bad.net"],
      allowedDomains: ["discord.js.org"],
    });
  });

  it("refuses something that isn't a site name, and says which", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("security.links", slashValues({ "blocked-domains": "evil.com, not a site!" }));
    expect(result).toEqual({ kind: "rejected", message: "\"not\" isn't a site name. Use names like example.com." });
    expect(fixture.profiles.current().security.links.blockedDomains).toEqual([]);
  });

  it("empties a site list with 'none'", async () => {
    const fixture = engineFixture();
    await fixture.run("security.links", slashValues({ "blocked-domains": "evil.com" }));
    await fixture.run("security.links", slashValues({ "blocked-domains": "none" }));
    expect(fixture.profiles.current().security.links.blockedDomains).toEqual([]);
  });

  it("changes raid protection's threshold, response and account age", async () => {
    const fixture = engineFixture();
    await fixture.run("security.raid", slashValues({ enabled: true, joins: 5, window: "10s", action: "kick", "account-age-days": 7 }));
    expect(fixture.profiles.current().security.raid).toMatchObject({
      enabled: true, joins: 5, window: "10s", action: "kick", accountAgeDays: 7,
    });
  });

  it("won't turn the trap on without a channel", async () => {
    const fixture = engineFixture();
    const refused = await fixture.run("security.trap", slashValues({ enabled: true }));
    const accepted = await fixture.run("security.trap", slashValues({ enabled: true, channel }));

    expect(refused).toEqual({ kind: "rejected", message: "Set a channel (or use create-channel) before turning this on." });
    expect(accepted.kind).toBe("updated");
    expect(fixture.profiles.current().security.trap).toMatchObject({ enabled: true, channelId: channel.id });
  });

  it("won't clear the channel while the trap is on", async () => {
    const fixture = engineFixture();
    await fixture.run("security.trap", slashValues({ enabled: true, channel }));
    const cleared = await fixture.run("security.trap", slashValues({ "clear-channel": true }));

    expect(cleared.kind).toBe("rejected");
    expect(fixture.profiles.current().security.trap.channelId).toBe(channel.id);
  });

  it("changes the action and the sweep window", async () => {
    const fixture = engineFixture();
    await fixture.run("security.trap", slashValues({ action: "ban", "delete-history": "10m", "timeout-duration": "7d" }));

    expect(fixture.profiles.current().security.trap).toMatchObject({ action: "ban", deleteWindow: "10m", timeout: "7d" });
  });
});

describe("trap channel", () => {
  it("picks an ordinary name that isn't taken", () => {
    const taken = new Set(["general-2", "general-chat"]);
    for (let i = 0; i < 50; i += 1) expect(taken.has(pickTrapChannelName(taken))).toBe(false);
  });

  it("still returns a usable name when every plain one is taken", () => {
    const all = new Set(["general-2", "general-chat", "general-talk", "general-lounge", "main-chat", "chat-2"]);
    expect(pickTrapChannelName(all)).toMatch(/^[a-z0-9-]+-\d{3}$/);
  });

  it("posts the notice in every supported language", () => {
    const notice = trapNoticeContent();
    expect(notice).toContain("Please don't post in this channel");
    expect(notice).toContain("請不要在這個頻道發言");
    expect(notice).toContain("このチャンネルには投稿しないでください");
    expect(notice.length).toBeLessThan(2_000);
  });
});
