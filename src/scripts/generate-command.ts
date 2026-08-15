import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const supportedModules = ["common", "music", "diagnostics"] as const;
type SupportedModule = (typeof supportedModules)[number];

const [rawName, rawModule = "common", ...descriptionParts] = process.argv.slice(2);
const description = descriptionParts.join(" ").trim() || "TODO: describe this command.";

if (!rawName || !/^[a-z][a-z0-9-]{0,31}$/.test(rawName)) {
  throw new Error(
    "Usage: npm run command:create -- <lowercase-name> [common|music|diagnostics] [description]",
  );
}
if (!supportedModules.includes(rawModule as SupportedModule)) {
  throw new Error(`Unsupported module "${rawModule}". Choose: ${supportedModules.join(", ")}.`);
}
if (description.length > 100) {
  throw new Error("Discord command descriptions must be 100 characters or fewer.");
}

const moduleName = rawModule as SupportedModule;
const className = `${rawName
  .split("-")
  .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
  .join("")}Command`;
const fileName = `${rawName}-command.ts`;
const sourcePath = resolve("src/infrastructure/discord/commands", moduleName, fileName);
const testPath = resolve("tests/commands", `${rawName}-command.test.ts`);

if (existsSync(sourcePath) || existsSync(testPath)) {
  throw new Error(`Refusing to overwrite an existing command or test for "${rawName}".`);
}

const accessImport = moduleName === "music"
  ? 'import { musicPlaybackAccessPolicy } from "./music-command-support.js";'
  : 'import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";';
const accessExpression = moduleName === "music"
  ? "musicPlaybackAccessPolicy"
  : moduleName === "diagnostics"
    ? "{ ...publicAccessPolicy, ownerOnly: true }"
    : "publicAccessPolicy";
const commandModule = `${moduleName[0]!.toUpperCase()}${moduleName.slice(1)}`;

const source = `import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
${accessImport}

export class ${className} implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("${rawName}")
    .setDescription(${JSON.stringify(description)});

  public readonly module = CommandModule.${commandModule};
  public readonly access = ${accessExpression};

  public async execute(context: CommandContext): Promise<void> {
    await context.responses.reply("TODO: implement ${rawName}.");
  }
}
`;

const test = `import { describe, expect, it } from "vitest";

import { CommandModule } from "../../src/application/commands/command.js";
import { ${className} } from "../../src/infrastructure/discord/commands/${moduleName}/${fileName.replace(".ts", ".js")}";

describe("${className}", () => {
  it("declares the expected command metadata", () => {
    const command = new ${className}();

    expect(command.definition.name).toBe("${rawName}");
    expect(command.module).toBe(CommandModule.${commandModule});
  });
});
`;

mkdirSync(resolve(sourcePath, ".."), { recursive: true });
mkdirSync(resolve(testPath, ".."), { recursive: true });
writeFileSync(sourcePath, source, { encoding: "utf8", flag: "wx" });
writeFileSync(testPath, test, { encoding: "utf8", flag: "wx" });

process.stdout.write(`Created:\n- ${sourcePath}\n- ${testPath}\n\nRegister ${className} in src/bootstrap/dependencies.ts.\n`);
