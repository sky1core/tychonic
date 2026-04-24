import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checkProjectGuardrails } from "../src/guardrails/checker.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function createViolatingProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tychonic-guardrails-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "src", "catalog"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Tychonic\n", "utf8");
  await writeFile(join(root, "SPEC.md"), "Tychonic\n", "utf8");
  await writeFile(join(root, "docs", "runtime.md"), `${["Re", "state"].join("")} is not allowed here.\n`, "utf8");
  await writeFile(join(root, "src", "store.ts"), `export const name = '${["File", "Run", "Store"].join("")}';\n`, "utf8");
  await writeFile(join(root, "src", "catalog", "schema.ts"), "schema.passthrough();\n", "utf8");
  await writeFile(join(root, "go.mod"), "module example\n", "utf8");
  return root;
}

describe("project guardrails", () => {
  it("keeps the active project inside the shared guardrail rules", async () => {
    const result = await checkProjectGuardrails({ root: projectRoot });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.rules.map((rule) => rule.id)).toEqual([
      "active-product-path-typescript-only",
      "active-docs-no-removed-runtime-alternatives",
      "product-code-no-repo-workflow-state-store",
      "root-docs-source-of-truth",
      "config-schema-strictly-typed",
      "config-shape-states-only",
      "no-profile-file-type",
      "release-verify-not-weakened"
    ]);
  });

  it("reports the current guardrail classes from the shared checker", async () => {
    const root = await createViolatingProject();
    const result = await checkProjectGuardrails({ root });

    expect(result.ok).toBe(false);
    expect(new Set(result.violations.map((violation) => violation.rule_id))).toEqual(
      new Set([
        "active-product-path-typescript-only",
        "active-docs-no-removed-runtime-alternatives",
        "product-code-no-repo-workflow-state-store",
        "root-docs-source-of-truth",
        "config-schema-strictly-typed"
      ])
    );
  });

  it("exposes the shared checker through the guardrails CLI as JSON", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "guardrails", "--cwd", projectRoot],
      { cwd: projectRoot, encoding: "utf8" }
    );
    const parsed = JSON.parse(stdout) as { ok: boolean; violations: unknown[] };

    expect(parsed.ok).toBe(true);
    expect(parsed.violations).toEqual([]);
  }, 15000);

  it("returns failing JSON from the guardrails CLI when violations exist", async () => {
    const root = await createViolatingProject();

    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", cliPath, "guardrails", "--cwd", root], {
        cwd: projectRoot,
        encoding: "utf8"
      })
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"ok": false')
    });
  });
});
