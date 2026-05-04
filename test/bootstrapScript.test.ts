import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("tychonic bootstrap script CLI", () => {
  it("--help prints usage without running verification", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/tychonic-bootstrap-check.mjs", "--help"]);

    expect(stdout).toContain("Usage: node scripts/tychonic-bootstrap-check.mjs");
    expect(stdout).toContain("TYCHONIC_BOOTSTRAP_LIVE_SCOPE");
  });
});
