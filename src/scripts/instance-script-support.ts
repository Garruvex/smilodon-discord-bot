import { applyEnvironment, loadInstanceEnvironment } from "../config/instance-environment.js";

export function activateRequestedInstance(arguments_: readonly string[]): string {
  const name = arguments_[0];
  if (!name) throw new Error("Provide an instance name, for example: myinstance");
  const instance = loadInstanceEnvironment(name);
  applyEnvironment(instance.environment);
  return instance.name;
}
