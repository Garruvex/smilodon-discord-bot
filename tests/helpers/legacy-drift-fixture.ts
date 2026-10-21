import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Deliberately unproven legacy state, used only to verify exclusion/erasure.
export async function seedLegacyDrift(directory: string, guildId: string, text: string, personalitySourceHash: string): Promise<void> {
  const target = join(directory, "guild-assets", guildId); await mkdir(target, { recursive: true });
  await writeFile(join(target, "persona-drift.json"), JSON.stringify({ text, personalitySourceHash, updatedAt: 1000, history: [] }), "utf8");
}
