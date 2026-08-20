import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { parse } from "dotenv";

const instanceNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// CHATBOT_* (main chatbot persona/reply model) and UTILITY_* (fully
// independent provider for standalone structured-output calls) — both
// instance-owned, neither inherited from the shared root .env.
const instanceOwnedEnvironmentPrefixes = ["CHATBOT_", "UTILITY_"] as const;

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
      ...withoutInstanceOwnedValues(loadSharedEnvironment(root)),
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
    ...withoutInstanceOwnedValues(source),
    ...loadInstanceEnvironment(source.DEFAULT_INSTANCE).environment,
  };
}

function withoutInstanceOwnedValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) =>
      !instanceOwnedEnvironmentPrefixes.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

export function validateInstanceIsolation(
  instances: readonly LoadedInstanceEnvironment[],
): void {
  requireUnique(instances, "DISCORD_APPLICATION_ID", true);
  requireUnique(instances, "RUNTIME_DATA_DIRECTORY", true);
  requireUnique(instances, "GUILD_CONFIG_DIRECTORY", true);
  // Every Postgres instance has an "effective schema": PERSISTENCE_SCHEMA_PER_INSTANCE
  // opts it into one derived from its name (mirrors resolveInstanceSchemaName
  // in src/infrastructure/database/database.ts), otherwise it's the
  // database's default ("public") — exactly today's behavior. Two instances
  // sharing a DATABASE_URL must resolve to different effective schemas, or
  // they'd read/write the same tables. This is a strict relaxation of the
  // old "DATABASE_URL must always be unique" rule: an instance that hasn't
  // opted in still can't share a database with anything (its effective
  // schema is always "public"), matching prior behavior exactly.
  const postgresInstances = instances.filter((instance) => instance.environment.PERSISTENCE_DRIVER === "postgres");
  const schemaOwnersByDatabaseUrl = new Map<string, Map<string, string>>();
  for (const instance of postgresInstances) {
    const databaseUrl = instance.environment.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error(`Instance "${instance.name}" is missing DATABASE_URL.`);
    const effectiveSchema = instance.environment.PERSISTENCE_SCHEMA_PER_INSTANCE === "true"
      ? instance.name.replaceAll("-", "_")
      : "public";
    const schemaOwners = schemaOwnersByDatabaseUrl.get(databaseUrl) ?? new Map<string, string>();
    schemaOwnersByDatabaseUrl.set(databaseUrl, schemaOwners);
    const existing = schemaOwners.get(effectiveSchema);
    if (existing) {
      throw new Error(
        `Instances "${existing}" and "${instance.name}" share DATABASE_URL and resolve to the same schema ` +
        `("${effectiveSchema}"); each bot must be isolated — rename one or enable ` +
        `PERSISTENCE_SCHEMA_PER_INSTANCE with a distinct instance name.`,
      );
    }
    schemaOwners.set(effectiveSchema, instance.name);
  }
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
