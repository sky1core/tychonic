import { describe, expect, it } from "vitest";
import { validateBundleFileShape } from "../src/temporal/bundleValidator.js";

describe("validateBundleFileShape", () => {
  it("accepts workflow.mjs alone", () => {
    expect(() => validateBundleFileShape(["workflow.mjs"])).not.toThrow();
  });

  it("accepts workflow.mjs + README.md", () => {
    expect(() => validateBundleFileShape(["README.md", "workflow.mjs"])).not.toThrow();
  });

  it("accepts a standard package-shaped bundle directory", () => {
    expect(() =>
      validateBundleFileShape([
        "README.md",
        "workflow.mjs",
        "package.json",
        "package-lock.json",
        "node_modules",
        "helpers.mjs"
      ])
    ).not.toThrow();
  });

  it("rejects missing workflow.mjs", () => {
    expect(() => validateBundleFileShape(["README.md"])).toThrow(/workflow\.mjs/);
  });

  it("rejects duplicate entries", () => {
    expect(() => validateBundleFileShape(["workflow.mjs", "workflow.mjs"])).toThrow(/more than once/);
  });
});
