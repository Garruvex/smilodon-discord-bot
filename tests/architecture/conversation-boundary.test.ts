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
        if (module.endsWith("/approved-model-operation.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const issuers = ["application/context/conversation-model-gateway.ts", "application/context/background-model-gateway.ts", "application/context/configuration-model-gateway.ts",
            "application/memory/memory-context-guard.ts", "application/chat/character-runtime.ts", "application/chat/character-decision.ts", "application/chat/tools/generate-self-image-tool.ts"];
          const permitted = relative === "application/context/guarded-embedding-transport.ts" ? ["consumeEmbeddingOperation"] :
            relative === "application/context/guarded-utility-transport.ts" ? ["consumeModelOperation", "snapshotModelArguments"] :
            ["application/memory/memory-context-guard.ts", "application/context/configuration-model-gateway.ts"].includes(relative) ? ["approveModelOperation", "approveEmbeddingOperation"] :
            issuers.includes(relative) ? relative === "application/chat/character-decision.ts" ? ["approveModelOperation", "approveDiagnosticModelOperation"] : ["approveModelOperation"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
        if (module.endsWith("/approved-decision-input.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const permitted = ["application/chat/character-runtime.ts", "scripts/replay-contextual-participation.ts"].includes(relative) ? ["approveDecisionInput"] :
            relative === "application/chat/character-decision.ts" ? ["isApprovedDecisionInput"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
        if (module.endsWith("/guarded-utility-transport.js") && !node.importClause?.isTypeOnly && !["bootstrap/dependencies.ts", "scripts/replay-contextual-participation.ts", "scripts/replay-conversation-lifecycle.ts"].includes(relative)) offenders.push(relative);
        if (module.endsWith("/guarded-embedding-transport.js") && !node.importClause?.isTypeOnly && relative !== "bootstrap/dependencies.ts") offenders.push(relative);
        if (module.endsWith("/character-memory.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          if (imported.includes("CharacterMemory") && relative !== "application/chat/character-runtime.ts" || imported.includes("*")) offenders.push(relative);
        }
        if ((module.endsWith("/memory-engine.js") || module.endsWith("/guarded-memory-gateway.js")) && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const permitted = module.endsWith("/memory-engine.js") ? relative === "application/context/guarded-memory-gateway.ts" ? ["DefaultMemoryEngine"] : ["defaultMemoryEngineLimits"] :
            ["bootstrap/dependencies.ts", "scripts/replay-character-conversations.ts", "scripts/replay-conversation-lifecycle.ts"].includes(relative) ? ["createGuardedMemoryEngine"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
        if (module.endsWith("/approved-memory-ingest.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const permitted = relative === "application/context/channel-summary-scheduler.ts" ? ["approveMemoryIngest", "approveRelationIngest"] :
            ["application/chat/guarded-chat-turn.ts", "application/chat/guarded-post-turn.ts"].includes(relative) ? ["approveMemoryIngest"] :
              ["application/memory/memory-engine.ts", "application/context/guarded-memory-gateway.ts"].includes(relative) ? ["requireApprovedMemoryIngest", "requireApprovedRelationIngest"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
        if (module.endsWith("/retrieval-query.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const permitted = relative === "application/chat/guarded-tool-gateway.ts" ? ["toolRetrievalQuery"] :
            ["application/memory/memory-engine.ts", "application/chat/example-exchange-selector.ts", "application/chat/persona-lore-selector.ts"].includes(relative) ? ["retrievalProjection"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
        if (module.endsWith("/guarded-evaluation-context.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const permitted = relative === "bootstrap/dependencies.ts" ? ["GuardedEvaluationContext"] :
            ["application/chat/character-runtime.ts", "application/context/configuration-model-gateway.ts", "application/context/approved-model-operation.ts"].includes(relative) ? ["isEvaluationContext"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
        if (module.endsWith("/approved-conversation-request.js") && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : ["*"];
          const permitted = relative === "application/chat/guarded-chat-turn.ts" ? ["approveConversationRequest"] :
            ["application/chat/chat-conversation-service.ts", "application/chat/character-runtime.ts"].includes(relative) ? ["repairConversationRequest"] :
              relative === "application/context/conversation-model-gateway.ts" ? ["requireApprovedConversationRequest"] : [];
          if (imported.some((name) => !permitted.includes(name))) offenders.push(relative);
        }
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
        if (module.endsWith("/conversation-model-gateway.js") && !node.importClause?.isTypeOnly && !["application/chat/guarded-post-turn.ts", "application/chat/chat-conversation-service.ts", "application/chat/character-runtime.ts"].includes(relative)) offenders.push(relative);
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
      expect(source, path.relative(root, file)).toContain("guardedContextPort: this.turnSupport.createContextPort(");
      expect(source, path.relative(root, file)).not.toContain("usesGuardedContext");
      expect(source, path.relative(root, file)).not.toMatch(/resolve(?:ReplyChain|ChannelHistory)\(/u);
      expect(source, path.relative(root, file)).not.toMatch(/result\.(?:reactionEmoji|historyReactions)/u);
    }
  });
  it("has one live context path independently of participation rollout", () => {
    const service = fs.readFileSync(path.join(root, "application/chat/chat-conversation-service.ts"), "utf8");
    expect(service).not.toContain("private runTurn(");
    expect(service).not.toMatch(/context\s*===\s*"legacy"/u);
    const plan = fs.readFileSync(path.join(root, "application/chat/conversation-turn-plan.ts"), "utf8");
    expect(plan).not.toContain('context: "legacy"');
  });
});
