import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Example bundle contract: every `defaultProfile` worker / review
// state runs through a built-in adapter (`agent: "<name>"`), not through a
// hand-rolled `command`. The deterministic `verify` type is the legitimate
// escape-hatch path and keeps `command`.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import { defaultProfile as simpleDefault } from "../examples/workflows/simpleWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as simpleWorkflowModule from "../examples/workflows/simpleWorkflow/workflow.mjs";
import { defaultProfile as checkpointDefault } from "../examples/workflows/checkpointWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as checkpointWorkflowModule from "../examples/workflows/checkpointWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as pipelineDefault } from "../examples/workflows/pipelineWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as pipelineWorkflowModule from "../examples/workflows/pipelineWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as architectDefault } from "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as architectWorkflowModule from "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as architectKiroQaDefault } from "../examples/workflows/architectBuilderKiroQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as architectKiroQaWorkflowModule from "../examples/workflows/architectBuilderKiroQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as architectKiroRepairQaDefault } from "../examples/workflows/architectBuilderKiroRepairQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as architectKiroRepairQaWorkflowModule from "../examples/workflows/architectBuilderKiroRepairQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as verifyOnlyDefault } from "../examples/workflows/verifyOnlyWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as verifyOnlyWorkflowModule from "../examples/workflows/verifyOnlyWorkflow/workflow.mjs";

import { TychonicConfigSchema } from "../src/catalog/types.js";

const BUILTIN_AGENTS = new Set(["claude", "codex", "gemini", "kiro"]);
const ADAPTER_TYPES = new Set(["work", "review"]);
const ESCAPE_HATCH_TYPES = new Set(["verify"]);

interface Bundle {
  name: string;
  profile: any;
  module: Record<string, unknown>;
}

const BUNDLES: readonly Bundle[] = [
  { name: "simpleWorkflow", profile: simpleDefault, module: simpleWorkflowModule },
  { name: "checkpointWorkflow", profile: checkpointDefault, module: checkpointWorkflowModule },
  { name: "pipelineWorkflow", profile: pipelineDefault, module: pipelineWorkflowModule },
  { name: "architectBuilderQaWorkflow", profile: architectDefault, module: architectWorkflowModule },
  {
    name: "architectBuilderKiroQaWorkflow",
    profile: architectKiroQaDefault,
    module: architectKiroQaWorkflowModule
  },
  {
    name: "architectBuilderKiroRepairQaWorkflow",
    profile: architectKiroRepairQaDefault,
    module: architectKiroRepairQaWorkflowModule
  },
  { name: "verifyOnlyWorkflow", profile: verifyOnlyDefault, module: verifyOnlyWorkflowModule }
];

describe("example bundle defaultProfile shape", () => {
  for (const bundle of BUNDLES) {
    describe(bundle.name, () => {
      it("does not carry per-example package metadata for Temporal SDK resolution", () => {
        const packagePath = join(process.cwd(), "examples", "workflows", bundle.name, "package.json");
        expect(existsSync(packagePath), `${bundle.name} should not require per-bundle npm install`).toBe(false);
      });

      it("exports only defaultProfile and the workflow function", () => {
        expect(Object.keys(bundle.module).sort()).toEqual(["defaultProfile", bundle.name].sort());
      });

      it("validates against the host TychonicConfigSchema", () => {
        const result = TychonicConfigSchema.safeParse(bundle.profile);
        expect(result.success, JSON.stringify(result.error?.issues ?? null, null, 2)).toBe(true);
      });

      it("uses built-in adapters on every work / review state", () => {
        for (const [stateName, block] of Object.entries(bundle.profile.states ?? {})) {
          const b = block as any;
          if (!ADAPTER_TYPES.has(b.type)) continue;
          expect(
            b.agent,
            `${bundle.name}.${stateName} (type=${b.type}) must declare a built-in agent`
          ).toBeDefined();
          expect(
            BUILTIN_AGENTS.has(b.agent),
            `${bundle.name}.${stateName} agent must be one of claude/codex/gemini/kiro, got ${b.agent}`
          ).toBe(true);
        }
      });

      it("declares only schema-owned fields on every state", () => {
        for (const [stateName, block] of Object.entries(bundle.profile.states ?? {})) {
          const result = TychonicConfigSchema.safeParse({
            version: "tychonic.config.v1",
            states: { [stateName]: block }
          });
          expect(result.success, `${bundle.name}.${stateName} carries an unknown state field`).toBe(true);
        }
      });

      it("only carries command on deterministic verify states", () => {
        for (const [stateName, block] of Object.entries(bundle.profile.states ?? {})) {
          const b = block as any;
          if (b.command !== undefined) {
            expect(
              ESCAPE_HATCH_TYPES.has(b.type),
              `${bundle.name}.${stateName} (type=${b.type}) declares command but is not a deterministic-script state`
            ).toBe(true);
          }
        }
      });

      it("declares non-negative integer resume only on adapter states", () => {
        for (const [stateName, block] of Object.entries(bundle.profile.states ?? {})) {
          const b = block as any;
          if (b.resume === undefined) continue;
          expect(
            ADAPTER_TYPES.has(b.type),
            `${bundle.name}.${stateName} declares resume on a non-adapter state`
          ).toBe(true);
          expect(Number.isInteger(b.resume)).toBe(true);
          expect(b.resume).toBeGreaterThanOrEqual(0);
        }
      });

      // gemini and kiro are partial review adapters: they need a
      // normalizer if a bundle pins them on a review state.
      it("never declares a partial adapter on a review state without normalizer", () => {
        for (const [stateName, block] of Object.entries(bundle.profile.states ?? {})) {
          const b = block as any;
          if (b.type !== "review") continue;
          if (b.normalizer !== undefined) continue;
          expect(
            b.agent,
            `${bundle.name}.${stateName} (review) must not use gemini or kiro`
          ).not.toBe("gemini");
          expect(
            b.agent,
            `${bundle.name}.${stateName} (review) must not use gemini or kiro`
          ).not.toBe("kiro");
        }
      });
    });
  }
});

// simpleWorkflow's worker state must declare a numeric resume cap because
// the bundle's runAutoContinueLoop reads it from `states.work.resume`.
describe("simpleWorkflow defaultProfile.states.work.resume", () => {
  it("declares a positive integer (the same-session resume cap)", () => {
    const work = (simpleDefault as any).states?.work;
    expect(work?.agent).toBe("claude");
    expect(work?.command).toBeUndefined();
    expect(typeof work?.resume).toBe("number");
    expect(Number.isInteger(work.resume)).toBe(true);
    expect(work.resume).toBeGreaterThan(0);
  });
});

describe("simpleWorkflow defaultProfile.states.verify.command", () => {
  it("uses generic npm verification scripts, not this repo's example validator", () => {
    const verify = (simpleDefault as any).states?.verify;
    expect(verify?.type).toBe("verify");
    expect(verify?.command).toContain("npm run typecheck");
    expect(verify?.command).toContain("npm run build");
    expect(verify?.command).toContain("npm test");
    expect(verify?.command).not.toContain("validate:examples");
  });
});

describe("Kiro-oriented example profiles", () => {
  it("uses Kiro as the primary QA reviewer with a normalizer in the normalized QA variant", () => {
    const qa = (architectKiroQaDefault as any).states?.qa;
    expect(qa).toMatchObject({
      type: "review",
      agent: "kiro",
      model: "claude-sonnet-4.5",
      normalizer: "codex",
      trust_all_tools: true
    });
  });

  it("keeps Kiro repair as prose work before a structured final QA gate", () => {
    const states = (architectKiroRepairQaDefault as any).states;
    expect(states?.kiro_pre_review).toMatchObject({
      type: "work",
      agent: "kiro",
      model: "claude-sonnet-4.5",
      trust_all_tools: true
    });
    expect(states?.kiro_fix).toMatchObject({
      type: "work",
      agent: "kiro",
      model: "claude-sonnet-4.5",
      trust_all_tools: true
    });
    expect(states?.final_qa).toMatchObject({
      type: "review",
      agent: "claude",
      model: "opus",
      reasoning_effort: "max"
    });
    expect(states?.final_qa?.normalizer).toBeUndefined();
  });
});
