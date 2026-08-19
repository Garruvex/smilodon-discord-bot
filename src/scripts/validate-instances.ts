import {
  discoverInstanceNames,
  loadInstanceEnvironment,
  validateInstanceIsolation,
} from "../config/instance-environment.js";

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : discoverInstanceNames();
if (names.length === 0) {
  throw new Error("No instance .env files were found under config/instances.");
}
const instances = names.map((name) => loadInstanceEnvironment(name));
validateInstanceIsolation(instances);
process.stdout.write(`Valid instances: ${names.join(", ")}\n`);
