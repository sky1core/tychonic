#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const liveScope = resolveLiveScope();
const verbose = process.env.TYCHONIC_BOOTSTRAP_VERBOSE === "1";

const results = [];

await runStep("repo verify", "npm", ["run", "verify"], { cwd: repoRoot });
await runStep("install local package", "npm", ["run", "install:local"], { cwd: repoRoot });
await runStep("secret scan", "gitleaks", ["git", "--no-banner", "--redact", "."], { cwd: repoRoot });
await runStep("diff whitespace", "git", ["diff", "--check"], { cwd: repoRoot });
await runPackagedExampleRuntimeSmoke();
if (liveScope !== "none") {
  await runLiveExampleWorkflows(liveScope);
}
await runDocumentationChecks();

console.log(JSON.stringify({ ok: true, results }, null, 2));

async function runPackagedExampleRuntimeSmoke() {
  const target = await createFixtureRepo("tychonic-bootstrap-runtime-target-");
  const inputFile = join(await mkdtemp(join(tmpdir(), "tychonic-bootstrap-input-")), "verifyOnlyWorkflow.json");
  await writeJson(inputFile, { cwd: target });
  const instance = await makeInstanceName("brt");
  await installAllPackagedExamples(instance);
  try {
    await runStep("runtime smoke up", "tychonic", ["--instance", instance, "runtime", "up", "--detach"], { cwd: repoRoot });
    await waitForRuntime(instance);
    await runWorkflow(instance, "verifyOnlyWorkflow", inputFile, "succeeded");
  } finally {
    await runStep("runtime smoke stop", "tychonic", ["--instance", instance, "runtime", "stop"], {
      cwd: repoRoot,
      allowFailure: true
    });
  }
}

async function runLiveExampleWorkflows(scope) {
  const target = await createFixtureRepo("tychonic-bootstrap-live-target-");
  const inputDir = await mkdtemp(join(tmpdir(), "tychonic-bootstrap-live-inputs-"));
  const prompt =
    "This is a Tychonic bootstrap workflow mechanics check against a small, passing JavaScript fixture. " +
    "Do not edit files for this check. Report your result in the final agent output only; Tychonic captures that output as an artifact. " +
    "Do not create RESULT.md or any other repository file.";
  const review =
    "Review this as a Tychonic bootstrap workflow mechanics check. Report actionable defects only when " +
    "the fixture or workflow result is actually broken. Do not request broad fixture hardening beyond " +
    "the current add() contract, script gates, and workflow smoke purpose. Do not fail this fixture for " +
    "missing coverage tooling, TypeScript support, or production-grade secret scanning beyond the fixture gate; " +
    "the bootstrap script runs the release secret scanner separately.";
  const inputs = {
    verifyOnlyWorkflow: { cwd: target },
    simpleWorkflow: { cwd: target, goal: prompt, autoContinue: false, maxIterations: 1 },
    pipelineWorkflow: { cwd: target, goal: prompt, prompt, reviewPrompt: review, reviewPrompt2: review },
    checkpointWorkflow: { cwd: target, goal: review },
    architectBuilderQaWorkflow: {
      cwd: target,
      goal: prompt,
      architectPrompt: "Produce a concise implementation plan for the already-passing JavaScript fixture. Do not edit files.",
      builderPrompt: prompt,
      qaPrompt: review
    },
    architectBuilderKiroQaWorkflow: {
      cwd: target,
      goal: prompt,
      architectPrompt: "Produce a concise implementation plan for the already-passing JavaScript fixture. Do not edit files.",
      builderPrompt: prompt,
      qaPrompt: review
    },
    architectBuilderKiroRepairQaWorkflow: {
      cwd: target,
      goal: prompt,
      architectPrompt: "Produce a concise implementation plan for the already-passing JavaScript fixture. Do not edit files.",
      builderPrompt: prompt,
      kiroPreReviewPrompt: "Inspect the worktree and write concise prose feedback for this bootstrap mechanics check.",
      kiroFixPrompt: "Apply only necessary fixes from the pre-review. If no fix is needed, report that in the final output only.",
      finalQaPrompt: review
    }
  };
  for (const [name, input] of Object.entries(inputs)) {
    await writeJson(join(inputDir, `${name}.json`), input);
  }

  const workflowNames = liveWorkflowNames(scope);
  results.push({ name: "live examples scope", status: "selected", scope, workflows: workflowNames });

  const instance = await makeInstanceName("blv");
  await installAllPackagedExamples(instance);
  try {
    await runStep("live examples runtime up", "tychonic", ["--instance", instance, "runtime", "up", "--detach"], {
      cwd: repoRoot
    });
    await waitForRuntime(instance);
    for (const name of workflowNames) {
      await runWorkflow(instance, name, join(inputDir, `${name}.json`), "succeeded");
    }
  } finally {
    await runStep("live examples runtime stop", "tychonic", ["--instance", instance, "runtime", "stop"], {
      cwd: repoRoot,
      allowFailure: true
    });
  }
}

async function installAllPackagedExamples(instance) {
  const npmRoot = (await run("npm", ["root", "-g"], { cwd: repoRoot })).stdout.trim();
  const examplesDir = join(npmRoot, "tychonic", "examples", "workflows");
  for (const name of [
    "verifyOnlyWorkflow",
    "simpleWorkflow",
    "pipelineWorkflow",
    "checkpointWorkflow",
    "architectBuilderQaWorkflow",
    "architectBuilderKiroQaWorkflow",
    "architectBuilderKiroRepairQaWorkflow"
  ]) {
    await runStep(`install ${name}`, "tychonic", ["--instance", instance, "workflows", "install", join(examplesDir, name)], {
      cwd: repoRoot
    });
  }
}

async function runDocumentationChecks() {
  await runStep("documentation consistency", "npx", [
    "vitest",
    "run",
    "test/documentationConsistency.test.ts",
    "test/readmeCommands.test.ts",
    "test/waitMessages.test.ts"
  ], { cwd: repoRoot });
}

async function runWorkflow(instance, name, inputFile, expectedStatus) {
  const result = await runStep(`run ${name}`, "tychonic", [
    "--instance",
    instance,
    "run",
    name,
    "--input-file",
    inputFile,
    "--wait"
  ], { cwd: repoRoot });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`workflow ${name} did not print JSON output: ${result.stdout}`);
  }
  if (parsed.status !== expectedStatus) {
    await runStep(`status ${name}`, "tychonic", ["--instance", instance, "status", "--workflow-id", parsed.workflowId], {
      cwd: repoRoot,
      allowFailure: true
    });
    throw new Error(`workflow ${name} finished with status ${JSON.stringify(parsed.status)}, expected ${expectedStatus}`);
  }
  await recordWorkflowTiming(instance, name, parsed.workflowId);
}

async function waitForRuntime(instance) {
  for (let i = 0; i < 60; i++) {
    const temporal = await run("tychonic", ["--instance", instance, "temporal", "status"], {
      cwd: repoRoot,
      allowFailure: true
    });
    const workflow = await run("tychonic", ["--instance", instance, "status"], {
      cwd: repoRoot,
      allowFailure: true
    });
    if (temporal.status === 0 && workflow.status === 0 && /"health": "(running|port-open)"/.test(temporal.stdout)) {
      return;
    }
    await delay(1000);
  }
  throw new Error(`runtime instance ${instance} did not become ready`);
}

async function createFixtureRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const target = join(root, "repo");
  await mkdir(join(target, "src"), { recursive: true });
  await mkdir(join(target, "scripts"), { recursive: true });
  await mkdir(join(target, "test"), { recursive: true });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify(
      {
        name: prefix.replace(/[^a-z0-9-]/gi, "").toLowerCase(),
        private: true,
        type: "module",
        scripts: {
          typecheck: "node scripts/typecheck.js",
          build: "node scripts/build.js",
          lint: "node scripts/lint.js",
          test: "node --test test/*.test.js",
          integration: "node scripts/integration.js",
          "test:integration": "node scripts/integration.js"
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(join(target, ".gitignore"), ".test-tmp/\n.tychonic/\ndist/\nnode_modules/\n", "utf8");
  await writeFile(
    join(target, "README.md"),
    "# Tychonic Bootstrap Fixture\n\nSmall JavaScript package used by Tychonic bootstrap workflow checks.\n",
    "utf8"
  );
  await writeFile(
    join(target, "src", "index.js"),
    [
      "export function add(a, b) {",
      "  if (arguments.length !== 2 || !Number.isFinite(a) || !Number.isFinite(b)) {",
      "    throw new TypeError('add expects exactly two finite number inputs');",
      "  }",
      "  const result = a + b;",
      "  if (!Number.isFinite(result)) {",
      "    throw new TypeError('add result must be finite');",
      "  }",
      "  return result;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(join(target, "test", "add.test.js"), addTestSource(), "utf8");
  await writeFile(join(target, "test", "lint.test.js"), lintTestSource(), "utf8");
  await writeFile(join(target, "test", "security-gate.test.js"), securityGateTestSource(), "utf8");
  await writeFile(join(target, "test", "scripts.test.js"), scriptsTestSource(), "utf8");
  await writeFile(join(target, "scripts", "typecheck.js"), typecheckScriptSource(), "utf8");
  await writeFile(join(target, "scripts", "build.js"), buildScriptSource(), "utf8");
  await writeFile(join(target, "scripts", "lint.js"), lintScriptSource(), "utf8");
  await writeFile(join(target, "scripts", "integration.js"), integrationScriptSource(), "utf8");
  const securityGate = join(target, "scripts", "security-gate.sh");
  await writeFile(securityGate, securityGateScriptSource(), "utf8");
  await chmod(securityGate, 0o755);
  await run("git", ["init", "-q"], { cwd: target });
  await run("git", ["add", "."], { cwd: target });
  await run(
    "git",
    [
      "-c",
      "user.name=Tychonic Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "commit",
      "-qm",
      "initial bootstrap fixture"
    ],
    { cwd: target }
  );
  await runStep("fixture typecheck", "npm", ["run", "typecheck"], { cwd: target });
  await runStep("fixture build", "npm", ["run", "build"], { cwd: target });
  await runStep("fixture lint", "npm", ["run", "lint"], { cwd: target });
  await runStep("fixture test", "npm", ["test"], { cwd: target });
  await runStep("fixture integration", "npm", ["run", "integration"], { cwd: target });
  await runStep("fixture security", "./scripts/security-gate.sh", [], { cwd: target });
  return target;
}

async function runStep(name, command, args, options) {
  const startedAt = Date.now();
  try {
    const result = await run(command, args, options);
    results.push({
      name,
      status: result.status === 0 ? "succeeded" : "failed_allowed",
      duration_ms: Date.now() - startedAt,
      ...(result.status === 0 ? {} : { exit_code: result.status })
    });
    return result;
  } catch (error) {
    results.push({
      name,
      status: "failed",
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (options.quiet !== true && verbose) {
      process.stdout.write(chunk);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (options.quiet !== true && verbose) {
      process.stderr.write(chunk);
    }
  });
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${status}${outputTail(stdout, stderr)}`);
  }
  return { status, stdout, stderr };
}

function outputTail(stdout, stderr) {
  const parts = [];
  if (stdout.trim().length > 0) {
    parts.push(`stdout tail:\n${tail(stdout)}`);
  }
  if (stderr.trim().length > 0) {
    parts.push(`stderr tail:\n${tail(stderr)}`);
  }
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

function tail(value) {
  return value.split(/\r?\n/).slice(-80).join("\n");
}

async function recordWorkflowTiming(instance, name, workflowId) {
  if (typeof workflowId !== "string" || workflowId.length === 0) {
    throw new Error(`workflow ${name} did not return a workflowId`);
  }
  const status = await runStep(
    `status ${name}`,
    "tychonic",
    ["--instance", instance, "status", "--workflow-id", workflowId],
    { cwd: repoRoot, quiet: true }
  );
  let parsed;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    throw new Error(`status ${name} did not print JSON output: ${status.stdout}`);
  }
  const timing = parsed?.evidence?.timing;
  if (!timing || typeof timing !== "object") {
    throw new Error(`status ${name} did not include evidence.timing`);
  }
  results.push({
    name: `workflow timing ${name}`,
    status: "observed",
    workflow_id: workflowId,
    timing
  });
}

function resolveLiveScope() {
  if (process.env.TYCHONIC_BOOTSTRAP_LIVE_AGENTS === "0") {
    return "none";
  }
  const value = process.env.TYCHONIC_BOOTSTRAP_LIVE_SCOPE ?? "smoke";
  if (value === "none" || value === "smoke" || value === "examples") {
    return value;
  }
  throw new Error("TYCHONIC_BOOTSTRAP_LIVE_SCOPE must be one of: none, smoke, examples");
}

function liveWorkflowNames(scope) {
  if (scope === "smoke") {
    return ["simpleWorkflow", "architectBuilderKiroQaWorkflow"];
  }
  return [
    "verifyOnlyWorkflow",
    "simpleWorkflow",
    "pipelineWorkflow",
    "checkpointWorkflow",
    "architectBuilderQaWorkflow",
    "architectBuilderKiroQaWorkflow",
    "architectBuilderKiroRepairQaWorkflow"
  ];
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeInstanceName(prefix) {
  const { deriveInstancePort } = await import("../dist/runtime/instance.js");
  for (let attempt = 0; attempt < 100; attempt++) {
    const unique = `${process.pid.toString(36)}-${Date.now().toString(36).slice(-8)}-${attempt.toString(36)}`;
    const name = `${prefix}-${unique}`.slice(0, 32);
    if (await portIsFree(deriveInstancePort(name))) {
      return name;
    }
  }
  throw new Error(`failed to find a free Temporal API port for ${prefix} bootstrap instance`);
}

async function portIsFree(port) {
  const server = createServer();
  return await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function addTestSource() {
  return [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { add } from '../src/index.js';",
    "",
    "const finiteInputError = /exactly two finite number inputs/;",
    "const finiteResultError = /result must be finite/;",
    "",
    "test('adds representative finite numbers', () => {",
    "  assert.equal(add(2, 3), 5);",
    "  assert.equal(add(0, 0), 0);",
    "  assert.equal(add(-2, 3), 1);",
    "  assert.equal(add(1.5, 2.25), 3.75);",
    "  assert.equal(add(Number.MAX_VALUE, -Number.MAX_VALUE), 0);",
    "});",
    "",
    "test('rejects invalid input and result cases', () => {",
    "  for (const value of ['2', null, undefined, true, false, {}, [], Object(1), new Number(1), Symbol('x'), () => 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {",
    "    assert.throws(() => add(value, 3), finiteInputError);",
    "    assert.throws(() => add(3, value), finiteInputError);",
    "  }",
    "  assert.throws(() => add(), finiteInputError);",
    "  assert.throws(() => add(1), finiteInputError);",
    "  assert.throws(() => add(1, 2, 3), finiteInputError);",
    "  assert.throws(() => add(0n, 1), finiteInputError);",
    "  assert.throws(() => add(1, 0n), finiteInputError);",
    "  assert.throws(() => add(Number.MAX_VALUE, Number.MAX_VALUE), finiteResultError);",
    "  assert.throws(() => add(-Number.MAX_VALUE, -Number.MAX_VALUE), finiteResultError);",
    "});",
    "",
    "test('preserves signed zero semantics', () => {",
    "  assert.equal(Object.is(add(-0, 0), 0), true);",
    "  assert.equal(Object.is(add(0, -0), 0), true);",
    "  assert.equal(Object.is(add(-0, -0), -0), true);",
    "});",
    ""
  ].join("\n");
}

function lintTestSource() {
  return [
    "import assert from 'node:assert/strict';",
    "import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "import test from 'node:test';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const lintScript = fileURLToPath(new URL('../scripts/lint.js', import.meta.url));",
    "function makeTempDir(prefix) {",
    "  const root = process.env.TEST_TMPDIR ?? tmpdir();",
    "  mkdirSync(root, { recursive: true });",
    "  return mkdtempSync(join(root, prefix));",
    "}",
    "function runLintForFile(contents) {",
    "  const dir = makeTempDir('lint-fixture-');",
    "  const file = join(dir, 'sample.js');",
    "  writeFileSync(file, contents, 'utf8');",
    "  try {",
    "    return spawnSync(process.execPath, [lintScript], { env: { ...process.env, LINT_DIRS: dir }, encoding: 'utf8' });",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "}",
    "function writeDefaultLintFixture(dir) {",
    "  for (const subdir of ['src', 'test', 'scripts']) {",
    "    mkdirSync(join(dir, subdir), { recursive: true });",
    "    writeFileSync(join(dir, subdir, 'sample.js'), 'export const value = 1;\\n', 'utf8');",
    "  }",
    "}",
    "test('lint passes and reports marker/tab failures', () => {",
    "  const clean = runLintForFile('export const value = 1;\\n// lowercase todo is ordinary prose here\\nconst TODOLIST = [];\\nconst prefixFIXMEsuffix = true;\\n');",
    "  assert.equal(clean.status, 0);",
    "  assert.match(clean.stdout, /lint checked 1 files/);",
    "  const startOfFile = runLintForFile(['TO', 'DO'].join('') + ': remove me\\n');",
    "  assert.equal(startOfFile.status, 1);",
    "  assert.match(startOfFile.stderr, /sample\\.js: unresolved marker/);",
    "  const endOfFile = runLintForFile('// ' + ['TO', 'DO'].join('') + ': tail');",
    "  assert.equal(endOfFile.status, 1);",
    "  assert.match(endOfFile.stderr, /sample\\.js: unresolved marker/);",
    "  for (const marker of [['TO', 'DO'].join(''), ['FIX', 'ME'].join('')]) {",
    "    const result = runLintForFile(`// ${marker}: remove me\\n`);",
    "    assert.equal(result.status, 1);",
    "    assert.match(result.stderr, /sample\\.js: unresolved marker/);",
    "  }",
    "  const tab = runLintForFile('export const value = 1;\\n\\t\\n');",
    "  assert.equal(tab.status, 1);",
    "  assert.match(tab.stderr, /sample\\.js: tab character/);",
    "  const multiple = runLintForFile('// ' + ['TO', 'DO'].join('') + ': remove me\\n\\t\\n');",
    "  assert.equal(multiple.status, 1);",
    "  assert.match(multiple.stderr, /sample\\.js: tab character/);",
    "  assert.match(multiple.stderr, /sample\\.js: unresolved marker/);",
    "  const duplicateMarkers = runLintForFile('// ' + ['TO', 'DO'].join('') + ': one\\n// ' + ['FIX', 'ME'].join('') + ': two\\n');",
    "  assert.equal(duplicateMarkers.status, 1);",
    "  assert.equal(duplicateMarkers.stderr.match(/sample\\.js: unresolved marker/g)?.length, 1);",
    "});",
    "",
    "test('lint passes against the fixture repository tree', () => {",
    "  const { LINT_DIRS, ...env } = process.env;",
    "  const result = spawnSync(process.execPath, [lintScript], {",
    "    cwd: process.cwd(),",
    "    env,",
    "    encoding: 'utf8'",
    "  });",
    "  assert.equal(result.status, 0);",
    "  assert.match(result.stdout, /lint checked [1-9][0-9]* files/);",
    "});",
    "",
    "test('lint uses default directories from controlled cwd', () => {",
    "  const dir = makeTempDir('default-lint-fixture-');",
    "  const { LINT_DIRS, ...env } = process.env;",
    "  try {",
    "    writeDefaultLintFixture(dir);",
    "    const result = spawnSync(process.execPath, [lintScript], { cwd: dir, env, encoding: 'utf8' });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /lint checked 3 files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('lint scans multiple configured directories with whitespace trimming', () => {",
    "  const dirA = makeTempDir('multi-lint-a-');",
    "  const dirB = makeTempDir('multi-lint-b-');",
    "  try {",
    "    writeFileSync(join(dirA, 'a.js'), 'export const a = 1;\\n', 'utf8');",
    "    writeFileSync(join(dirB, 'b.js'), 'export const b = 2;\\n', 'utf8');",
    "    const result = spawnSync(process.execPath, [lintScript], {",
    "      env: { ...process.env, LINT_DIRS: ` ${dirA}, ${dirB} ` },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /lint checked 2 files/);",
    "  } finally {",
    "    rmSync(dirA, { recursive: true, force: true });",
    "    rmSync(dirB, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('lint covers default and error branches', () => {",
    "  const noDirs = spawnSync(process.execPath, [lintScript], {",
    "    env: { ...process.env, LINT_DIRS: '' },",
    "    encoding: 'utf8'",
    "  });",
    "  assert.equal(noDirs.status, 1);",
    "  assert.match(noDirs.stderr, /requires at least one directory/);",
    "",
    "  const missingRoot = makeTempDir('missing-lint-root-');",
    "  const missingDir = join(missingRoot, 'missing');",
    "  rmSync(missingRoot, { recursive: true, force: true });",
    "  const missing = spawnSync(process.execPath, [lintScript], {",
    "    env: { ...process.env, LINT_DIRS: missingDir },",
    "    encoding: 'utf8'",
    "  });",
    "  assert.equal(missing.status, 1);",
    "  assert.match(missing.stderr, /configured directory does not exist/);",
    "",
    "  const validDir = makeTempDir('partial-lint-dir-');",
    "  writeFileSync(join(validDir, 'sample.js'), 'export const value = 1;\\n', 'utf8');",
    "  const partiallyMissing = spawnSync(process.execPath, [lintScript], {",
    "    env: { ...process.env, LINT_DIRS: `${validDir},${missingDir}` },",
    "    encoding: 'utf8'",
    "  });",
    "  rmSync(validDir, { recursive: true, force: true });",
    "  assert.equal(partiallyMissing.status, 1);",
    "  assert.match(partiallyMissing.stderr, /configured directory does not exist/);",
    "",
    "  const nonDirectoryRoot = makeTempDir('lint-nondir-root-');",
    "  const nonDirectory = join(nonDirectoryRoot, 'not-dir.js');",
    "  writeFileSync(nonDirectory, 'export const value = 1;\\n', 'utf8');",
    "  const notDirectory = spawnSync(process.execPath, [lintScript], {",
    "    env: { ...process.env, LINT_DIRS: nonDirectory },",
    "    encoding: 'utf8'",
    "  });",
    "  rmSync(nonDirectoryRoot, { recursive: true, force: true });",
    "  assert.equal(notDirectory.status, 1);",
    "  assert.match(notDirectory.stderr, /configured path is not a directory/);",
    "",
    "  const dir = makeTempDir('empty-lint-fixture-');",
    "  try {",
    "    const noFiles = spawnSync(process.execPath, [lintScript], {",
    "      env: { ...process.env, LINT_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(noFiles.status, 1);",
    "    assert.match(noFiles.stderr, /found no JavaScript files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('lint ignores non-JavaScript files', () => {",
    "  const dir = makeTempDir('non-js-lint-fixture-');",
    "  try {",
    "    writeFileSync(join(dir, 'sample.js'), 'export const value = 1;\\n', 'utf8');",
    "    writeFileSync(join(dir, 'notes.md'), ['TO', 'DO'].join('') + ': markdown marker\\n', 'utf8');",
    "    writeFileSync(join(dir, 'config.json'), '{\"tab\":\"\\\\t\"}\\n', 'utf8');",
    "    writeFileSync(join(dir, 'types.ts'), ['FIX', 'ME'].join('') + ': typescript marker\\n', 'utf8');",
    "    const result = spawnSync(process.execPath, [lintScript], {",
    "      env: { ...process.env, LINT_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /lint checked 1 files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('lint checks Node JavaScript module extensions', () => {",
    "  const dir = makeTempDir('extension-lint-fixture-');",
    "  try {",
    "    writeFileSync(join(dir, 'sample.mjs'), 'export const value = 1;\\n\\t\\n', 'utf8');",
    "    writeFileSync(join(dir, 'sample.cjs'), 'module.exports = { value: 1 };\\n\\t\\n', 'utf8');",
    "    const result = spawnSync(process.execPath, [lintScript], {",
    "      env: { ...process.env, LINT_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 1);",
    "    assert.match(result.stderr, /sample\\.mjs: tab character/);",
    "    assert.match(result.stderr, /sample\\.cjs: tab character/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('lint recursively checks nested JavaScript files', () => {",
    "  const dir = makeTempDir('nested-lint-fixture-');",
    "  const nested = join(dir, 'a', 'b');",
    "  mkdirSync(nested, { recursive: true });",
    "  writeFileSync(join(nested, 'sample.js'), 'export const value = 1;\\n\\t\\n', 'utf8');",
    "  try {",
    "    const result = spawnSync(process.execPath, [lintScript], {",
    "      env: { ...process.env, LINT_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 1);",
    "    assert.match(result.stderr, /tab character/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('lint ignores symlinked JavaScript paths by contract', () => {",
    "  const dir = makeTempDir('symlink-lint-fixture-');",
    "  const targetDir = makeTempDir('symlink-lint-target-');",
    "  try {",
    "    writeFileSync(join(dir, 'sample.js'), 'export const value = 1;\\n', 'utf8');",
    "    writeFileSync(join(targetDir, 'linked.js'), 'export const linked = true;\\n\\t\\n', 'utf8');",
    "    symlinkSync(join(targetDir, 'linked.js'), join(dir, 'linked-file.js'));",
    "    symlinkSync(targetDir, join(dir, 'linked-dir'));",
    "    const result = spawnSync(process.execPath, [lintScript], {",
    "      env: { ...process.env, LINT_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /lint checked 1 files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "    rmSync(targetDir, { recursive: true, force: true });",
    "  }",
    "});",
    ""
  ].join("\n");
}

function securityGateTestSource() {
  return [
    "import assert from 'node:assert/strict';",
    "import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { dirname, join } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "import test from 'node:test';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const gateScript = fileURLToPath(new URL('../scripts/security-gate.sh', import.meta.url));",
    "const markers = [['SEC', 'RET'].join(''), ['TO', 'KEN'].join(''), ['PASS', 'WORD'].join(''), ['AK', 'IA'].join('')];",
    "const credentialSamples = [",
    "  ['g', 'hp_1234567890abcdef'].join(''),",
    "  ['s', 'k-1234567890abcdef'].join(''),",
    "  ['x', 'oxb-1234567890-abcdef'].join(''),",
    "  ['Authoriza', 'tion: Bearer abcdef123456'].join(''),",
    "  ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),",
    "  ['e', 'yJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'c2lnbmF0dXJl'].join('')",
    "];",
    "function runGate(cwd, extraEnv = {}) {",
    "  return spawnSync(gateScript, { cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf8' });",
    "}",
    "function makeTempDir(prefix) {",
    "  const root = process.env.TEST_TMPDIR ?? tmpdir();",
    "  mkdirSync(root, { recursive: true });",
    "  return mkdtempSync(join(root, prefix));",
    "}",
    "function makeGitFixture(options = {}) {",
    "  const dir = makeTempDir('security-gate-fixture-');",
    "  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "  if (options.ignoreOutputs !== false) {",
    "    writeFileSync(join(dir, '.gitignore'), '.tychonic/\\ndist/\\n', 'utf8');",
    "  }",
    "  return dir;",
    "}",
    "",
    "test('security gate handles an empty git worktree', () => {",
    "  const dir = makeGitFixture({ ignoreOutputs: false });",
    "  try {",
    "    assert.equal(runGate(dir).status, 0);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate passes against the fixture repository tree', () => {",
    "  const result = runGate(process.cwd());",
    "  assert.equal(result.status, 0);",
    "  assert.match(result.stdout, /security grep ok/);",
    "});",
    "",
    "test('security gate scans binary worktree files', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    const file = join(dir, 'binary-sensitive.bin');",
    "    writeFileSync(file, Buffer.from([0, ...Buffer.from(`${markers[0]}=binary`), 0]));",
    "    const result = runGate(dir);",
    "    assert.equal(result.status, 1);",
    "    assert.match(`${result.stdout}\\n${result.stderr}`, /binary-sensitive\\.bin|Binary file/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate handles clean and sensitive untracked files', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    assert.equal(runGate(dir).status, 0);",
    "    for (const marker of markers) {",
    "      const file = join(dir, `${marker}.txt`);",
    "      writeFileSync(file, `${marker}=example\\n`, 'utf8');",
    "      const result = runGate(dir);",
    "      assert.equal(result.status, 1);",
    "      assert.match(result.stdout, new RegExp(`${marker}\\\\.txt`));",
    "      rmSync(file, { force: true });",
    "    }",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate detects lowercase sensitive markers', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    for (const marker of markers) {",
    "      const file = join(dir, `${marker.toLowerCase()}.txt`);",
    "      writeFileSync(file, `${marker.toLowerCase()}=example\\n`, 'utf8');",
    "      const result = runGate(dir);",
    "      assert.equal(result.status, 1);",
    "      assert.match(result.stdout, new RegExp(`${marker.toLowerCase()}\\\\.txt`));",
    "      rmSync(file, { force: true });",
    "    }",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate scans tracked files', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    const trackedFile = join(dir, '.tmp-security-tracked.txt');",
    "    writeFileSync(trackedFile, `${markers[0]}=example\\n`, 'utf8');",
    "    assert.equal(spawnSync('git', ['add', trackedFile], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "    const tracked = runGate(dir);",
    "    assert.equal(tracked.status, 1);",
    "    assert.match(tracked.stdout, /\\.tmp-security-tracked\\.txt/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate detects representative credential formats', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    for (let i = 0; i < credentialSamples.length; i += 1) {",
    "      const file = join(dir, `credential-${i}.txt`);",
    "      writeFileSync(file, `${credentialSamples[i]}\\n`, 'utf8');",
    "      const result = runGate(dir);",
    "      assert.equal(result.status, 1);",
    "      assert.match(result.stdout, new RegExp(`credential-${i}\\\\.txt`));",
    "      rmSync(file, { force: true });",
    "    }",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate scans staged files inside ignored output directories', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    for (const ignoredName of ['.tychonic', 'dist']) {",
    "      const ignoredDir = join(dir, ignoredName);",
    "      mkdirSync(ignoredDir, { recursive: true });",
    "      const file = join(ignoredDir, `${markers[0]}.txt`);",
    "      writeFileSync(file, `${markers[0]}=staged\\n`, 'utf8');",
    "      assert.equal(spawnSync('git', ['add', '-f', file], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "      const result = runGate(dir);",
    "      assert.equal(result.status, 1);",
    "      assert.match(result.stdout, new RegExp(`${ignoredName.replace('.', '\\\\.')}/${markers[0]}\\\\.txt`));",
    "      assert.equal(spawnSync('git', ['reset', '-q', '--', file], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "      rmSync(ignoredDir, { recursive: true, force: true });",
    "    }",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate scans staged output files when worktree scan has no candidates', () => {",
    "  const dir = makeGitFixture({ ignoreOutputs: false });",
    "  try {",
    "    const ignoredDir = join(dir, 'dist');",
    "    mkdirSync(ignoredDir, { recursive: true });",
    "    const file = join(ignoredDir, `${markers[0]}.txt`);",
    "    writeFileSync(file, `${markers[0]}=staged-only\\n`, 'utf8');",
    "    assert.equal(spawnSync('git', ['add', '-f', file], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "    const result = runGate(dir);",
    "    assert.equal(result.status, 1);",
    "    assert.match(result.stdout, new RegExp(`dist/${markers[0]}\\\\.txt`));",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate scans ignored non-output worktree paths', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    const ignoredName = ['sec', 'rets'].join('');",
    "    writeFileSync(join(dir, '.gitignore'), `.tychonic/\\ndist/\\n${ignoredName}/\\n`, 'utf8');",
    "    const ignoredDir = join(dir, ignoredName);",
    "    mkdirSync(ignoredDir, { recursive: true });",
    "    const file = join(ignoredDir, `${markers[1]}.txt`);",
    "    writeFileSync(file, `${markers[1]}=ignored-but-not-output\\n`, 'utf8');",
    "    const result = runGate(dir);",
    "    assert.equal(result.status, 1);",
    "    assert.match(result.stdout, new RegExp(`${ignoredName}/${markers[1]}\\\\.txt`));",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate scans modified tracked worktree files', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    const trackedFile = join(dir, 'tracked-clean.txt');",
    "    writeFileSync(trackedFile, 'export const clean = true;\\n', 'utf8');",
    "    assert.equal(spawnSync('git', ['add', trackedFile], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "    assert.equal(spawnSync('git', ['-c', 'user.name=Tychonic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', 'commit', '-qm', 'clean tracked file'], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "    writeFileSync(trackedFile, `${markers[0]}=modified\\n`, 'utf8');",
    "    const modified = runGate(dir);",
    "    assert.equal(modified.status, 1);",
    "    assert.match(modified.stdout, /tracked-clean\\.txt/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate scans staged content even when worktree was cleaned', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    const stagedFile = join(dir, '.tmp-staged-security.txt');",
    "    writeFileSync(stagedFile, `${markers[0]}=example\\n`, 'utf8');",
    "    assert.equal(spawnSync('git', ['add', stagedFile], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "    writeFileSync(stagedFile, 'export const clean = true;\\n', 'utf8');",
    "    const result = runGate(dir);",
    "    assert.equal(result.status, 1);",
    "    assert.match(result.stdout, /\\.tmp-staged-security\\.txt/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate does not match its own split marker pattern', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    const scriptsDir = join(dir, 'scripts');",
    "    mkdirSync(scriptsDir, { recursive: true });",
    "    const copiedGate = join(scriptsDir, 'security-gate.sh');",
    "    writeFileSync(copiedGate, readFileSync(gateScript, 'utf8'), 'utf8');",
    "    assert.equal(spawnSync('git', ['add', copiedGate], { cwd: dir, encoding: 'utf8' }).status, 0);",
    "    assert.equal(runGate(dir).status, 0);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate preserves ignored output exclusions', () => {",
    "  const dir = makeGitFixture({ ignoreOutputs: false });",
    "  try {",
    "  for (const ignoredName of ['.tychonic', 'dist']) {",
    "    const ignoredDir = join(dir, ignoredName);",
    "    mkdirSync(ignoredDir, { recursive: true });",
    "    const file = join(ignoredDir, `${markers[1]}.txt`);",
    "    writeFileSync(file, `${markers[1]}=ignored\\n`, 'utf8');",
    "    assert.equal(runGate(dir).status, 0);",
    "  }",
    "  const visibleFile = join(dir, 'visible-sensitive.txt');",
    "  writeFileSync(visibleFile, `${markers[1]}=visible\\n`, 'utf8');",
    "  const visible = runGate(dir);",
    "  assert.equal(visible.status, 1);",
    "  assert.match(visible.stdout, /visible-sensitive\\.txt/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate ignores generated and vendor worktree directories', () => {",
    "  const dir = makeGitFixture();",
    "  try {",
    "    for (const ignoredName of ['.test-tmp', 'node_modules']) {",
    "      const ignoredDir = join(dir, ignoredName);",
    "      mkdirSync(ignoredDir, { recursive: true });",
    "      const file = join(ignoredDir, `${markers[1]}.txt`);",
    "      writeFileSync(file, `${markers[1]}=generated\\n`, 'utf8');",
    "      assert.equal(runGate(dir).status, 0);",
    "      rmSync(ignoredDir, { recursive: true, force: true });",
    "    }",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('security gate propagates real git errors', () => {",
    "  const dir = makeTempDir('security-gate-nongit-');",
    "  try {",
    "    const result = runGate(dir, { GIT_CEILING_DIRECTORIES: dirname(dir) });",
    "    assert.equal(result.status, 128);",
    "    assert.match(result.stderr, /not a git repository/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    ""
  ].join("\n");
}

function scriptsTestSource() {
  return [
    "import assert from 'node:assert/strict';",
    "import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "import test from 'node:test';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const typecheckScript = fileURLToPath(new URL('../scripts/typecheck.js', import.meta.url));",
    "const buildScript = fileURLToPath(new URL('../scripts/build.js', import.meta.url));",
    "const integrationScript = fileURLToPath(new URL('../scripts/integration.js', import.meta.url));",
    "function makeTempDir(prefix) {",
    "  const root = process.env.TEST_TMPDIR ?? tmpdir();",
    "  mkdirSync(root, { recursive: true });",
    "  return mkdtempSync(join(root, prefix));",
    "}",
    "",
    "function writeDefaultScriptFixture(dir, source = 'export const value = 1;\\n') {",
    "  mkdirSync(join(dir, 'src'), { recursive: true });",
    "  mkdirSync(join(dir, 'test'), { recursive: true });",
    "  mkdirSync(join(dir, 'scripts'), { recursive: true });",
    "  writeFileSync(join(dir, 'package.json'), '{\"type\":\"module\"}\\n', 'utf8');",
    "  if (source !== null) {",
    "    writeFileSync(join(dir, 'src', 'index.js'), source, 'utf8');",
    "  }",
    "  writeFileSync(join(dir, 'test', 'sample.test.js'), 'import test from \\'node:test\\';\\ntest(\\'sample\\', () => {});\\n', 'utf8');",
    "  writeFileSync(join(dir, 'scripts', 'sample.js'), 'export const sample = true;\\n', 'utf8');",
    "}",
    "",
    "function makeBuildFixture(withSource = true) {",
    "  const dir = makeTempDir('build-fixture-');",
    "  if (withSource) {",
    "    mkdirSync(join(dir, 'src'), { recursive: true });",
    "    writeFileSync(join(dir, 'src', 'index.js'), 'export const value = 1;\\n', 'utf8');",
    "  }",
    "  return dir;",
    "}",
    "",
    "test('typecheck uses default directories from controlled cwd', () => {",
    "  const dir = makeTempDir('default-typecheck-fixture-');",
    "  const { TYPECHECK_DIRS, ...env } = process.env;",
    "  try {",
    "    writeDefaultScriptFixture(dir);",
    "    const typecheck = spawnSync(process.execPath, [typecheckScript], { cwd: dir, env, encoding: 'utf8' });",
    "    assert.equal(typecheck.status, 0);",
    "    assert.match(typecheck.stdout, /syntax checked 3 files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck scans multiple configured directories with whitespace trimming', () => {",
    "  const dirA = makeTempDir('multi-typecheck-a-');",
    "  const dirB = makeTempDir('multi-typecheck-b-');",
    "  try {",
    "    writeFileSync(join(dirA, 'a.js'), 'export const a = 1;\\n', 'utf8');",
    "    writeFileSync(join(dirB, 'b.js'), 'export const b = 2;\\n', 'utf8');",
    "    const result = spawnSync(process.execPath, [typecheckScript], {",
    "      env: { ...process.env, TYPECHECK_DIRS: ` ${dirA}, ${dirB} ` },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /syntax checked 2 files/);",
    "  } finally {",
    "    rmSync(dirA, { recursive: true, force: true });",
    "    rmSync(dirB, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "const validatedAddSource = [",
    "  'export function add(a, b) {',",
    "  '  if (arguments.length !== 2 || !Number.isFinite(a) || !Number.isFinite(b)) {',",
    "  \"    throw new TypeError('add expects exactly two finite number inputs');\",",
    "  '  }',",
    "  '  const result = a + b;',",
    "  '  if (!Number.isFinite(result)) {',",
    "  \"    throw new TypeError('add result must be finite');\",",
    "  '  }',",
    "  '  return result;',",
    "  '}',",
    "  '',",
    "].join('\\n');",
    "",
    "test('build script copies the source entry into dist', () => {",
    "  const buildDir = makeBuildFixture();",
    "  try {",
    "    const build = spawnSync(process.execPath, [buildScript], { cwd: buildDir, encoding: 'utf8' });",
    "    assert.equal(build.status, 0);",
    "    assert.match(build.stdout, /build ok/);",
    "    assert.equal(existsSync(join(buildDir, 'dist', 'index.js')), true);",
    "    assert.equal(readFileSync(join(buildDir, 'dist', 'index.js'), 'utf8'), 'export const value = 1;\\n');",
    "  } finally {",
    "    rmSync(buildDir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('build script overwrites an existing dist entry', () => {",
    "  const buildDir = makeBuildFixture();",
    "  try {",
    "    mkdirSync(join(buildDir, 'dist'), { recursive: true });",
    "    writeFileSync(join(buildDir, 'dist', 'asset.txt'), 'keep me\\n', 'utf8');",
    "    writeFileSync(join(buildDir, 'dist', 'index.js'), 'stale\\n', 'utf8');",
    "    const build = spawnSync(process.execPath, [buildScript], { cwd: buildDir, encoding: 'utf8' });",
    "    assert.equal(build.status, 0);",
    "    assert.equal(readFileSync(join(buildDir, 'dist', 'index.js'), 'utf8'), 'export const value = 1;\\n');",
    "    assert.equal(readFileSync(join(buildDir, 'dist', 'asset.txt'), 'utf8'), 'keep me\\n');",
    "  } finally {",
    "    rmSync(buildDir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('build script fails when source entry is absent', () => {",
    "  const buildDir = makeBuildFixture(false);",
    "  try {",
    "    const build = spawnSync(process.execPath, [buildScript], { cwd: buildDir, encoding: 'utf8' });",
    "    assert.notEqual(build.status, 0);",
    "    assert.match(`${build.stdout}\\n${build.stderr}`, /ENOENT.*src[\\\\/]index\\.js|src[\\\\/]index\\.js.*ENOENT/);",
    "    assert.equal(existsSync(join(buildDir, 'dist')), false);",
    "  } finally {",
    "    rmSync(buildDir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('build script fails when dist path is not a directory', () => {",
    "  const buildDir = makeBuildFixture();",
    "  try {",
    "    writeFileSync(join(buildDir, 'dist'), 'not a directory\\n', 'utf8');",
    "    const build = spawnSync(process.execPath, [buildScript], { cwd: buildDir, encoding: 'utf8' });",
    "    assert.notEqual(build.status, 0);",
    "    assert.match(`${build.stdout}\\n${build.stderr}`, /EEXIST|ENOTDIR|EISDIR|EPERM|not a directory|file already exists/);",
    "  } finally {",
    "    rmSync(buildDir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck rejects empty directory configuration', () => {",
    "  const noDirs = spawnSync(process.execPath, [typecheckScript], {",
    "    cwd: process.cwd(),",
    "    env: { ...process.env, TYPECHECK_DIRS: '' },",
    "    encoding: 'utf8'",
    "  });",
    "  assert.equal(noDirs.status, 1);",
    "  assert.match(noDirs.stderr, /requires at least one directory/);",
    "});",
    "",
    "test('typecheck rejects missing configured directories', () => {",
    "  const missingRoot = makeTempDir('missing-typecheck-root-');",
    "  const missingDir = join(missingRoot, 'missing');",
    "  rmSync(missingRoot, { recursive: true, force: true });",
    "  const result = spawnSync(process.execPath, [typecheckScript], {",
    "    cwd: process.cwd(),",
    "    env: { ...process.env, TYPECHECK_DIRS: missingDir },",
    "    encoding: 'utf8'",
    "  });",
    "  assert.equal(result.status, 1);",
    "  assert.match(result.stderr, /configured directory does not exist/);",
    "",
    "  const validDir = makeTempDir('partial-typecheck-dir-');",
    "  writeFileSync(join(validDir, 'sample.js'), 'export const value = 1;\\n', 'utf8');",
    "  const partiallyMissing = spawnSync(process.execPath, [typecheckScript], {",
    "    cwd: process.cwd(),",
    "    env: { ...process.env, TYPECHECK_DIRS: `${validDir},${missingDir}` },",
    "    encoding: 'utf8'",
    "  });",
    "  rmSync(validDir, { recursive: true, force: true });",
    "  assert.equal(partiallyMissing.status, 1);",
    "  assert.match(partiallyMissing.stderr, /configured directory does not exist/);",
    "});",
    "",
    "test('typecheck ignores non-JavaScript files', () => {",
    "  const dir = makeTempDir('typecheck-non-js-');",
    "  try {",
    "    writeFileSync(join(dir, 'sample.js'), 'export const value = 1;\\n', 'utf8');",
    "    writeFileSync(join(dir, 'broken.ts'), 'const = ;\\n', 'utf8');",
    "    writeFileSync(join(dir, 'broken.json'), '{not json}\\n', 'utf8');",
    "    writeFileSync(join(dir, 'notes.md'), '```js\\nconst = ;\\n```\\n', 'utf8');",
    "    const result = spawnSync(process.execPath, [typecheckScript], {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, TYPECHECK_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /syntax checked 1 files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck rejects non-directory configured paths', () => {",
    "  const root = makeTempDir('typecheck-nondir-root-');",
    "  const nonDirectory = join(root, 'not-dir.js');",
    "  try {",
    "    writeFileSync(nonDirectory, 'export const value = 1;\\n', 'utf8');",
    "    const result = spawnSync(process.execPath, [typecheckScript], {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, TYPECHECK_DIRS: nonDirectory },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 1);",
    "    assert.match(result.stderr, /configured path is not a directory/);",
    "  } finally {",
    "    rmSync(root, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck rejects directories without JavaScript files', () => {",
    "  const emptyDir = makeTempDir('typecheck-empty-');",
    "  try {",
    "    const noFiles = spawnSync(process.execPath, [typecheckScript], {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, TYPECHECK_DIRS: emptyDir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(noFiles.status, 1);",
    "    assert.match(noFiles.stderr, /found no JavaScript files/);",
    "  } finally {",
    "    rmSync(emptyDir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck surfaces syntax errors', () => {",
    "  const dir = makeTempDir('typecheck-failure-');",
    "  try {",
    "    writeFileSync(join(dir, 'broken.js'), 'const = ;\\n', 'utf8');",
    "    const failed = spawnSync(process.execPath, [typecheckScript], {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, TYPECHECK_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.notEqual(failed.status, 0);",
    "    assert.match(`${failed.stdout}\\n${failed.stderr}`, /SyntaxError|Unexpected/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck recursively checks nested files', () => {",
    "  const nestedDir = makeTempDir('typecheck-nested-');",
    "  const nested = join(nestedDir, 'a', 'b');",
    "  mkdirSync(nested, { recursive: true });",
    "  try {",
    "    writeFileSync(join(nested, 'broken.js'), 'const = ;\\n', 'utf8');",
    "    const nestedFailure = spawnSync(process.execPath, [typecheckScript], {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, TYPECHECK_DIRS: nestedDir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.notEqual(nestedFailure.status, 0);",
    "    assert.match(`${nestedFailure.stdout}\\n${nestedFailure.stderr}`, /SyntaxError|Unexpected/);",
    "  } finally {",
    "    rmSync(nestedDir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck recursively checks nested valid files', () => {",
    "  const dir = makeTempDir('typecheck-nested-valid-');",
    "  const nested = join(dir, 'a', 'b');",
    "  mkdirSync(nested, { recursive: true });",
    "  try {",
    "    writeFileSync(join(nested, 'valid.js'), 'export const nested = true;\\n', 'utf8');",
    "    const result = spawnSync(process.execPath, [typecheckScript], {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, TYPECHECK_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /syntax checked 1 files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('typecheck checks Node JavaScript module extensions', () => {",
    "  for (const extension of ['mjs', 'cjs']) {",
    "    const dir = makeTempDir(`typecheck-extension-${extension}-`);",
    "    try {",
    "      writeFileSync(join(dir, `broken.${extension}`), 'const = ;\\n', 'utf8');",
    "      const result = spawnSync(process.execPath, [typecheckScript], {",
    "        cwd: process.cwd(),",
    "        env: { ...process.env, TYPECHECK_DIRS: dir },",
    "        encoding: 'utf8'",
    "      });",
    "      assert.notEqual(result.status, 0);",
    "      assert.match(`${result.stdout}\\n${result.stderr}`, /SyntaxError|Unexpected/);",
    "    } finally {",
    "      rmSync(dir, { recursive: true, force: true });",
    "    }",
    "  }",
    "});",
    "",
    "test('typecheck ignores symlinked JavaScript paths by contract', () => {",
    "  const dir = makeTempDir('typecheck-symlink-fixture-');",
    "  const targetDir = makeTempDir('typecheck-symlink-target-');",
    "  try {",
    "    writeFileSync(join(dir, 'sample.js'), 'export const value = 1;\\n', 'utf8');",
    "    writeFileSync(join(targetDir, 'linked.js'), 'const = ;\\n', 'utf8');",
    "    symlinkSync(join(targetDir, 'linked.js'), join(dir, 'linked-file.js'));",
    "    symlinkSync(targetDir, join(dir, 'linked-dir'));",
    "    const result = spawnSync(process.execPath, [typecheckScript], {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, TYPECHECK_DIRS: dir },",
    "      encoding: 'utf8'",
    "    });",
    "    assert.equal(result.status, 0);",
    "    assert.match(result.stdout, /syntax checked 1 files/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "    rmSync(targetDir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('integration script succeeds against a fixture source entry', () => {",
    "  const dir = makeTempDir('integration-success-');",
    "  try {",
    "    writeDefaultScriptFixture(dir, validatedAddSource);",
    "    const integration = spawnSync(process.execPath, [integrationScript], { cwd: dir, encoding: 'utf8' });",
    "    assert.equal(integration.status, 0);",
    "    assert.match(integration.stdout, /integration ok/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('integration script fails when add input validation is absent', () => {",
    "  const dir = makeTempDir('integration-missing-validation-');",
    "  try {",
    "    writeDefaultScriptFixture(dir, 'export function add(a, b) { return a + b; }\\n');",
    "    const integration = spawnSync(process.execPath, [integrationScript], { cwd: dir, encoding: 'utf8' });",
    "    assert.notEqual(integration.status, 0);",
    "    assert.match(`${integration.stdout}\\n${integration.stderr}`, /AssertionError|exactly two finite number inputs/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('integration script fails when arithmetic assertion is violated', () => {",
    "  const dir = makeTempDir('integration-failure-');",
    "  try {",
    "    writeDefaultScriptFixture(dir, 'export function add() { return 0; }\\n');",
    "    const integration = spawnSync(process.execPath, [integrationScript], { cwd: dir, encoding: 'utf8' });",
    "    assert.notEqual(integration.status, 0);",
    "    assert.match(`${integration.stdout}\\n${integration.stderr}`, /AssertionError/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('integration script fails when add export is absent', () => {",
    "  const dir = makeTempDir('integration-missing-export-');",
    "  try {",
    "    writeDefaultScriptFixture(dir, 'export const notAdd = true;\\n');",
    "    const integration = spawnSync(process.execPath, [integrationScript], { cwd: dir, encoding: 'utf8' });",
    "    assert.notEqual(integration.status, 0);",
    "    assert.match(`${integration.stdout}\\n${integration.stderr}`, /TypeError|add is not a function/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('integration script fails when source entry is absent', () => {",
    "  const dir = makeTempDir('integration-missing-source-');",
    "  try {",
    "    writeDefaultScriptFixture(dir, null);",
    "    const integration = spawnSync(process.execPath, [integrationScript], { cwd: dir, encoding: 'utf8' });",
    "    assert.notEqual(integration.status, 0);",
    "    assert.match(`${integration.stdout}\\n${integration.stderr}`, /ERR_MODULE_NOT_FOUND|Cannot find module|src\\/index\\.js/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    "",
    "test('integration script fails when source entry is not parseable', () => {",
    "  const dir = makeTempDir('integration-unparseable-source-');",
    "  try {",
    "    writeDefaultScriptFixture(dir, 'export function add(a, b) { return ; ;\\n');",
    "    const integration = spawnSync(process.execPath, [integrationScript], { cwd: dir, encoding: 'utf8' });",
    "    assert.notEqual(integration.status, 0);",
    "    assert.match(`${integration.stdout}\\n${integration.stderr}`, /SyntaxError|Unexpected/);",
    "  } finally {",
    "    rmSync(dir, { recursive: true, force: true });",
    "  }",
    "});",
    ""
  ].join("\n");
}

function typecheckScriptSource() {
  return [
    "import { existsSync, readdirSync, statSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "const dirs = (process.env.TYPECHECK_DIRS ?? 'src,test,scripts').split(',').map((dir) => dir.trim()).filter(Boolean);",
    "if (dirs.length === 0) { console.error('typecheck requires at least one directory'); process.exit(1); }",
    "const files = dirs.flatMap(collectJsFiles);",
    "if (files.length === 0) { console.error(`typecheck found no JavaScript files in: ${dirs.join(', ')}`); process.exit(1); }",
    "for (const file of files) {",
    "  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });",
    "  if (result.status !== 0) process.exit(1);",
    "}",
    "console.log(`syntax checked ${files.length} files`);",
    "function collectJsFiles(dir) {",
    "  if (!existsSync(dir)) { console.error(`typecheck configured directory does not exist: ${dir}`); process.exit(1); }",
    "  if (!statSync(dir).isDirectory()) { console.error(`typecheck configured path is not a directory: ${dir}`); process.exit(1); }",
    "  const files = [];",
    "  for (const entry of readdirSync(dir, { withFileTypes: true })) {",
    "    const path = join(dir, entry.name);",
    "    if (entry.isDirectory()) files.push(...collectJsFiles(path));",
    "    else if (entry.isFile() && isJavaScriptFile(entry.name)) files.push(path);",
    "  }",
    "  return files;",
    "}",
    "function isJavaScriptFile(name) {",
    "  return name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs');",
    "}",
    ""
  ].join("\n");
}

function buildScriptSource() {
  return [
    "import { access, mkdir, copyFile } from 'node:fs/promises';",
    "await access('src/index.js');",
    "await mkdir('dist', { recursive: true });",
    "await copyFile('src/index.js', 'dist/index.js');",
    "console.log('build ok');",
    ""
  ].join("\n");
}

function lintScriptSource() {
  return [
    "import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const dirs = (process.env.LINT_DIRS ?? 'src,test,scripts').split(',').map((dir) => dir.trim()).filter(Boolean);",
    "if (dirs.length === 0) { console.error('lint requires at least one directory'); process.exit(1); }",
    "const files = dirs.flatMap(collectJsFiles);",
    "if (files.length === 0) { console.error(`lint found no JavaScript files in: ${dirs.join(', ')}`); process.exit(1); }",
    "const markerPattern = new RegExp(['(^|[^A-Za-z0-9_])(?:TO', 'DO|FIX', 'ME)(?=$|[^A-Za-z0-9_])'].join(''));",
    "const problems = [];",
    "for (const file of files) {",
    "  const text = readFileSync(file, 'utf8');",
    "  if (text.includes('\\t')) problems.push(`${file}: tab character`);",
    "  if (markerPattern.test(text)) problems.push(`${file}: unresolved marker`);",
    "}",
    "if (problems.length > 0) { console.error(problems.join('\\n')); process.exit(1); }",
    "console.log(`lint checked ${files.length} files`);",
    "function collectJsFiles(dir) {",
    "  if (!existsSync(dir)) { console.error(`lint configured directory does not exist: ${dir}`); process.exit(1); }",
    "  if (!statSync(dir).isDirectory()) { console.error(`lint configured path is not a directory: ${dir}`); process.exit(1); }",
    "  const files = [];",
    "  for (const entry of readdirSync(dir, { withFileTypes: true })) {",
    "    const path = join(dir, entry.name);",
    "    if (entry.isDirectory()) files.push(...collectJsFiles(path));",
    "    else if (entry.isFile() && isJavaScriptFile(entry.name)) files.push(path);",
    "  }",
    "  return files;",
    "}",
    "function isJavaScriptFile(name) {",
    "  return name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs');",
    "}",
    ""
  ].join("\n");
}

function integrationScriptSource() {
  return [
    "import assert from 'node:assert/strict';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const { add } = await import(pathToFileURL(join(process.cwd(), 'src', 'index.js')).href);",
    "const finiteInputError = /exactly two finite number inputs/;",
    "const finiteResultError = /result must be finite/;",
    "const invoice = { subtotal: 12.5, tax: 1.25 };",
    "assert.equal(add(invoice.subtotal, invoice.tax), 13.75);",
    "assert.throws(() => add('12.5', 1.25), finiteInputError);",
    "assert.throws(() => add(Number.MAX_VALUE, Number.MAX_VALUE), finiteResultError);",
    "assert.equal(Object.is(add(0, -0), 0), true);",
    "console.log('integration ok');",
    ""
  ].join("\n");
}

function securityGateScriptSource() {
  return [
    "#!/bin/sh",
    "set -eu",
    "pattern=\"$(printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' '[S]ECRET' '[T]OKEN' '[P]ASSWORD' '[A]KIA' 'g[h]p_[A-Za-z0-9_]{10,}' 's[k]-[A-Za-z0-9_-]{10,}' 'x[o]x[baprs]-[A-Za-z0-9-]{10,}' 'Authorizatio[n]:[[:space:]]*Bearer' '-----BEGIN [A-Z ]*PRIVATE KE[Y]-----' 'e[y]J[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}')\"",
    "git rev-parse --is-inside-work-tree >/dev/null",
    "report() {",
    "if [ -n \"$1\" ]; then",
    "  printf '%s\\n' \"$1\"",
    "  exit 1",
    "fi",
    "}",
    "scan_cached() {",
    "set +e",
    "output=\"$(git grep --cached -niE \"$pattern\" -- . ':!.git')\"",
    "status=$?",
    "set -e",
    "if [ \"$status\" -eq 0 ]; then",
    "  if [ -n \"$output\" ]; then",
    "    report \"$output\"",
    "  fi",
    "  return 0",
    "fi",
    "if [ \"$status\" -ne 1 ]; then",
    "  exit \"$status\"",
    "fi",
    "}",
    "scan_worktree() {",
    "set +e",
    "output=\"$(find . -type f ! -path './.git/*' ! -path './.tychonic/*' ! -path './dist/*' ! -path './.test-tmp/*' ! -path './node_modules/*' -exec grep -niE \"$pattern\" /dev/null {} +)\"",
    "status=$?",
    "set -e",
    "if [ \"$status\" -eq 0 ]; then",
    "  if [ -n \"$output\" ]; then",
    "    report \"$output\"",
    "  fi",
    "  return 0",
    "fi",
    "if [ \"$status\" -ne 1 ]; then",
    "  exit \"$status\"",
    "fi",
    "}",
    "scan_worktree",
    "scan_cached",
    "echo \"security grep ok\"",
    ""
  ].join("\n");
}
