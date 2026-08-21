import { activateRequestedInstance } from "./instance-script-support.js";

activateRequestedInstance(process.argv.slice(2));
await import("./migrate-active-database.js");
