import { describe, expect, it } from "vitest";

import {
  applyGuildConfigurationUpdate,
  createGuildConfigurationDocument,
} from "../../src/config/guild-configuration-document.js";

function baseDocument(): ReturnType<typeof createGuildConfigurationDocument> {
  return createGuildConfigurationDocument({
    guildId: "123456789012345678",
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    botAdministratorRoleIds: [],
    musicControllerRoleIds: ["234567890123456789"],
    restrictedRoleIds: [],
    controlPanelChannelId: "901234567890123456",
  });
}

describe("applyGuildConfigurationUpdate — channel-context operations", () => {
  it("contextScanAddChannelId adds once and is idempotent on repeat", () => {
    let document = baseDocument();
    document = applyGuildConfigurationUpdate(document, { contextScanAddChannelId: "111111111111111111" });
    document = applyGuildConfigurationUpdate(document, { contextScanAddChannelId: "111111111111111111" });
    expect(document.chat.contextScanChannelIds).toEqual(["111111111111111111"]);
  });

  it("contextDailyAddChannelId adds once and is idempotent on repeat", () => {
    let document = baseDocument();
    document = applyGuildConfigurationUpdate(document, { contextDailyAddChannelId: "111111111111111111" });
    document = applyGuildConfigurationUpdate(document, { contextDailyAddChannelId: "111111111111111111" });
    expect(document.chat.contextDailyChannelIds).toEqual(["111111111111111111"]);
  });

  it("contextDailyRemoveChannelId actually persists the removal (regression: prior merge logic re-added it)", () => {
    let document = baseDocument();
    document = applyGuildConfigurationUpdate(document, { contextDailyAddChannelId: "111111111111111111" });
    document = applyGuildConfigurationUpdate(document, { contextDailyRemoveChannelId: "111111111111111111" });
    expect(document.chat.contextDailyChannelIds).toEqual([]);
  });

  it("contextDailyRemoveChannelId is idempotent when the channel isn't present", () => {
    let document = baseDocument();
    document = applyGuildConfigurationUpdate(document, { contextDailyRemoveChannelId: "111111111111111111" });
    expect(document.chat.contextDailyChannelIds).toEqual([]);
  });

  it("removing from one list leaves the other untouched", () => {
    let document = baseDocument();
    document = applyGuildConfigurationUpdate(document, {
      contextScanAddChannelId: "111111111111111111", contextDailyAddChannelId: "111111111111111111",
    });
    document = applyGuildConfigurationUpdate(document, { contextDailyRemoveChannelId: "111111111111111111" });
    expect(document.chat.contextScanChannelIds).toEqual(["111111111111111111"]);
    expect(document.chat.contextDailyChannelIds).toEqual([]);
  });

  it("contextRemoveChannelId clears a channel from both lists", () => {
    let document = baseDocument();
    document = applyGuildConfigurationUpdate(document, {
      contextScanAddChannelId: "111111111111111111", contextDailyAddChannelId: "111111111111111111",
    });
    document = applyGuildConfigurationUpdate(document, { contextRemoveChannelId: "111111111111111111" });
    expect(document.chat.contextScanChannelIds).toEqual([]);
    expect(document.chat.contextDailyChannelIds).toEqual([]);
  });
});
