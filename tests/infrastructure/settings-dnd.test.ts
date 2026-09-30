import { describe, expect, it, vi } from "vitest";

import type { CampaignServerStatus, CampaignSettingsAccess } from "../../src/infrastructure/discord/campaign/campaign-settings-access.js";
import { engineFixture, guildId, slashValues } from "../helpers/settings-fixtures.js";

const ready: CampaignServerStatus = {
  setUp: true,
  categoryId: "cat",
  hubChannelId: "600000000000000001",
  adminRoleId: "700000000000000001",
  liveGames: 2,
  modelConfigured: true,
};

interface Fake {
  readonly campaign: CampaignSettingsAccess;
  readonly setUp: ReturnType<typeof vi.fn>;
  readonly setAdminRole: ReturnType<typeof vi.fn>;
}

function access(overrides: { status?: CampaignServerStatus; setUp?: unknown; setAdminRole?: boolean } = {}): Fake {
  const setUp = vi.fn(() => Promise.resolve(overrides.setUp ?? { kind: "ok", settings: {} }));
  const setAdminRole = vi.fn(() => Promise.resolve(overrides.setAdminRole ?? true));
  const campaign = { status: () => Promise.resolve(overrides.status ?? ready), setUp, setAdminRole } as unknown as CampaignSettingsAccess;
  return { campaign, setUp, setAdminRole };
}

const messageOf = (result: { kind: string; message?: string }): string => result.message ?? "";

describe("D&D settings", () => {
  it("turns the feature on and off with the first row of the group", async () => {
    const fixture = engineFixture();
    await fixture.run("dnd.campaigns", slashValues({ enabled: true }));
    expect(fixture.profiles.current().features.campaign).toBe(true);
    await fixture.run("dnd.campaigns", slashValues({ enabled: false }));
    expect(fixture.profiles.current().features.campaign).toBe(false);
  });

  it("reports the hub, role, games and model", async () => {
    const fixture = engineFixture({ deps: { campaign: access().campaign } });
    const result = await fixture.run("dnd.status", slashValues({}));
    expect(result.kind === "report" ? result.text : "").toContain("<#600000000000000001>");
    expect(result.kind === "report" ? result.text : "").toContain("<@&700000000000000001>");
    expect(result.kind === "report" ? result.text : "").toContain("Games not finished: 2");
    expect(result.kind === "report" ? result.text : "").toContain("ready");
  });

  it("says so when the server is not set up or the model is missing", async () => {
    const fake = access({ status: { ...ready, setUp: false, hubChannelId: null, adminRoleId: null, modelConfigured: false } });
    const fixture = engineFixture({ deps: { campaign: fake.campaign } });
    const result = await fixture.run("dnd.status", slashValues({}));
    const text = result.kind === "report" ? result.text : "";
    expect(text).toContain("Not set up yet");
    expect(text).toContain("not set");
    expect(text).toContain("not configured");
  });

  it("moves the hub to the chosen channel", async () => {
    const fake = access();
    const fixture = engineFixture({ deps: { campaign: fake.campaign } });
    const result = await fixture.run("dnd.hub-channel", slashValues({ channel: { id: "600000000000000009" } }));
    expect(fake.setUp).toHaveBeenCalledWith(guildId, "600000000000000009");
    expect(result.kind).toBe("done");
    expect(messageOf(result as { kind: string; message?: string })).toContain("<#600000000000000009>");
  });

  it("names the missing permissions instead of moving the hub", async () => {
    const fake = access({ setUp: { kind: "missingPermissions", missing: ["Manage Roles"] } });
    const fixture = engineFixture({ deps: { campaign: fake.campaign } });
    const result = await fixture.run("dnd.hub-channel", slashValues({ channel: { id: "600000000000000009" } }));
    expect(result.kind).toBe("rejected");
    expect(messageOf(result as { kind: string; message?: string })).toContain("Manage Roles");
  });

  it("changes the DnD Admin role, and asks for setup first when there is none", async () => {
    const fake = access();
    const fixture = engineFixture({ deps: { campaign: fake.campaign } });
    const done = await fixture.run("dnd.admin-role", slashValues({ role: { id: "700000000000000009" } }));
    expect(fake.setAdminRole).toHaveBeenCalledWith(guildId, "700000000000000009");
    expect(done.kind).toBe("done");
    expect(messageOf(done as { kind: string; message?: string })).toContain("<@&700000000000000009>");

    const unset = engineFixture({ deps: { campaign: access({ setAdminRole: false }).campaign } });
    const refused = await unset.run("dnd.admin-role", slashValues({ role: { id: "700000000000000009" } }));
    expect(refused.kind).toBe("rejected");
    expect(messageOf(refused as { kind: string; message?: string })).toContain("Set up D&D first");
  });

  it("sets up with a default hub (no channel given), and is unavailable without the campaign module", async () => {
    const fake = access();
    const repaired = await engineFixture({ deps: { campaign: fake.campaign } }).run("dnd.setup", slashValues({}));
    expect(fake.setUp).toHaveBeenCalledWith(guildId, null);
    expect(repaired.kind).toBe("done");

    const missing = await engineFixture().run("dnd.setup", slashValues({}));
    expect(missing).toMatchObject({ kind: "rejected" });
  });
});
