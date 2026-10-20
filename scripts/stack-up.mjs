import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const runCommand = (command, args) => spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: command === "git" ? "pipe" : "inherit" });

export function stackUp(run = runCommand) {
  const git = run("git", ["rev-parse", "HEAD"]);
  const candidate = git.status === 0 ? git.stdout?.trim() : null;
  const revision = candidate && /^[a-f0-9]{40,64}$/iu.test(candidate) ? candidate : "unknown";
  if (revision === "unknown") process.stderr.write("Git revision unavailable; this image will report buildVersion=unknown.\n");
  const compose = ["compose", "-f", "compose.yaml", "-f", "compose.tunnel.yaml"];
  for (const args of [[...compose, "build", "--build-arg", `BUILD_SHA=${revision}`],
    [...compose, "up", "--no-build", "-d", "--wait", "--remove-orphans"]]) {
    const result = run("docker", args);
    if (result.error || result.status !== 0) throw new Error(`Docker stack operation failed (status ${result.status ?? "unavailable"}).`, { cause: result.error });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) stackUp();
