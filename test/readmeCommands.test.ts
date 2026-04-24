import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("README public commands", () => {
  it("uses the current npx skills agent argument form", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("npx skills add ./skills -a claude-code codex");
    expect(readme).not.toContain("npx skills add ./skills -a claude-code,codex");
  });
});
