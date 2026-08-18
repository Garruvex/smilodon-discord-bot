import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverInstanceNames,
  loadInstanceEnvironment,
  validateInstanceIsolation,
} from "../../src/config/instance-environment.js";

const directories: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "fntu-instances-"));
  directories.push(root);
  mkdirSync(join(root, "config", "instances"), { recursive: true });
  writeFileSync(join(root, ".env"), "LAVALINK_HOST=shared-host\n", "utf8");
  return root;
}

function writeInstance(root: string, name: string, extra = ""): void {
  writeFileSync(
    join(root, "config", "instances", `${name}.env`),
    [
      `INSTANCE_NAME=${name}`,
      `DISCORD_APPLICATION_ID=${name === "one" ? "123456789012345678" : "223456789012345678"}`,
      `RUNTIME_DATA_DIRECTORY=./data/${name}`,
      `GUILD_CONFIG_DIRECTORY=./config/${name}`,
      "PERSISTENCE_DRIVER=file",
      extra,
    ].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("instance environment", () => {
  it("loads shared values and lets the named instance override them", () => {
    const root = workspace();
    writeInstance(root, "one", "LAVALINK_HOST=instance-host");
    const instance = loadInstanceEnvironment("one", root);
    expect(instance.environment.LAVALINK_HOST).toBe("instance-host");
    expect(instance.environment.INSTANCE_NAME).toBe("one");
  });

  it("does not inherit instance-owned chat settings from the shared environment", () => {
    const root = workspace();
    writeFileSync(
      join(root, ".env"),
      "LAVALINK_HOST=shared-host\nCHAT_MODEL=shared-model\nCHAT_API_KEY=shared-key\n",
      "utf8",
    );
    writeInstance(root, "one", "CHAT_MODEL=instance-model\nCHAT_API_KEY=instance-key");

    const instance = loadInstanceEnvironment("one", root);
    expect(instance.environment.CHAT_MODEL).toBe("instance-model");
    expect(instance.environment.CHAT_API_KEY).toBe("instance-key");

    writeInstance(root, "two");
    const second = loadInstanceEnvironment("two", root);
    expect(second.environment.CHAT_MODEL).toBeUndefined();
    expect(second.environment.CHAT_API_KEY).toBeUndefined();
  });

  it("discovers only real instance env files", () => {
    const root = workspace();
    writeInstance(root, "one");
    writeFileSync(join(root, "config", "instances", "bot.env.example"), "", "utf8");
    expect(discoverInstanceNames(root)).toEqual(["one"]);
  });

  it("rejects a filename and INSTANCE_NAME mismatch", () => {
    const root = workspace();
    writeInstance(root, "one");
    const file = join(root, "config", "instances", "one.env");
    writeFileSync(file, "INSTANCE_NAME=two\n", "utf8");
    expect(() => loadInstanceEnvironment("one", root)).toThrow("does not match filename");
  });

  it("rejects shared runtime ownership", () => {
    const root = workspace();
    writeInstance(root, "one");
    writeInstance(root, "two", "RUNTIME_DATA_DIRECTORY=./data/one");
    expect(() => validateInstanceIsolation([
      loadInstanceEnvironment("one", root),
      loadInstanceEnvironment("two", root),
    ])).toThrow("share RUNTIME_DATA_DIRECTORY");
  });
});
