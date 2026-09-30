import { describe, expect, it } from "vitest";

import { CampaignIssues } from "../../../src/application/campaign/campaign-issues.js";
import type { CampaignIssue, CampaignRecord } from "../../../src/application/campaign/ports/campaign-record.js";
import { rig, startedCampaign } from "./campaign-rig.js";

async function setup(): Promise<{ r: ReturnType<typeof rig>; issues: CampaignIssues; told: string[]; key: Awaited<ReturnType<typeof startedCampaign>>; failNotify: { on: boolean } }> {
  const r = rig();
  const key = await startedCampaign(r);
  const told: string[] = [];
  const failNotify = { on: false };
  const issues = new CampaignIssues({
    unitOfWork: r.store,
    clock: r.clock,
    notify: (_record: CampaignRecord, issue: CampaignIssue): Promise<void> => {
      if (failNotify.on) return Promise.reject(new Error("no channel"));
      told.push(`${issue.code}:${issue.detail}`);
      return Promise.resolve();
    },
  });
  return { r, issues, told, key, failNotify };
}

const recordOf = async (r: ReturnType<typeof rig>, key: Awaited<ReturnType<typeof startedCampaign>>): Promise<CampaignRecord> => {
  const stored = await r.store.transaction((tx) => tx.loadRecord(key));
  if (stored === undefined) throw new Error("record");
  return stored.record;
};

describe("organizer issues", () => {
  it("writes an issue on the record and tells the organizer once, however often it comes back", async () => {
    const { r, issues, told, key } = await setup();
    await issues.raise(key, "permissions", "party");
    await issues.raise(key, "permissions", "party");
    await issues.raise(key, "permissions", "party, adventure");
    expect(told).toEqual(["permissions:party"]);
    const record = await recordOf(r, key);
    expect(record.issues).toEqual([{ code: "permissions", detail: "party, adventure", since: r.clock.now(), notified: true }]);
    // A different kind of problem is its own entry.
    await issues.raise(key, "deliveryFailed", "narration");
    expect((await recordOf(r, key)).issues?.map((issue) => issue.code)).toEqual(["permissions", "deliveryFailed"]);
  });

  it("keeps an issue nobody could be told about, and tells them the next time it comes up", async () => {
    const { r, issues, told, key, failNotify } = await setup();
    failNotify.on = true;
    await issues.raise(key, "channelMissing", "partyChannel");
    expect((await recordOf(r, key)).issues).toMatchObject([{ code: "channelMissing", notified: false }]);
    failNotify.on = false;
    await issues.raise(key, "channelMissing", "partyChannel");
    expect(told).toEqual(["channelMissing:partyChannel"]);
    expect((await recordOf(r, key)).issues).toMatchObject([{ notified: true }]);
  });

  it("clears the kinds that were fixed and leaves the others", async () => {
    const { r, issues, key } = await setup();
    await issues.raise(key, "permissions", "party");
    await issues.raise(key, "deliveryFailed", "narration");
    await issues.clear(key, ["permissions", "cardsFailed"]);
    expect((await recordOf(r, key)).issues?.map((issue) => issue.code)).toEqual(["deliveryFailed"]);
    await issues.clear(key, ["permissions"]);
    expect((await recordOf(r, key)).issues?.map((issue) => issue.code)).toEqual(["deliveryFailed"]);
  });

  it("records nothing for a finished game", async () => {
    const { r, issues, told, key } = await setup();
    await r.service.end(key);
    await issues.raise(key, "permissions", "party");
    expect((await recordOf(r, key)).issues ?? []).toEqual([]);
    expect(told).toEqual([]);
  });
});
