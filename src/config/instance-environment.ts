import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { parse } from "dotenv";

const instanceNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// CHATBOT_* (main chatbot persona/reply model), UTILITY_* (fully independent
// task for standalone structured-output calls), and OPENAI_*/GOOGLE_* (the
// shared per-vendor API key pool both tasks draw from) — all instance-owned,
// none inherited from the shared root .env.
const instanceOwnedEnvironmentPrefixes = ["CHATBOT_", "UTILITY_", "OPENAI_", "GOOGLE_"] as const;

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
  const shared = withoutInstanceOwnedValues(loadSharedEnvironment(root));
  const environment: NodeJS.ProcessEnv = {
    ...shared,
    ...values,
    INSTANCE_NAME: name,
  };
  return {
    name,
    file,
    environment: resolveSharedPostgresEnvironment(environment),
  };
}

export function resolveSharedPostgresEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.PERSISTENCE_DRIVER !== "postgres" || !source.POSTGRES_PASSWORD) return source;
  const host = source.POSTGRES_HOST?.trim() || "127.0.0.1";
  const port = source.POSTGRES_PORT?.trim() || "5432";
  const database = source.POSTGRES_DB?.trim() || "fntu_bot";
  const user = source.POSTGRES_USER?.trim() || "fntu_bot";
  return {
    ...source,
    DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(source.POSTGRES_PASSWORD)}@${host}:${port}/${encodeURIComponent(database)}`,
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
  // PostgreSQL always derives an isolated schema from INSTANCE_NAME. Sharing
  // DATABASE_URL is therefore safe unless two differently formatted instance
  // names fold to the same PostgreSQL identifier (for example, a-b and a_b).
  const postgresInstances = instances.filter((instance) => instance.environment.PERSISTENCE_DRIVER === "postgres");
  const schemaOwnersByDatabaseUrl = new Map<string, Map<string, string>>();
  for (const instance of postgresInstances) {
    const databaseUrl = instance.environment.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error(`Instance "${instance.name}" is missing DATABASE_URL.`);
    const effectiveSchema = instance.name.replaceAll("-", "_");
    const schemaOwners = schemaOwnersByDatabaseUrl.get(databaseUrl) ?? new Map<string, string>();
    schemaOwnersByDatabaseUrl.set(databaseUrl, schemaOwners);
    const existing = schemaOwners.get(effectiveSchema);
    if (existing) {
      throw new Error(
        `Instances "${existing}" and "${instance.name}" share DATABASE_URL and resolve to the same schema ` +
        `("${effectiveSchema}"); rename one instance to preserve isolation.`,
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
