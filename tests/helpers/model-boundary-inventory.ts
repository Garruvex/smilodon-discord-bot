import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const operations = new Set(["generateCharacterData", "analyzeUserCustomization", "summarizeDroppedExchanges", "classifyMemoryConflict",
  "summarizeReplyChainOverflow", "verifyAttribution", "extractPersonalMemories", "compilePersonaBundle", "evolvePersonaDrift",
  "summarizeChannelMessages", "generateReferenceImage", "embed", "embedMany"]);

// Include capability references as well as direct calls: taking a method's
// .bind() or saving it into a callback must not hide a consumer from the audit.
export function modelBoundaryInventory(root: string): Record<string, string[]> {
  const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames.filter((file) => file.includes(`${path.sep}src${path.sep}`) || file.includes("/src/")), parsed.options);
  const checker = program.getTypeChecker(); const inventory: Record<string, string[]> = {};
  for (const source of program.getSourceFiles()) {
    const relative = path.relative(root, source.fileName).replaceAll(path.sep, "/");
    if (!relative.startsWith("src/") || relative.startsWith("src/infrastructure/chat/") || !fs.existsSync(source.fileName)) continue;
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        if (operations.has(name) && checker.getNonNullableType(checker.getTypeAtLocation(node)).getCallSignatures().length > 0) found.add(name);
        else if (name === "reply") {
          // Discord response.reply is unrelated. Recognize the typed ChatRequest
          // parameter rather than guessing from a variable's spelling.
          const signatures = checker.getTypeAtLocation(node).getCallSignatures();
          if (signatures.some((signature) => {
            const parameter = signature.parameters[0];
            return !!parameter && !!checker.getTypeOfSymbolAtLocation(parameter, node).getProperty("webSearchMode");
          })) found.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source); if (found.size) inventory[relative] = [...found].sort();
  }
  return Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b)));
}
