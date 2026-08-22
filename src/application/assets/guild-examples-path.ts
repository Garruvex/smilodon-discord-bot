import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { GuildConfiguration } from "../../config/guild-configuration.js";

const examplesAssetPattern =
  /^guild-assets\/\d{17,20}\/examples\.md$/;
const examplesFilePattern = /^[\w./-]+\.md$/;

export function isSafeExamplesFileReference(reference: string): boolean {
  if (
    reference.includes("..") ||
    reference.startsWith("/") ||
    reference.startsWith("\\") ||
    /^[A-Za-z]:/.test(reference)
  ) {
    return false;
  }
  return examplesFilePattern.test(reference);
}

export function resolveGuildExamplesPath(
  profile: GuildConfiguration,
  runtimeDataDirectory: string,
): string | null {
  if (profile.chat.examplesAsset) {
    if (!examplesAssetPattern.test(profile.chat.examplesAsset)) {
      return null;
    }
    const assetRoot = resolve(runtimeDataDirectory, "guild-assets");
    const path = resolve(runtimeDataDirectory, profile.chat.examplesAsset);
    if (!isPathInsideDirectory(path, assetRoot)) {
      return null;
    }
    return path;
  }

  if (profile.chat.examplesFile) {
    if (!isSafeExamplesFileReference(profile.chat.examplesFile)) {
      return null;
    }
    const path = resolve(process.cwd(), profile.chat.examplesFile);
    if (!isPathInsideDirectory(path, process.cwd())) {
      return null;
    }
    return path;
  }

  const defaultPath = resolve(`config/local/examples/${profile.guildId}.md`);
  return existsSync(defaultPath) ? defaultPath : null;
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = resolve(directory);
  const normalizedPath = resolve(path);
  return (
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(`${normalizedDirectory}${sep}`)
  );
}
