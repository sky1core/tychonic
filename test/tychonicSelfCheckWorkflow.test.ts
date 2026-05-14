import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectWorkflowBundleDirectory } from "../src/temporal/workflowModules.js";

describe("tychonic self-check developer workflow", () => {
  it("is a valid opt-in workflow bundle", async () => {
    const name = "tychonicSelfCheckWorkflow";
    const inspection = await inspectWorkflowBundleDirectory({
      name,
      sourcePath: join(process.cwd(), "tools", "workflows", name)
    });
    expect(inspection.workflowFunctionNames).toEqual([name]);
    expect(inspection.defaultProfile.states.bootstrap).toMatchObject({
      type: "verify",
      command: expect.stringContaining("scripts/tychonic-bootstrap-check.mjs")
    });
    expect(inspection.defaultProfile.states.bootstrap.command).not.toContain("npm install");
  });
});
