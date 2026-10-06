import { describe, expect, it } from "vitest";

import { pickTrapChannelName, trapNoticeContent } from "../../src/infrastructure/discord/security/trap-channel.js";
import { engineFixture, slashValues } from "../helpers/settings-fixtures.js";

const channel = { id: "600000000000000001" };

describe("security settings", () => {
  it("starts off, timing out for 28 days and deleting the last hour", () => {
    expect(engineFixture().profiles.current().security).toEqual({
      trap: { enabled: false, channelId: null, action: "timeout", deleteWindow: "1h", timeout: "28d" },
      exemptRoleIds: [],
      logChannelId: null,
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
