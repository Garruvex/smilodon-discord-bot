import { z } from "zod";

// Sidecar JSON written next to an uploaded personality.md
// (guild-assets/{guildId}/personality.bundle.json) by PersonaBundleCompiler
// at upload time, and read back by FilePersonaSource on every turn. Never
// hand-authored — always machine-generated from the current file content.
export const personaBundleSchema = z.object({
  sourceHash: z.string(),
  core: z.string(),
  chunks: z.array(z.object({
    heading: z.string(),
    text: z.string(),
    embedding: z.array(z.number()).nullable(),
  })),
  compiledAt: z.number(),
});

export type PersonaBundle = z.infer<typeof personaBundleSchema>;

export function serializePersonaBundle(bundle: PersonaBundle): string {
  return JSON.stringify(bundle);
}

/** Returns null for missing/malformed/unparseable content rather than throwing — a bad bundle is always just a cache miss. */
export function parsePersonaBundle(raw: string): PersonaBundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = personaBundleSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
