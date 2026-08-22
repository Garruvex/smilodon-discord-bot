import { describe, expect, it } from "vitest";

import { resolveInstanceSchemaName } from "../../src/infrastructure/database/database.js";

describe("resolveInstanceSchemaName", () => {
  it("passes an already-identifier-safe name through unchanged", () => {
    expect(resolveInstanceSchemaName("yohta")).toBe("yohta");
  });

  it("folds hyphens to underscores, since unquoted Postgres identifiers can't contain them", () => {
    expect(resolveInstanceSchemaName("my-instance")).toBe("my_instance");
    expect(resolveInstanceSchemaName("multi-word-name")).toBe("multi_word_name");
  });
});
