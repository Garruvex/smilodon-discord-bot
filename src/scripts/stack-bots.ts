import { spawnSync } from "node:child_process";

// Runs an action against every bot-* service in the active compose file
// (compose.yaml is per-machine and gitignored, so service names can't be
// hardcoded in package.json). Optional extra arguments narrow the set by
// instance name: `npm run stack:deploy -- yohta` targets bot-yohta only.
const actions = ["deploy", "restart"] as const;
type Action = (typeof actions)[number];

const [rawAction, ...requestedInstances] = process.argv.slice(2);
if (!actions.includes(rawAction as Action)) {
  throw new Error(`Usage: tsx src/scripts/stack-bots.ts <${actions.join("|")}> [instance...]`);
}
const action = rawAction as Action;

const listed = runDocker(["compose", "config", "--services"], "pipe");
const botServices = listed.split(/\r?\n/).map((line) => line.trim()).filter((name) => name.startsWith("bot-"));
const services = requestedInstances.length > 0
  ? requestedInstances.map((instance) => `bot-${instance}`)
  : botServices;

const unknown = services.filter((service) => !botServices.includes(service));
if (unknown.length > 0) {
  throw new Error(`Unknown bot service(s): ${unknown.join(", ")}. Available: ${botServices.join(", ") || "none"}.`);
}
if (services.length === 0) throw new Error("No bot-* services were found in the compose file.");

if (action === "restart") {
  runDocker(["compose", "restart", ...services], "inherit");
} else {
  for (const service of services) {
    process.stdout.write(`Deploying commands for ${service}...\n`);
    runDocker(["compose", "run", "--rm", "--no-deps", service, "node", "dist/scripts/deploy-commands.js"], "inherit");
  }
}

function runDocker(arguments_: readonly string[], stdio: "pipe" | "inherit"): string {
  const result = spawnSync("docker", arguments_, { cwd: process.cwd(), stdio, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (stdio === "pipe") process.stderr.write(result.stderr);
    throw new Error(`docker ${arguments_.join(" ")} exited with status ${result.status ?? "unknown"}.`);
  }
  return result.stdout ?? "";
}
