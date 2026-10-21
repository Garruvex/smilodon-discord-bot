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
      const relativeFile = path.relative(root, file).replaceAll(path.sep, "/");
      const checkSessionIssuers = (node: ts.Node): void => {
        const property = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
        if ((property === "sessionProvenance" || property === "recordSession") && relativeFile !== "infrastructure/discord/behaviors/chat-turn-support.ts") offenders.push(relativeFile);
        ts.forEachChild(node, checkSessionIssuers);
      };
      checkSessionIssuers(source);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const module = node.moduleSpecifier.text;
        const relative = path.relative(root, file).replaceAll(path.sep, "/");
        if (module.endsWith("/conversation-configuration.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          if (imported.some((name) => name !== "defaultPersonality") && !["application/chat/guarded-chat-turn.ts", "application/chat/guarded-post-turn.ts", "bootstrap/dependencies.ts"].includes(relative)) offenders.push(relative);
        }
        if (module.endsWith("/guarded-configuration-context.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const issuers = ["application/assets/guild-asset-store.ts", "application/context/conversation-configuration.ts", "infrastructure/chat/file-persona-source.ts", "infrastructure/discord/commands/common/customize-command.ts"];
          if (imported.some((name) => !["isConfigurationContext", "configurationMaterialHash"].includes(name)) && !issuers.includes(relative)) offenders.push(relative);
        }
        if (module.endsWith("/conversation-source-registry.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const permitted = relative === "infrastructure/discord/behaviors/chat-turn-support.ts" || relative === "application/chat/synthetic-replay-context.ts" ? ["registerConversationSource"]
            : relative === "application/chat/guarded-tool-gateway.ts" ? ["extendConversationSource"]
              : relative === "application/chat/guarded-conversation-context.ts" ? ["isConversationSource"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
        const owner = file.endsWith(`${path.sep}application${path.sep}chat${path.sep}chat-conversation-service.ts`);
        if (module.endsWith("/guarded-chat-turn.js") && !owner) offenders.push(path.relative(root, file));
        if (module.endsWith("/guarded-post-turn.js") && !owner) offenders.push(relative);
        if (module.endsWith("/conversation-model-gateway.js") && !node.importClause?.isTypeOnly && !["application/chat/guarded-post-turn.ts", "application/chat/chat-conversation-service.ts"].includes(relative)) offenders.push(relative);
        const typeOnly = node.importClause?.isTypeOnly;
        const predicateOnly = module.endsWith("/guarded-background-context.js") && node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every((item) => item.isTypeOnly || (item.propertyName ?? item.name).text === "isBackgroundContext");
        if (!typeOnly && !predicateOnly && (module.endsWith("/background-model-gateway.js") || module.endsWith("/guarded-background-context.js")) &&
            !file.endsWith(`${path.sep}context${path.sep}channel-summary-scheduler.ts`) &&
            !file.endsWith(`${path.sep}context${path.sep}background-model-gateway.ts`)) offenders.push(path.relative(root, file));
        if (module.endsWith("/synthetic-replay-context.js") && !file.includes(`${path.sep}scripts${path.sep}replay-`) &&
            !file.endsWith(`${path.sep}chat${path.sep}contextual-replay-policy.ts`)) offenders.push(path.relative(root, file));
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
