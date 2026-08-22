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
);
