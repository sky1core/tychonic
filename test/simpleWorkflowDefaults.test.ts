import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runSimpleWorkflow, runSimpleWorkflowContinuation } from "../src/bootstrap/simpleWorkflowRunner.js";
import { resolveSimpleWorkflowCliOptions } from "../src/cli/simpleWorkflowCliOptions.js";
import { resolveEffectiveBundleConfig } from "../src/catalog/bundleConfig.js";
import { continuationDefaultsFromWorkflowInput } from "../src/workflows/simpleWorkflow.js";

const execFileAsync = promisify(execFile);

describe("simple_workflow loop continuation defaults", () => {
  it("continues with workflow-start config after the bundle config mutates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-immutable-continuation-"));
    await execFileAsync("git", ["init"], { cwd });
    const bundleDir = join(cwd, "bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "config.yaml"),
      [
        "version: tychonic.config.v1",
        "states:",
        "  work:",
        "    type: work",
        "    command: node initial-worker.js",
        "  verify:",
        "    type: verify",
        "    command: node verify-start.js",
        "  review:",
        "    type: review",
        "    command: node reviewer-start.js",
        "    emits:",
        "      - tychonic.review.v1",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "initial-worker.js"),
      "require('fs').writeFileSync('verify-mode.txt', 'start')\n",
      "utf8"
    );
    await writeFile(
      join(cwd, "fresh-worker.js"),
      "require('fs').writeFileSync('final.txt', 'done')\n",
      "utf8"
    );
    await writeFile(
      join(cwd, "verify-start.js"),
      "const fs=require('fs'); process.exit(fs.readFileSync('verify-mode.txt','utf8') === 'start' ? 0 : 1)\n",
      "utf8"
    );
    await writeFile(
      join(cwd, "reviewer-start.js"),
      [
        "const fs=require('fs');",
        "if (fs.existsSync('final.txt')) {",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'done',findings:[]}));",
        "} else {",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'missing final',findings:[{severity:'high',title:'Missing final',detail:'Create final.txt',target:'final.txt'}]}));",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const effective = await resolveEffectiveBundleConfig({ bundleDir });
    const startInput = resolveSimpleWorkflowCliOptions({ cwd, profile: effective.profile });
    const waiting = await runSimpleWorkflow({
      ...startInput,
      profile: effective.profile,
      runId: "immutable_continuation",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const triageItem = waiting.run.inbox.find((item) => item.status === "open" && item.action.kind === "triage");
    expect(waiting.run.status).toBe("waiting_user");
    if (!triageItem) {
      throw new Error("triage item missing");
    }

    // Mutate the bundle's config.yaml after workflow start. The continuation
    // must still use the snapshot captured at start.
    await writeFile(
      join(bundleDir, "config.yaml"),
      [
        "version: tychonic.config.v1",
        "states:",
        "  work:",
        "    type: work",
        "    command: node initial-worker.js",
        "  verify:",
        "    type: verify",
        "    command: node -e \"process.exit(42)\"",
        "  review:",
        "    type: review",
        "    command: node -e \"process.exit(43)\"",
        "    emits:",
        "      - tychonic.review.v1",
        ""
      ].join("\n"),
      "utf8"
    );

    const continuationSignal = {
      inboxItemId: triageItem.id,
      command: "node fresh-worker.js",
      agent: "fresh-worker"
    };
    const continuationDefaults = continuationDefaultsFromWorkflowInput(startInput, continuationSignal);
    const continuationInput = {
      ...continuationDefaults,
      ...continuationSignal
    };
    if (!continuationInput.verifyCommand) {
      throw new Error("verify command default missing");
    }
    const result = await runSimpleWorkflowContinuation({
      cwd,
      run: waiting.run,
      worktreePath: waiting.worktreePath,
      ...continuationInput,
      verifyCommand: continuationInput.verifyCommand,
      commandTimeoutMs: 10_000,
      env: process.env,
      now: () => new Date("2026-04-19T00:00:01.000Z")
    });

    expect(result.run.status).toBe("succeeded");
    const snapshot = waiting.run.artifacts.find((artifact) => artifact.kind === "profile_snapshot");
    if (!snapshot) {
      throw new Error("profile snapshot missing");
    }
    await expect(readFile(join(cwd, snapshot.path), "utf8")).resolves.toContain("node verify-start.js");
    const commands = result.run.activity_attempts.map((attempt) => attempt.command ?? "");
    expect(commands).toContain("node verify-start.js");
    expect(commands).toContain("node reviewer-start.js");
    expect(commands.join("\n")).not.toContain("process.exit(42)");
    expect(commands.join("\n")).not.toContain("process.exit(43)");
  });

  it("lets explicit continuation signal selectors override workflow start defaults", () => {
    const defaults = continuationDefaultsFromWorkflowInput(
      {
        cwd: "/repo",
        verifyCommand: "npm test",
        workerCandidates: [{ agent: "start-worker", command: "node worker.js" }],
        reviewCandidates: [{ agent: "start-reviewer", command: "node review.js" }]
      },
      {
        inboxItemId: "inbox_1",
        verifyCommand: "npm run explicit",
        workerCandidates: [{ agent: "signal-worker", command: "node signal-worker.js" }],
        reviewCandidates: [{ agent: "signal-reviewer", command: "node signal-review.js" }]
      }
    );

    expect(defaults.verifyCommand).toBeUndefined();
    expect(defaults.workerCandidates).toBeUndefined();
    expect(defaults.reviewCandidates).toBeUndefined();
  });
});
