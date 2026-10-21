import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../src");
function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith(".ts") ? [file] : [];
  });
}
describe("conversation execution ownership", () => {
  it("keeps execution and effect approval imports inside the application owner, including aliased imports", () => {
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const module = node.moduleSpecifier.text;
        const owner = file.endsWith(`${path.sep}application${path.sep}chat${path.sep}chat-conversation-service.ts`);
        if (module.endsWith("/guarded-chat-turn.js") && !owner) offenders.push(path.relative(root, file));
        const bindings = node.importClause?.namedBindings;
        if (module.endsWith("/conversation-effects.js") && !owner && bindings &&
          (ts.isNamespaceImport(bindings) || bindings.elements.some((item) => (item.propertyName ?? item.name).text === "authorizeConversationEffects"))) offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
  it("requires each live Discord conversation adapter to consume approved effects", () => {
    const adapters = sources(path.join(root, "infrastructure/discord")).filter((file) => /this\.conversation!?\.run\(/u.test(fs.readFileSync(file, "utf8")));
    expect(adapters).toHaveLength(3);
    for (const file of adapters) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, path.relative(root, file)).toContain("conversationEffects(result)");
      expect(source, path.relative(root, file)).not.toMatch(/result\.(?:reactionEmoji|historyReactions)/u);
    }
  });
});
