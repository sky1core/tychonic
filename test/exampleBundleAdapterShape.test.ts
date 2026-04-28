import { describe, expect, it } from "vitest";

// Step 4 contract: every example bundle's `defaultProfile` worker / review
// state runs through a built-in adapter (`agent: "<name>"`), not through a
// hand-rolled `command` / `resume_command`. The deterministic `verify` type
// is the legitimate escape-hatch path and keeps `command`.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import { defaultProfile as simpleDefault } from "../examples/workflows/simpleWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as selfRepairDefault } from "../examples/workflows/selfRepairWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as checkpointDefault } from "../examples/workflows/checkpointWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as pipelineDefault } from "../examples/workflows/pipelineWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as architectDefault } from "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs";

import { TychonicConfigSchema } from "../src/catalog/types.js";

const BUILTIN_AGENTS = new Set(["claude", "codex", "gemini", "kiro", "kiro-acp"]);
const ADAPTER_TYPES = new Set(["work", "review"]);
const ESCAPE_HATCH_TYPES = new Set(["verify"]);

interface Bundle {
  name: string;
  profile: any;
}

const BUNDLES: readonly Bundle[] = [
  { name: "simpleWorkflow", profile: simpleDefault },
  { name: "selfRepairWorkflow", profile: selfRepairDefault },
  { name: "checkpointWorkflow", profile: checkpointDefault },
  { name: "pipelineWorkflow", profile: pipelineDefault },
  { name: "architectBuilderQaWorkflow", profile: architectDefault }
];

describe("example bundle defaultProfile shape (Step 4 flip)", () => {
  for (const bundle of BUNDLES) {
    describe(bundle.name, () => {
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
            `${bundle.name}.${stateName} agent must be one of claude/codex/gemini/kiro/kiro-acp, got ${b.agent}`
          ).toBe(true);
        }
      });

      it("never declares resume_command on any state", () => {
        for (const [stateName, block] of Object.entries(bundle.profile.states ?? {})) {
          const b = block as any;
          expect(
            b.resume_command,
            `${bundle.name}.${stateName} must not declare resume_command`
          ).toBeUndefined();
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

      // gemini, kiro, and kiro-acp are partial review adapters: they need a
      // normalizer if a bundle pins them on a review state.
      it("never declares a partial adapter on a review state without normalizer", () => {
        for (const [stateName, block] of Object.entries(bundle.profile.states ?? {})) {
          const b = block as any;
          if (b.type !== "review") continue;
          if (b.normalizer !== undefined) continue;
          expect(
            b.agent,
            `${bundle.name}.${stateName} (review) must not use gemini, kiro, or kiro-acp`
          ).not.toBe("gemini");
          expect(
            b.agent,
            `${bundle.name}.${stateName} (review) must not use gemini, kiro, or kiro-acp`
          ).not.toBe("kiro");
          expect(
            b.agent,
            `${bundle.name}.${stateName} (review) must not use gemini, kiro, or kiro-acp`
          ).not.toBe("kiro-acp");
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
