import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stoppedWorkflowMessage } from "../src/cli/waitMessages.js";

describe("documentation consistency", () => {
  it("keeps README success wait examples aligned with the CLI message", async () => {
    const message = stoppedWorkflowMessage({
      reason: "run_status",
      workflowId: "wf_123",
      status: "succeeded"
    });
    const example = `{ "ok": true, "message": ${JSON.stringify(message)}, "workflowId": "wf_123", "status": "succeeded" }`;

    await expect(readFile("README.md", "utf8")).resolves.toContain(example);
    await expect(readFile("README.ko.md", "utf8")).resolves.toContain(example);
  });

  it("documents that wait output does not carry the full raw run result", async () => {
    const spec = await readFile("SPEC.md", "utf8");

    expect(spec).toContain("The wait payload does not include the full raw run result.");
    expect(spec).not.toContain("`result` carries the full run result");
  });
});
