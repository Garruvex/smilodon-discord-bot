import { createHash } from "node:crypto";

// Used to detect whether a compiled bundle sidecar (personality.bundle.json,
// examples.bundle.json) is still in sync with the source file it was
// derived from — a mismatch means the file was edited since the last
// compile and the bundle must be treated as stale.
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
