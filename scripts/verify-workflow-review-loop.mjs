#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const cli = join(repoRoot, "dist", "cli", "main.js");

const root = await mkdtemp(join(tmpdir(), "tychonic-review-loop-smoke-"));
const home = join(root, "home");
const stateHome = join(root, "state");
const logHome = join(root, "logs");
const target = join(root, "target");
const instance = await makeInstanceName("rl");
const webPort = await findFreePort();
const env = {
  ...process.env,
  HOME: home,
  TYCHONIC_STATE_HOME: stateHome,
  TYCHONIC_LOG_HOME: logHome,
  TYCHONIC_INSTANCE: instance
};

let runtimeStarted = false;

try {
  await mkdir(target, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await mkdir(logHome, { recursive: true });
  await initializeTargetRepo();

  const finalInput = join(root, "final-input.json");
  const firstInput = join(root, "first-input.json");
  const finalConfig = join(root, "final-config.yaml");
  const firstConfig = join(root, "first-config.yaml");
  const capConfig = join(root, "final-cap-config.yaml");

  await writeJson(finalInput, { cwd: target, goal: "verify final QA loop" });
  await writeJson(firstInput, { cwd: target, goal: "verify first review and final QA loop" });
  await writeFile(finalConfig, finalQaLoopConfig(), "utf8");
  await writeFile(firstConfig, firstReviewAndFinalQaLoopConfig(), "utf8");
  await writeFile(capConfig, finalQaCapConfig(), "utf8");
  const yamlReviewFeedbackBundle = await makeYamlReviewFeedbackWorkflowBundle();
  const yamlReviewInfrastructureFailureBundle = await makeYamlReviewInfrastructureFailureWorkflowBundle();

  await installWorkflow("architectBuilderQaWorkflow");
  await installWorkflow("architectBuilderFinalQaWorkflow");
  await installWorkflow("architectBuilderFirstReviewQaWorkflow");
  await installWorkflowSource(yamlReviewFeedbackBundle);
  await installWorkflowSource(yamlReviewInfrastructureFailureBundle);
  await runCli(["runtime", "up", "--detach", "--web-port", String(webPort)], { timeout: 60_000 });
  runtimeStarted = true;
  await waitForRuntime();

  const architectBuilderQaRun = await runWorkflow("architectBuilderQaWorkflow", finalInput, finalConfig, "succeeded");
  const architectBuilderQaStatus = await status(architectBuilderQaRun.workflowId);
  assertCount(architectBuilderQaStatus, "states", 5);
  assertCount(architectBuilderQaStatus, "attempts", 5);
  assertCount(architectBuilderQaStatus, "findings", 1);
  const architectBuilderQaPrompts = artifactsByKind(architectBuilderQaStatus, "builder_prompt");
  assertEqual(architectBuilderQaPrompts.length, 2, "architectBuilderQaWorkflow should run builder twice");
  const architectBuilderQaSecondPrompt = await artifact(
    architectBuilderQaRun.workflowId,
    architectBuilderQaPrompts[1].id
  );
  assertIncludes(
    architectBuilderQaSecondPrompt,
    "qa review did not pass.",
    "architectBuilderQaWorkflow QA failure summary should reach the second builder prompt"
  );
  assertIncludes(
    architectBuilderQaSecondPrompt,
    "[high] Needs second builder attempt: Builder must receive QA feedback and run again.",
    "architectBuilderQaWorkflow structured finding should reach the second builder prompt"
  );

  const finalRun = await runWorkflow("architectBuilderFinalQaWorkflow", finalInput, finalConfig, "succeeded");
  const finalStatus = await status(finalRun.workflowId);
  assertCount(finalStatus, "states", 5);
  assertCount(finalStatus, "attempts", 5);
  assertCount(finalStatus, "findings", 1);
  const finalBuilderPrompts = artifactsByKind(finalStatus, "builder_prompt");
  assertEqual(finalBuilderPrompts.length, 2, "final QA workflow should run builder twice");
  const finalSecondBuilderPrompt = await artifact(finalRun.workflowId, finalBuilderPrompts[1].id);
  assertIncludes(
    finalSecondBuilderPrompt,
    "qa review did not pass.",
    "final QA failure summary should reach the second builder prompt"
  );
  assertIncludes(
    finalSecondBuilderPrompt,
    "[high] Needs second builder attempt: Builder must receive QA feedback and run again.",
    "final QA structured finding should reach the second builder prompt"
  );

  const firstRun = await runWorkflow(
    "architectBuilderFirstReviewQaWorkflow",
    firstInput,
    firstConfig,
    "succeeded"
  );
  const firstStatus = await status(firstRun.workflowId);
  assertCount(firstStatus, "states", 9);
  assertCount(firstStatus, "attempts", 9);
  assertCount(firstStatus, "findings", 2);
  const firstBuilderPrompts = artifactsByKind(firstStatus, "builder_prompt");
  assertEqual(firstBuilderPrompts.length, 3, "first-review workflow should run builder three times");
  const firstSecondBuilderPrompt = await artifact(firstRun.workflowId, firstBuilderPrompts[1].id);
  assertIncludes(
    firstSecondBuilderPrompt,
    "first_review review did not pass.",
    "first_review failure summary should reach the second builder prompt"
  );
  assertIncludes(
    firstSecondBuilderPrompt,
    "[medium] First review requires builder rerun: Builder must rerun after first_review feedback.",
    "first_review structured finding should reach the second builder prompt"
  );
  const firstThirdBuilderPrompt = await artifact(firstRun.workflowId, firstBuilderPrompts[2].id);
  assertIncludes(
    firstThirdBuilderPrompt,
    "first_review review did not pass.",
    "first_review failure summary should remain visible on the third builder prompt"
  );
  assertIncludes(
    firstThirdBuilderPrompt,
    "[medium] First review requires builder rerun: Builder must rerun after first_review feedback.",
    "first_review finding should remain visible on the third builder prompt"
  );
  assertIncludes(
    firstThirdBuilderPrompt,
    "final_qa review did not pass.",
    "final_qa failure summary should reach the third builder prompt"
  );
  assertIncludes(
    firstThirdBuilderPrompt,
    "[high] Final QA requires another builder rerun: Builder must rerun after final_qa feedback.",
    "final_qa structured finding should reach the third builder prompt"
  );

  const yamlRun = await runWorkflow("yamlReviewFeedbackWorkflow", finalInput, undefined, "succeeded");
  const yamlStatus = await status(yamlRun.workflowId);
  assertCount(yamlStatus, "states", 4);
  assertCount(yamlStatus, "attempts", 4);
  assertCount(yamlStatus, "findings", 1);
  const yamlWorkPrompts = artifactsByKind(yamlStatus, "work_prompt");
  assertEqual(yamlWorkPrompts.length, 2, "YAML workflow should run work twice after review feedback");
  const yamlSecondWorkPrompt = await artifact(yamlRun.workflowId, yamlWorkPrompts[1].id);
  assertIncludes(
    yamlSecondWorkPrompt,
    "review review did not pass.",
    "YAML generated workflow should include the failing review state in returned feedback"
  );
  assertIncludes(
    yamlSecondWorkPrompt,
    "[high] Missing generated marker: Work must create generated-marker.txt after review feedback.",
    "YAML generated workflow should pass structured review findings back to work prompt"
  );

  const infraRun = await runWorkflow("yamlReviewInfrastructureFailureWorkflow", finalInput, undefined, "waiting_user");
  const infraStatus = await status(infraRun.workflowId);
  assertEqual(
    infraStatus.evidence?.summary,
    "review review infrastructure failed: reviewer command did not succeed",
    "review infrastructure failure summary mismatch"
  );
  assertCount(infraStatus, "states", 2);
  assertCount(infraStatus, "attempts", 2);
  assertCount(infraStatus, "findings", 0);
  assertCount(infraStatus, "inbox", 1);
  assertEqual(
    artifactsByKind(infraStatus, "work_prompt").length,
    1,
    "review infrastructure failure must not rerun the work state as semantic remediation"
  );

  const capWorkflowName = "architectBuilderFinalQaWorkflow";
  const capMaxSteps = await loadExampleWorkflowMaxSteps(capWorkflowName);
  const capRun = await runWorkflow(capWorkflowName, finalInput, capConfig, "waiting_user");
  const capStatus = await status(capRun.workflowId);
  assertEqual(
    capStatus.evidence?.summary,
    `declarative workflow ${capWorkflowName} exceeded max_steps (${capMaxSteps})`,
    "cap summary mismatch"
  );
  assertCount(capStatus, "states", capMaxSteps);
  assertCount(capStatus, "attempts", capMaxSteps);
  assertAtLeast(capStatus.evidence?.counts?.findings ?? 0, 1, "cap run should keep review findings visible");
  assertCount(capStatus, "inbox", 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        instance,
        workflows: {
          architectBuilderQaWorkflow: architectBuilderQaRun.workflowId,
          architectBuilderFinalQaWorkflow: finalRun.workflowId,
          architectBuilderFirstReviewQaWorkflow: firstRun.workflowId,
          yamlReviewFeedbackWorkflow: yamlRun.workflowId,
          yamlReviewInfrastructureFailureWorkflow: infraRun.workflowId,
          reviewCap: capRun.workflowId
        }
      },
      null,
      2
    )
  );
} finally {
  if (runtimeStarted) {
    const stopResult = await runCli(["runtime", "stop"], { allowFailure: true, timeout: 30_000 });
    if (stopResult.status !== 0) {
      console.error(
        [
          `failed to stop review-loop smoke runtime instance ${instance}`,
          `temporary root retained for cleanup: ${root}`,
          stopResult.stderr,
          stopResult.stdout
        ].filter(Boolean).join("\n")
      );
      throw new Error(`failed to stop review-loop smoke runtime instance ${instance}; temporary root retained at ${root}`);
    }
  }
  await rm(root, { recursive: true, force: true });
}

async function initializeTargetRepo() {
  await execFileAsync("git", ["init", "-q"], { cwd: target, env });
  await execFileAsync("git", ["config", "user.name", "Tychonic Smoke"], { cwd: target, env });
  await execFileAsync("git", ["config", "user.email", "tychonic-smoke@example.invalid"], { cwd: target, env });
  await writeFile(join(target, "README.md"), "baseline\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: target, env });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: target, env });
}

async function installWorkflow(name) {
  await installWorkflowSource(join("examples", "workflows", name));
}

async function installWorkflowSource(sourcePath) {
  await runCli(["workflows", "install", sourcePath]);
}

async function loadExampleWorkflowMaxSteps(name) {
  const { parseDeclarativeWorkflowSpecYaml } = await import("../dist/declarative/workflowSpec.js");
  const source = await readFile(join(repoRoot, "examples", "workflows", name, "workflow.yaml"), "utf8");
  const spec = parseDeclarativeWorkflowSpecYaml({ bundleName: name, source });
  if (!Number.isInteger(spec.max_steps) || spec.max_steps < 1) {
    throw new Error(`${name} must declare a positive integer max_steps`);
  }
  return spec.max_steps;
}

async function waitForRuntime() {
  for (let i = 0; i < 60; i += 1) {
    const result = await runCli(["status"], { allowFailure: true, timeout: 5_000 });
    if (result.status === 0) return;
    await delay(1_000);
  }
  throw new Error(`runtime instance ${instance} did not become ready`);
}

async function runWorkflow(name, inputFile, configFile, expectedStatus) {
  const args = ["run", name, "--input-file", inputFile];
  if (configFile !== undefined) {
    args.push("--config", configFile);
  }
  args.push("--wait");
  const result = await runCli(args, { timeout: 60_000 });
  const parsed = parseJson(result.stdout, `run ${name}`);
  assertEqual(parsed.status, expectedStatus, `${name} status mismatch`);
  return parsed;
}

async function status(workflowId) {
  const result = await runCli(["status", "--workflow-id", workflowId], { timeout: 15_000 });
  return parseJson(result.stdout, `status ${workflowId}`);
}

async function artifact(workflowId, artifactId) {
  const result = await runCli(["artifacts", "--workflow-id", workflowId, "--artifact", artifactId], {
    timeout: 15_000
  });
  return result.stdout;
}

async function runCli(args, options = {}) {
  const result = await execFileAsync(process.execPath, [cli, "--instance", instance, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 30_000
  }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (error) => ({
      status: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message
    })
  );
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`tychonic ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

async function makeInstanceName(prefix) {
  const { deriveInstancePort } = await import("../dist/runtime/instance.js");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const unique = `${process.pid.toString(36)}${Date.now().toString(36).slice(-8)}${attempt.toString(36)}`;
    const name = `${prefix}${unique}`.slice(0, 32);
    if (await portIsFree(deriveInstancePort(name))) return name;
  }
  throw new Error(`failed to find a free Temporal API port for ${prefix} review-loop smoke`);
}

async function portIsFree(port) {
  const { createServer } = await import("node:net");
  const server = createServer();
  return await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function artifactsByKind(statusResult, kind) {
  return (statusResult.evidence?.artifacts ?? []).filter((entry) => entry.kind === kind);
}

function assertCount(statusResult, key, expected) {
  assertEqual(statusResult.evidence?.counts?.[key], expected, `expected ${key} count ${expected}`);
}

function assertAtLeast(actual, min, message) {
  if (actual < min) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, expected at least ${JSON.stringify(min)}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)} in:\n${value}`);
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} did not print JSON:\n${value}`);
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeYamlReviewFeedbackWorkflowBundle() {
  const bundleDir = join(root, "yamlReviewFeedbackWorkflow");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "README.md"), "# yamlReviewFeedbackWorkflow\n", "utf8");
  await writeFile(
    join(bundleDir, "workflow.yaml"),
    `version: tychonic.workflow.v1
name: yamlReviewFeedbackWorkflow
worktree: true
max_steps: 5
start: work
states:
  work:
    type: work
    command: |
      n=$(cat work-attempts.txt 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > work-attempts.txt
      prompt=$(cat)
      printf '%s\\n' "$prompt" > "prompt-$n.txt"
      case "$prompt" in
        *"Missing generated marker"*) printf 'fixed\\n' > generated-marker.txt ;;
      esac
    prompt: |
      Create the generated marker only when review feedback asks for it.
    on_pass:
      goto: review
    on_fail:
      finish: work failed
  review:
    type: review
    on_fail_return_to: work
    command: |
      if [ -f generated-marker.txt ]; then
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"pass","summary":"marker exists","findings":[]}'
      else
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"fail","summary":"marker missing","findings":[{"severity":"high","title":"Missing generated marker","detail":"Work must create generated-marker.txt after review feedback."}]}'
      fi
    prompt: |
      Review whether generated-marker.txt exists.
    on_pass:
      finish: true
    on_fail:
      goto: work
`,
    "utf8"
  );
  return bundleDir;
}

async function makeYamlReviewInfrastructureFailureWorkflowBundle() {
  const bundleDir = join(root, "yamlReviewInfrastructureFailureWorkflow");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "README.md"), "# yamlReviewInfrastructureFailureWorkflow\n", "utf8");
  await writeFile(
    join(bundleDir, "workflow.yaml"),
    `version: tychonic.workflow.v1
name: yamlReviewInfrastructureFailureWorkflow
worktree: true
max_steps: 4
start: work
states:
  work:
    type: work
    command: |
      n=$(cat work-attempts.txt 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > work-attempts.txt
    prompt: |
      Do work once.
    on_pass:
      goto: review
    on_fail:
      finish: work failed
  review:
    type: review
    on_fail_return_to: work
    command: |
      printf 'not json\\n'
      exit 40
    prompt: |
      Review should fail as infrastructure.
    on_pass:
      finish: true
    on_fail:
      goto: work
`,
    "utf8"
  );
  return bundleDir;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finalQaLoopConfig() {
  return `version: tychonic.config.v1
states:
  architect:
    type: work
    command: |
      printf 'plan\\n' > plan.txt
  builder:
    type: work
    command: |
      n=$(cat builder-attempts.txt 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > builder-attempts.txt
      printf 'builder attempt %s\\n' "$n" >> implementation.txt
  qa:
    type: review
    on_fail_return_to: builder
    command: |
      n=$(cat builder-attempts.txt 2>/dev/null || echo 0)
      if [ "$n" -lt 2 ]; then
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"fail","summary":"qa failed before second builder attempt","findings":[{"severity":"high","title":"Needs second builder attempt","detail":"Builder must receive QA feedback and run again."}]}'
      else
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"pass","summary":"qa passed after builder rerun","findings":[]}'
      fi
`;
}

function firstReviewAndFinalQaLoopConfig() {
  return `version: tychonic.config.v1
states:
  architect:
    type: work
    command: |
      printf 'plan\\n' > plan.txt
  builder:
    type: work
    command: |
      n=$(cat builder-attempts.txt 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > builder-attempts.txt
      printf 'builder attempt %s\\n' "$n" >> implementation.txt
  first_review:
    type: review
    on_fail_return_to: builder
    command: |
      n=$(cat builder-attempts.txt 2>/dev/null || echo 0)
      if [ "$n" -lt 2 ]; then
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"fail","summary":"first review failed before second builder attempt","findings":[{"severity":"medium","title":"First review requires builder rerun","detail":"Builder must rerun after first_review feedback."}]}'
      else
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"pass","summary":"first review passed","findings":[]}'
      fi
  final_qa:
    type: review
    on_fail_return_to: builder
    command: |
      n=$(cat builder-attempts.txt 2>/dev/null || echo 0)
      if [ "$n" -lt 3 ]; then
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"fail","summary":"final qa failed before third builder attempt","findings":[{"severity":"high","title":"Final QA requires another builder rerun","detail":"Builder must rerun after final_qa feedback."}]}'
      else
        printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"pass","summary":"final qa passed after third builder attempt","findings":[]}'
      fi
`;
}

function finalQaCapConfig() {
  return `version: tychonic.config.v1
states:
  architect:
    type: work
    command: |
      printf 'plan\\n' > plan.txt
  builder:
    type: work
    command: |
      n=$(cat builder-attempts.txt 2>/dev/null || echo 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > builder-attempts.txt
      printf 'builder attempt %s\\n' "$n" >> implementation.txt
  qa:
    type: review
    on_fail_return_to: builder
    command: |
      printf '%s\\n' '{"schema_version":"tychonic.review.v1","status":"fail","summary":"qa still failing","findings":[{"severity":"high","title":"Persistent QA failure","detail":"This failure is intentional for cap verification."}]}'
`;
}
