import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { GuildConfiguration } from "../../config/guild-configuration.js";

const personalityAssetPattern =
  /^guild-assets\/\d{17,20}\/personality\.md$/;
const personalityFilePattern = /^[\w./-]+\.md$/;

export function isSafePersonalityFileReference(reference: string): boolean {
  if (
    reference.includes("..") ||
    reference.startsWith("/") ||
    reference.startsWith("\\") ||
    /^[A-Za-z]:/.test(reference)
  ) {
    return false;
  }
  return personalityFilePattern.test(reference);
}

export function resolveGuildPersonalityPath(
  profile: GuildConfiguration,
  runtimeDataDirectory: string,
): string | null {
  if (profile.chat.personalityAsset) {
    if (!personalityAssetPattern.test(profile.chat.personalityAsset)) {
      return null;
    }
    const assetRoot = resolve(runtimeDataDirectory, "guild-assets");
    const path = resolve(runtimeDataDirectory, profile.chat.personalityAsset);
    if (!isPathInsideDirectory(path, assetRoot)) {
      return null;
    }
    return path;
  }

  if (profile.chat.personalityFile) {
    if (!isSafePersonalityFileReference(profile.chat.personalityFile)) {
      return null;
    }
    const path = resolve(process.cwd(), profile.chat.personalityFile);
    if (!isPathInsideDirectory(path, process.cwd())) {
      return null;
    }
    return path;
  }

  const defaultPath = resolve(`config/local/personalities/${profile.guildId}.md`);
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
