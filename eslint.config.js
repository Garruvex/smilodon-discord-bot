import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  {
    // tools/local holds workspace-installed runtime software (a downloaded
    // Lavalink.jar, a portable JRE, Postgres data files, download caches) —
    // not project source, and not JS/TS this project authored, so it must
    // never be linted as if it were.
    ignores: ["coverage/**", "dist/**", "node_modules/**", "tools/local/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-floating-promises": "error",
      // Matches this codebase's existing convention for an intentionally
      // unused destructured binding (e.g. `const { embedding: _embedding,
      // ...rest } = record` to omit a field) — already the de facto pattern
      // for unused function params, extended here to variables/destructures.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  {
    // The campaign rules engine must stay pure and deterministic (see
    // docs/dnd-code-structure.md §1): no Discord, database, provider, or
    // Node APIs, and no reaching outward into application/infrastructure.
    files: ["src/domain/campaign/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/application/**", "**/infrastructure/**", "**/bootstrap/**"], message: "The campaign domain must not depend on outer layers." },
          { group: ["node:*", "discord.js", "drizzle-orm", "drizzle-orm/*", "postgres", "better-sqlite3", "pino"], message: "The campaign domain must stay free of I/O and framework imports." },
        ],
      }],
    },
  },
);
