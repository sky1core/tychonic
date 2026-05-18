import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TychonicConfigSchema } from "../src/catalog/types.js";
import { EXAMPLE_WORKFLOW_NAMES, loadExampleWorkflowSpec } from "./exampleYamlHelpers.js";

const BUILTIN_AGENTS = new Set(["claude", "codex", "gemini", "kiro"]);
const ADAPTER_TYPES = new Set(["work", "review"]);
const ESCAPE_HATCH_TYPES = new Set(["verify"]);

describe("example workflow.yaml profile shape", () => {
  for (const name of EXAMPLE_WORKFLOW_NAMES) {
    describe(name, () => {
      it("does not carry hand-written workflow.mjs source", () => {
        const workflowPath = join(process.cwd(), "examples", "workflows", name, "workflow.mjs");
        expect(existsSync(workflowPath), `${name} must author workflow.yaml, not workflow.mjs`).toBe(false);
      });

      it("validates the YAML-derived profile against the host schema", async () => {
        const spec = await loadExampleWorkflowSpec(name);
        const result = TychonicConfigSchema.safeParse(spec.profile);
        expect(result.success, JSON.stringify(result.error?.issues ?? null, null, 2)).toBe(true);
      });

      it("uses built-in adapters on every work / review state", async () => {
        const spec = await loadExampleWorkflowSpec(name);
        for (const [stateName, block] of Object.entries(spec.profile.states ?? {})) {
          if (!ADAPTER_TYPES.has(block.type)) continue;
          expect(block.agent, `${name}.${stateName} must declare a built-in agent`).toBeDefined();
          expect(
            BUILTIN_AGENTS.has(block.agent ?? ""),
            `${name}.${stateName} agent must be one of claude/codex/gemini/kiro, got ${block.agent}`
          ).toBe(true);
        }
      });

      it("only carries command on deterministic verify states", async () => {
        const spec = await loadExampleWorkflowSpec(name);
        for (const [stateName, block] of Object.entries(spec.profile.states ?? {})) {
          if (block.command === undefined) continue;
          expect(
            ESCAPE_HATCH_TYPES.has(block.type),
            `${name}.${stateName} declares command but is not a deterministic-script state`
          ).toBe(true);
        }
      });

      it("never declares a partial adapter on a review state without normalizer", async () => {
        const spec = await loadExampleWorkflowSpec(name);
        for (const [stateName, block] of Object.entries(spec.profile.states ?? {})) {
          if (block.type !== "review" || block.normalizer !== undefined) continue;
          expect(block.agent, `${name}.${stateName} must not use gemini or kiro without normalizer`).not.toBe("gemini");
          expect(block.agent, `${name}.${stateName} must not use gemini or kiro without normalizer`).not.toBe("kiro");
        }
      });
    });
  }
});
