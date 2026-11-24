import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";
import { hashContent } from "../../src/application/assets/content-hash.js";

// A5: drift built from a revoked message is deleted, but only the version that cites it. A drift
// that was replaced by an independently valid version before cleanup ran survives.
function writeDrift(directory: string, channelId: string, cited: readonly { messageId: string; background?: boolean }[], text: string): void {
  const folder = join(directory, "guild-assets", "guild"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `persona-drift.${channelId}.json`), JSON.stringify({ guildId: "guild", channelId, epoch: randomUUID(), personalitySourceHash: hashContent("personality"),
    text, updatedAt: 1, contextProvenance: { version: 1, purpose: "character_state", coverage: "complete", audience: { guildId: "guild", channelId, userId: null },
      outputHash: hashContent(text), unresolved: [], dependencies: cited.map(({ messageId, background }) => ({ guildId: "guild", channelId, messageId, authorId: "alice",
        timestampMs: 1, representationHash: hashContent(messageId), ...(background ? { projection: { kind: "background_text", chars: 5 } } : {}) })) } }));
}

describe("persona drift revocation cleanup", () => {
  it("deletes only the drift version that cites a revoked message as conversation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "drift-revocation-"));
    const store = new PersonaDriftStore(directory);
    writeDrift(directory, "chat", [{ messageId: "question" }, { messageId: "deleted" }], "grew fond of puns");
    writeDrift(directory, "summary", [{ messageId: "question" }, { messageId: "deleted", background: true }], "likes summaries");
    writeDrift(directory, "other", [{ messageId: "question" }], "unrelated");
    expect(await store.forgetCitingMessages("guild", "chat", ["deleted"])).toBe(1);
    expect(await store.getScoped("guild", "chat")).toBeNull();
    // Summary-only citations keep the guild's retention policy; other channels are untouched.
    expect(await store.forgetCitingMessages("guild", "summary", ["deleted"])).toBe(0);
    expect((await store.getScoped("guild", "summary"))?.text).toBe("likes summaries");
    expect(await store.forgetCitingMessages("guild", "other", ["deleted"])).toBe(0);
    expect((await store.getScoped("guild", "other"))?.text).toBe("unrelated");
  });

  it("keeps an independently valid replacement written before cleanup ran", async () => {
    const directory = mkdtempSync(join(tmpdir(), "drift-replaced-"));
    const store = new PersonaDriftStore(directory);
    writeDrift(directory, "chat", [{ messageId: "deleted" }], "old drift");
    writeDrift(directory, "chat", [{ messageId: "later" }], "new drift");
    expect(await store.forgetCitingMessages("guild", "chat", ["deleted"])).toBe(0);
    expect((await store.getScoped("guild", "chat"))?.text).toBe("new drift");
    expect(await store.forgetCitingMessages("guild", "missing", ["deleted"])).toBe(0);
  });
});
