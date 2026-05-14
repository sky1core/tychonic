import { describe, expect, it } from "vitest";
import { validateBundleFileShape } from "../src/temporal/bundleValidator.js";

describe("validateBundleFileShape", () => {
  it("accepts the required workflow.yaml source file", () => {
    expect(() => validateBundleFileShape(["workflow.yaml"])).not.toThrow();
  });

  it("accepts workflow.yaml + README.md", () => {
    expect(() => validateBundleFileShape(["README.md", "workflow.yaml"])).not.toThrow();
  });

  it("accepts a standard package-shaped bundle directory", () => {
    expect(() =>
      validateBundleFileShape([
        "README.md",
        "workflow.yaml",
        "package.json",
        "package-lock.json",
        "node_modules",
        "helpers.mjs"
      ])
    ).not.toThrow();
  });

  it("rejects missing workflow.yaml", () => {
    expect(() => validateBundleFileShape(["README.md"])).toThrow(/workflow\.yaml/);
  });

  it("rejects hand-written workflow.mjs source", () => {
    expect(() => validateBundleFileShape(["workflow.mjs"])).toThrow(/must not contain hand-written 'workflow\.mjs'/);
    expect(() => validateBundleFileShape(["workflow.mjs", "workflow.yaml"])).toThrow(/must not contain hand-written 'workflow\.mjs'/);
  });

  it("rejects duplicate entries", () => {
    expect(() => validateBundleFileShape(["workflow.yaml", "workflow.yaml"])).toThrow(/more than once/);
  });
});
