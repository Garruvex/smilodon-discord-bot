// Child process for the restart tests: starts a transaction, writes a roll
// and a campaign update, then dies hard (SIGKILL) before it can commit.
import Database from "better-sqlite3";

import { SqliteCampaignStore } from "../../src/infrastructure/persistence/campaign/sqlite-campaign-store.js";

const path = process.argv[2];
if (path === undefined) throw new Error("A database path is required.");
const key = { guildId: "g-1", campaignId: "camp-1" };
const store = new SqliteCampaignStore(new Database(path));
await store.transaction(async (tx) => {
  const loaded = await tx.loadCampaign(key);
  if (loaded === undefined) throw new Error("The campaign is missing.");
  await tx.saveCampaign(key, { ...loaded.state, lastRoundNumber: 42 }, loaded.revision);
  await tx.saveRoll({
    key,
    rollId: "r-torn",
    result: { kind: "dice", roll: { expression: { terms: [], modifier: 0 }, terms: [], modifier: 0, total: 1 } },
    rolledAt: 1,
  });
  process.kill(process.pid, "SIGKILL");
});
