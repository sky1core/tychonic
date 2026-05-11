import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_EXAMPLE_WORKFLOWS,
  liveWorkflowNames
} from "../scripts/tychonic-bootstrap-check.mjs";

const execFileAsync = promisify(execFile);

describe("tychonic bootstrap script CLI", () => {
  it("--help prints usage without running verification", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/tychonic-bootstrap-check.mjs", "--help"]);

    expect(stdout).toContain("Usage: node scripts/tychonic-bootstrap-check.mjs");
    expect(stdout).toContain("TYCHONIC_BOOTSTRAP_LIVE_SCOPE");
  });

  it("references only packaged example workflow bundles that exist", async () => {
    for (const name of PACKAGED_EXAMPLE_WORKFLOWS) {
      await expect(access(join("examples", "workflows", name, "workflow.mjs"))).resolves.toBeUndefined();
    }
  });

  it("uses installed packaged workflows for live scopes", () => {
    for (const name of [...liveWorkflowNames("smoke"), ...liveWorkflowNames("examples")]) {
      expect(PACKAGED_EXAMPLE_WORKFLOWS).toContain(name);
    }
  });
});
