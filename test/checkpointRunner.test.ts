import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCheckpoint } from "../src/bootstrap/checkpointRunner.js";
import { defaultActivityTimeoutMs } from "../src/catalog/types.js";
import type { TychonicConfig } from "../src/catalog/types.js";

const execFileAsync = promisify(execFile);

describe("runCheckpoint", () => {
  it("runs deterministic named states and records the config snapshot", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-checkpoint-"));
    await writeFile(join(cwd, "package.json"), "{}", "utf8");
    const result = await runCheckpoint({
      cwd,
      profile: config({
        lint: { type: "lint", command: "node -e \"console.log('lint')\"" },
        unit_test: { type: "unit_test", command: "node -e \"console.log('unit')\"" }
      }),
      runId: "run_checkpoint",
      now: fixedNow
    });

    expect(result.run.states.find((step) => step.name === "lint")?.status).toBe("succeeded");
    expect(result.run.states.find((step) => step.name === "unit_test")?.status).toBe("succeeded");
    const snapshot = result.run.artifacts.find((artifact) => artifact.kind === "profile_snapshot");
    expect(snapshot).toBeDefined();
    if (snapshot) {
      expect(await readFile(join(cwd, ".tychonic", "runs", "run_checkpoint", "artifacts", "profile_snapshot.yaml"), "utf8"))
        .toContain("version: tychonic.config.v1");
    }
  });

  it("runs a configured structured semantic reviewer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-review-"));
    await createRepoWithSourceChange(cwd);
    const result = await runCheckpoint({
      cwd,
      profile: config({
        semantic_review: {
          type: "review",
          command:
            "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))\"",
          emits: ["tychonic.review.v1"]
        }
      }),
      runId: "run_review",
      now: fixedNow,
      autonomy: "review"
    });

    const reviewStep = result.run.states.find((step) => step.name === "semantic_review");
    expect(reviewStep?.status).toBe("succeeded");
    expect(result.run.agent_sessions[0]?.agent).toBe("review");
  });

  it("routes malformed structured review output to triage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-review-triage-"));
    await createRepoWithSourceChange(cwd);
    const result = await runCheckpoint({
      cwd,
      profile: config({
        semantic_review: {
          type: "review",
          command: "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok'}))\"",
          emits: ["tychonic.review.v1"]
        }
      }),
      runId: "run_review_triage",
      now: fixedNow,
      autonomy: "review"
    });

    const reviewStep = result.run.states.find((step) => step.name === "semantic_review");
    expect(reviewStep?.status).toBe("blocked");
    expect(result.run.inbox[0]?.detail).toMatch(/tychonic\.review\.v1/);
  });

  it("uses per-activity timeout from the activity block", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-timeout-"));
    const result = await runCheckpoint({
      cwd,
      profile: config({
        unit_test: { type: "unit_test", command: "node -e \"setTimeout(()=>{}, 50)\"", timeout: 1 }
      }),
      runId: "run_timeout",
      now: fixedNow
    });

    const unitStep = result.run.states.find((step) => step.name === "unit_test");
    const attempt = result.run.activity_attempts.find((item) => item.state_id === unitStep?.id);
    expect(unitStep?.status).toBe("timed_out");
    expect(attempt?.timeout_ms).toBe(1);
  });

  it("uses the per-type default timeout when an activity omits timeout", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-timeout-default-"));
    const result = await runCheckpoint({
      cwd,
      profile: config({
        lint: { type: "lint", command: "node -e \"console.log('lint')\"" }
      }),
      runId: "run_timeout_default",
      now: fixedNow
    });

    const lintStep = result.run.states.find((step) => step.name === "lint");
    const attempt = result.run.activity_attempts.find((item) => item.state_id === lintStep?.id);
    expect(lintStep?.status).toBe("succeeded");
    expect(attempt?.timeout_ms).toBe(defaultActivityTimeoutMs("lint"));
  });

  it("runs integration before semantic review when position is before_ai_review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-checkpoint-integration-before-"));
    await createRepoWithSourceAndTestChange(cwd);
    const result = await runCheckpoint({
      cwd,
      profile: config(
        {
          integration: { type: "integration", command: "node -e \"console.log('integration')\"" },
          semantic_review: {
            type: "review",
            command:
              "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'semantic ok',findings:[]}))\"",
            emits: ["tychonic.review.v1"]
          },
          test_review: {
            type: "review",
            command:
              "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'test ok',findings:[]}))\"",
            emits: ["tychonic.review.v1"]
          }
        },
        { integration: { mode: "required", position: "before_ai_review" } }
      ),
      runId: "run_integration_before_review",
      now: fixedNow,
      autonomy: "review"
    });

    expect(orderedWorkflowStates(result.run, ["integration", "semantic_review", "test_review"])).toEqual([
      "integration",
      "semantic_review",
      "test_review"
    ]);
  });

  it("runs integration after semantic review when position is after_ai_review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-checkpoint-integration-after-"));
    await createRepoWithSourceAndTestChange(cwd);
    const result = await runCheckpoint({
      cwd,
      profile: config(
        {
          integration: { type: "integration", command: "node -e \"console.log('integration')\"" },
          semantic_review: {
            type: "review",
            command:
              "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'semantic ok',findings:[]}))\"",
            emits: ["tychonic.review.v1"]
          },
          test_review: {
            type: "review",
            command:
              "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'test ok',findings:[]}))\"",
            emits: ["tychonic.review.v1"]
          }
        },
        { integration: { mode: "required", position: "after_ai_review" } }
      ),
      runId: "run_integration_after_review",
      now: fixedNow,
      autonomy: "review"
    });

    expect(orderedWorkflowStates(result.run, ["integration", "semantic_review", "test_review"])).toEqual([
      "semantic_review",
      "integration",
      "test_review"
    ]);
  });

  it("runs integration as the final gate when position is final_gate", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-checkpoint-integration-final-"));
    await createRepoWithSourceAndTestChange(cwd);
    const result = await runCheckpoint({
      cwd,
      profile: config(
        {
          integration: { type: "integration", command: "node -e \"console.log('integration')\"" },
          semantic_review: {
            type: "review",
            command:
              "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'semantic ok',findings:[]}))\"",
            emits: ["tychonic.review.v1"]
          },
          test_review: {
            type: "review",
            command:
              "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'test ok',findings:[]}))\"",
            emits: ["tychonic.review.v1"]
          }
        },
        { integration: { mode: "required", position: "final_gate" } }
      ),
      runId: "run_integration_final_gate",
      now: fixedNow,
      autonomy: "review"
    });

    expect(orderedWorkflowStates(result.run, ["integration", "semantic_review", "test_review"])).toEqual([
      "semantic_review",
      "test_review",
      "integration"
    ]);
  });
});

function config(
  states: NonNullable<TychonicConfig["states"]>,
  policies?: TychonicConfig["policies"]
): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states,
    ...(policies ? { policies } : {})
  };
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00Z");
}

async function createRepoWithSourceChange(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  await writeFile(join(cwd, "app.ts"), "export const x = 1;\n", "utf8");
  await execFileAsync("git", ["add", "app.ts"], { cwd });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Tychonic Test", "commit", "-m", "init"], { cwd });
  await writeFile(join(cwd, "app.ts"), "export const x = 2;\n", "utf8");
}

async function createRepoWithSourceAndTestChange(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  await writeFile(join(cwd, "app.ts"), "export const x = 1;\n", "utf8");
  await writeFile(join(cwd, "app.test.ts"), "import { describe, expect, it } from 'vitest';\n", "utf8");
  await execFileAsync("git", ["add", "app.ts", "app.test.ts"], { cwd });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Tychonic Test", "commit", "-m", "init"], { cwd });
  await writeFile(join(cwd, "app.ts"), "export const x = 2;\n", "utf8");
  await writeFile(join(cwd, "app.test.ts"), "import { describe, expect, it } from 'vitest';\nexport const changed = true;\n", "utf8");
}

function orderedWorkflowStates(
  run: import("../src/domain/types.js").WorkflowRunRecord,
  names: string[]
): string[] {
  const selected = new Set(names);
  return run.states.map((state) => state.name).filter((name) => selected.has(name));
}
