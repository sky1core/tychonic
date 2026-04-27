#!/usr/bin/env node
// Helper for the simpleWorkflow example bundle.
//
// Usage:
//
//   node examples/workflow-helpers/simpleWorkflow.apply-patch.mjs \
//     --project-dir "$PWD" --patch-file ./patch.json [--apply]
//
// Checks (or applies) a worker_patch artifact produced by a simpleWorkflow
// run. This is a manual operator helper, not workflow code. Run it directly
// with node.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const SECRET_ENV_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN"
]);

async function main() {
  const { values } = parseArgs({
    options: {
      "project-dir": { type: "string", default: process.cwd() },
      "patch-file": { type: "string" },
      apply: { type: "boolean", default: false }
    }
  });
  const cwd = resolve(values["project-dir"] ?? process.cwd());
  const patchFile = values["patch-file"];
  if (!patchFile) {
    process.stderr.write("apply-patch.mjs requires --patch-file\n");
    process.exit(2);
  }
  const apply = Boolean(values.apply);
  const result = await checkOrApplyWorkerPatch({ cwd, patchFile: resolve(cwd, patchFile), apply });
  const ok = result.status !== "does_not_apply";
  process.stdout.write(JSON.stringify({
    ok,
    mode: result.mode,
    status: result.status,
    source_workspace: result.sourceWorkspace,
    patch_file: result.patchFile,
    ...(result.output ? { output: result.output.trim() } : {}),
    ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {})
  }, null, 2) + "\n");
  if (!ok) process.exit(1);
}

async function checkOrApplyWorkerPatch({ cwd, patchFile, apply }) {
  const mode = apply ? "apply" : "check";
  const patchContent = await readFile(patchFile, "utf8");
  if (!patchContent.trim()) {
    return { mode, status: "empty", output: "worker patch is empty; nothing to apply", patchFile, sourceWorkspace: cwd };
  }
  const check = await runGitApply({ cwd, args: ["apply", "--check", "--binary", patchFile] });
  if (check.exitCode !== 0 || hasApplyError(check.output)) {
    return { mode, status: "does_not_apply", output: check.output, exitCode: check.exitCode, patchFile, sourceWorkspace: cwd };
  }
  if (!apply) {
    return { mode, status: "applies", output: check.output, patchFile, sourceWorkspace: cwd };
  }
  const applied = await runGitApply({ cwd, args: ["apply", "--binary", patchFile] });
  if (applied.exitCode !== 0 || hasApplyError(applied.output)) {
    return { mode, status: "does_not_apply", output: applied.output, exitCode: applied.exitCode, patchFile, sourceWorkspace: cwd };
  }
  return { mode, status: "applied", output: applied.output, patchFile, sourceWorkspace: cwd };
}

function hasApplyError(output) {
  return /(^|\n)(error|fatal):/.test(output);
}

function sanitizeChildEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_VARS.has(key)) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  return out;
}

async function runGitApply({ cwd, args }) {
  return await new Promise((resolveOk, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: sanitizeChildEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveOk({
        exitCode: exitCode ?? 1,
        output: Buffer.concat(chunks).toString("utf8")
      });
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message ?? error}\n`);
  process.exit(1);
});
