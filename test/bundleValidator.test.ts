import { describe, expect, it } from "vitest";
import { validateBundleFileShape } from "../src/temporal/bundleValidator.js";

describe("validateBundleFileShape", () => {
  it("accepts the required workflow files", () => {
    expect(() => validateBundleFileShape(["workflow.mjs", "runInput.mjs"])).not.toThrow();
  });

  it("accepts workflow.mjs + README.md", () => {
    expect(() => validateBundleFileShape(["README.md", "workflow.mjs", "runInput.mjs"])).not.toThrow();
  });

  it("accepts a standard package-shaped bundle directory", () => {
    expect(() =>
      validateBundleFileShape([
        "README.md",
        "workflow.mjs",
        "runInput.mjs",
        "package.json",
        "package-lock.json",
        "node_modules",
        "helpers.mjs"
      ])
    ).not.toThrow();
  });

  it("rejects missing workflow.mjs", () => {
    expect(() => validateBundleFileShape(["README.md", "runInput.mjs"])).toThrow(/workflow\.mjs/);
  });

  it("rejects missing runInput.mjs", () => {
    expect(() => validateBundleFileShape(["README.md", "workflow.mjs"])).toThrow(/runInput\.mjs/);
  });

  it("rejects duplicate entries", () => {
    expect(() => validateBundleFileShape(["workflow.mjs", "runInput.mjs", "workflow.mjs"])).toThrow(/more than once/);
  });
});
