import { describe, expect, it } from "vitest";
import {
  normalizeBundleRequires,
  validateBundleFileShape,
  validateBundleRequires
} from "../src/temporal/bundleValidator.js";
import { TychonicConfigSchema } from "../src/catalog/types.js";

describe("validateBundleFileShape", () => {
  it("accepts workflow.mjs + config.yaml", () => {
    expect(() => validateBundleFileShape(["workflow.mjs", "config.yaml"])).not.toThrow();
  });

  it("accepts workflow.mjs + config.yaml + README.md", () => {
    expect(() =>
      validateBundleFileShape(["README.md", "workflow.mjs", "config.yaml"])
    ).not.toThrow();
  });

  it("rejects missing workflow.mjs", () => {
    expect(() => validateBundleFileShape(["config.yaml"])).toThrow(/workflow\.mjs/);
  });

  it("rejects missing config.yaml", () => {
    expect(() => validateBundleFileShape(["workflow.mjs"])).toThrow(/config\.yaml/);
  });

  it("rejects unexpected extra files", () => {
    expect(() =>
      validateBundleFileShape(["workflow.mjs", "config.yaml", "extra.json"])
    ).toThrow(/unexpected entry 'extra.json'/);
  });

  it("rejects unexpected subdirectory entries", () => {
    expect(() =>
      validateBundleFileShape(["workflow.mjs", "config.yaml", "node_modules"])
    ).toThrow(/node_modules/);
  });

  it("rejects duplicate entries", () => {
    expect(() =>
      validateBundleFileShape(["workflow.mjs", "workflow.mjs", "config.yaml"])
    ).toThrow(/more than once/);
  });
});

describe("normalizeBundleRequires", () => {
  it("accepts a valid requires export", () => {
    const result = normalizeBundleRequires({
      states: [
        { name: "work", type: "work" },
        { name: "review", type: "review" }
      ]
    });
    expect(result.states).toEqual([
      { name: "work", type: "work" },
      { name: "review", type: "review" }
    ]);
  });

  it("rejects a non-object value", () => {
    expect(() => normalizeBundleRequires(null)).toThrow();
    expect(() => normalizeBundleRequires([])).toThrow();
    expect(() => normalizeBundleRequires(42)).toThrow();
  });

  it("rejects missing states array", () => {
    expect(() => normalizeBundleRequires({})).toThrow(/requires\.states/);
  });

  it("rejects an empty states array", () => {
    expect(() => normalizeBundleRequires({ states: [] })).toThrow(/non-empty/);
  });

  it("rejects an entry with no name", () => {
    expect(() =>
      normalizeBundleRequires({ states: [{ type: "work" }] })
    ).toThrow(/string name/);
  });

  it("rejects an entry with an invalid type", () => {
    expect(() =>
      normalizeBundleRequires({ states: [{ name: "work", type: "bogus" }] })
    ).toThrow(/invalid type 'bogus'/);
  });

  it("rejects duplicate names", () => {
    expect(() =>
      normalizeBundleRequires({
        states: [
          { name: "a", type: "work" },
          { name: "a", type: "review" }
        ]
      })
    ).toThrow(/more than once/);
  });
});

describe("validateBundleRequires", () => {
  const baseConfig = {
    version: "tychonic.config.v1",
    states: {
      work: {
        type: "work",
        command: "echo work"
      },
      review: {
        type: "review",
        command: "echo review",
        emits: ["tychonic.review.v1"]
      }
    }
  };

  it("accepts matching name+type pairs", () => {
    const config = TychonicConfigSchema.parse(baseConfig);
    expect(() =>
      validateBundleRequires({
        requires: {
          states: [
            { name: "work", type: "work" },
            { name: "review", type: "review" }
          ]
        },
        config
      })
    ).not.toThrow();
  });

  it("fails when a required name is missing from config.yaml", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", command: "echo work" }
      }
    });
    expect(() =>
      validateBundleRequires({
        requires: {
          states: [
            { name: "work", type: "work" },
            { name: "review", type: "review" }
          ]
        },
        config
      })
    ).toThrow(/no matching states\.review block/);
  });

  it("fails when a required name has the wrong type", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: { type: "review", command: "echo work", emits: ["tychonic.review.v1"] },
        review: { type: "review", command: "echo review", emits: ["tychonic.review.v1"] }
      }
    });
    expect(() =>
      validateBundleRequires({
        requires: {
          states: [
            { name: "work", type: "work" },
            { name: "review", type: "review" }
          ]
        },
        config
      })
    ).toThrow(/with type 'review'/);
  });

  it("fails when config.yaml declares an extra state the workflow does not reference", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", command: "echo work" },
        review: { type: "review", command: "echo review", emits: ["tychonic.review.v1"] },
        extra: { type: "verify", command: "echo verify" }
      }
    });
    expect(() =>
      validateBundleRequires({
        requires: {
          states: [
            { name: "work", type: "work" },
            { name: "review", type: "review" }
          ]
        },
        config
      })
    ).toThrow(/declares states\.extra/);
  });
});
