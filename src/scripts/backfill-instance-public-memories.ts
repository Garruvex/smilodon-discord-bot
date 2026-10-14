import { activateRequestedInstance } from "./instance-script-support.js";
activateRequestedInstance(process.argv.slice(2));
const { backfillPublicMemories } = await import("./backfill-public-memories.js");
await backfillPublicMemories();
