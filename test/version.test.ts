import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productVersion } from "../src/version.js";

describe("productVersion", () => {
  it("uses package.json as the single product version source", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };

    expect(productVersion).toBe(manifest.version);
  });
});
