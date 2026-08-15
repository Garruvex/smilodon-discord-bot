import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { parse } from "dotenv";

const instanceNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface LoadedInstanceEnvironment {
  name: string;
  file: string;
  environment: NodeJS.ProcessEnv;
}

export function loadSharedEnvironment(root = process.cwd()): NodeJS.ProcessEnv {
  const file = resolve(root, ".env");
  return {
    ...process.env,
    ...(existsSync(file) ? parse(readFileSync(file, "utf8")) : {}),
  };
}

export function loadInstanceEnvironment(
  name: string,
  root = process.cwd(),
): LoadedInstanceEnvironment {
  validateInstanceName(name);
  const file = resolve(root, "config", "instances", `${name}.env`);
  if (!existsSync(file)) {
    throw new Error(`Instance environment does not exist: ${file}`);
  }
  const values = parse(readFileSync(file, "utf8"));
  if (values.INSTANCE_NAME && values.INSTANCE_NAME !== name) {
    throw new Error(
      `INSTANCE_NAME "${values.INSTANCE_NAME}" does not match filename "${name}.env".`,
    );
  }
  return {
    name,
    file,
    environment: {
      ...loadSharedEnvironment(root),
      ...values,
      INSTANCE_NAME: name,
    },
  };
}

export function discoverInstanceNames(root = process.cwd()): string[] {
  const directory = resolve(root, "config", "instances");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".env"))
    .map((entry) => basename(entry.name, ".env"))
    .filter((name) => instanceNamePattern.test(name))
    .sort();
}

export function applyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value;
  }
}

export function resolveDefaultInstanceEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (source.INSTANCE_NAME || !source.DEFAULT_INSTANCE) return source;
  return {
    ...source,
    ...loadInstanceEnvironment(source.DEFAULT_INSTANCE).environment,
  };
}

export function validateInstanceIsolation(
  instances: readonly LoadedInstanceEnvironment[],
): void {
  requireUnique(instances, "DISCORD_APPLICATION_ID", true);
  requireUnique(instances, "RUNTIME_DATA_DIRECTORY", true);
  requireUnique(instances, "GUILD_CONFIG_DIRECTORY", true);
  requireUnique(
    instances.filter((instance) => instance.environment.PERSISTENCE_DRIVER === "postgres"),
    "DATABASE_URL",
    true,
  );
}

function validateInstanceName(name: string): void {
  if (!instanceNamePattern.test(name)) {
    throw new Error(
      `Invalid instance name "${name}". Use lowercase letters, numbers, hyphens, or underscores.`,
    );
  }
}

function requireUnique(
  instances: readonly LoadedInstanceEnvironment[],
  key: string,
  required: boolean,
): void {
  const owners = new Map<string, string>();
  for (const instance of instances) {
    const value = instance.environment[key]?.trim();
    if (!value) {
      if (required) throw new Error(`Instance "${instance.name}" is missing ${key}.`);
      continue;
    }
    const normalized = key.endsWith("DIRECTORY") ? resolve(value).toLowerCase() : value;
    const existing = owners.get(normalized);
    if (existing) {
      throw new Error(
        `Instances "${existing}" and "${instance.name}" share ${key}; each bot must be isolated.`,
      );
    }
    owners.set(normalized, instance.name);
  }
}
