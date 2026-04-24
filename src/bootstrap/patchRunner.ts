import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArtifactRecord, WorkflowRunRecord } from "../domain/types.js";
import { sanitizeChildEnv } from "./commandRunner.js";

export type WorkerPatchStatus = "applies" | "applied" | "does_not_apply" | "empty";

export interface WorkerPatchOptions {
  cwd: string;
  patchFile?: string;
  apply?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface WorkerPatchResult {
  run: WorkflowRunRecord;
  artifact: ArtifactRecord;
  patchFile: string;
  sourceWorkspace: string;
  mode: "check" | "apply";
  status: WorkerPatchStatus;
  output: string;
  exitCode?: number;
}

interface GitApplyResult {
  exitCode: number;
  output: string;
}

export async function checkOrApplyWorkerPatch(options: WorkerPatchOptions): Promise<WorkerPatchResult> {
  const { run, artifact, patchFile } = await loadWorkerPatchRef(options);
  const sourceWorkspace = run.cwd;
  const mode = options.apply ? "apply" : "check";
  const patchContent = await readFile(patchFile, "utf8");

  if (!patchContent.trim()) {
    return {
      run,
      artifact,
      patchFile,
      sourceWorkspace,
      mode,
      status: "empty",
      output: "worker patch is empty; nothing to apply"
    };
  }

  const check = await runGitApply({
    cwd: sourceWorkspace,
    args: ["apply", "--check", "--binary", patchFile],
    env: options.env
  });
  if (check.exitCode !== 0 || hasApplyError(check.output)) {
    return {
      run,
      artifact,
      patchFile,
      sourceWorkspace,
      mode,
      status: "does_not_apply",
      output: check.output,
      exitCode: check.exitCode
    };
  }

  if (!options.apply) {
    return {
      run,
      artifact,
      patchFile,
      sourceWorkspace,
      mode,
      status: "applies",
      output: check.output
    };
  }

  const applied = await runGitApply({
    cwd: sourceWorkspace,
    args: ["apply", "--binary", patchFile],
    env: options.env
  });
  if (applied.exitCode !== 0 || hasApplyError(applied.output)) {
    return {
      run,
      artifact,
      patchFile,
      sourceWorkspace,
      mode,
      status: "does_not_apply",
      output: applied.output,
      exitCode: applied.exitCode
    };
  }

  return {
    run,
    artifact,
    patchFile,
    sourceWorkspace,
    mode,
    status: "applied",
    output: applied.output
  };
}

export function findWorkerPatchArtifact(run: WorkflowRunRecord): ArtifactRecord {
  const artifact = [...run.artifacts].reverse().find((candidate) => candidate.kind === "worker_patch");
  if (!artifact) {
    throw new Error(`worker_patch artifact not found for run: ${run.id}`);
  }
  return artifact;
}

async function loadWorkerPatchRef(
  options: WorkerPatchOptions
): Promise<{ run: WorkflowRunRecord; artifact: ArtifactRecord; patchFile: string }> {
  if (!options.patchFile) {
    throw new Error("simple_workflow:patch requires an explicit --patch-file artifact path");
  }

  const patchFile = resolve(options.cwd, options.patchFile);
  const artifact: ArtifactRecord = {
    id: "explicit_worker_patch",
    kind: "worker_patch",
    path: patchFile,
    created_at: new Date(0).toISOString()
  };
  await readFile(patchFile, "utf8");
  return { run: syntheticPatchRun("explicit_patch", options.cwd, artifact), artifact, patchFile };
}

function syntheticPatchRun(id: string, cwd: string, artifact: ArtifactRecord): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id,
    template: "simple_workflow",
    status: "succeeded",
    cwd,
    created_at: artifact.created_at,
    updated_at: artifact.created_at,
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [artifact],
    findings: [],
    inbox: []
  };
}

/**
 * Detect partial-failure output from `git apply`. git is known to
 * exit 0 even when a binary hunk is corrupt or a target file is
 * missing, printing `error:` / `fatal:` lines to stdout+stderr and
 * silently skipping the broken portion. Treating exit-0-with-error
 * as success lets `simple_workflow:patch --apply` report success while the
 * operator's source tree is only partially patched. The patterns
 * here match git's own error prefixes; the check is locale-insensitive
 * because Git writes the leading `error:` / `fatal:` token in English
 * regardless of LANG (translations only apply to the rest of the line).
 */
function hasApplyError(output: string): boolean {
  return /(^|\n)(error|fatal):/.test(output);
}

async function runGitApply(input: {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<GitApplyResult> {
  return await new Promise<GitApplyResult>((resolve, reject) => {
    const child = spawn("git", input.args, {
      cwd: input.cwd,
      env: sanitizeChildEnv(input.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        output: Buffer.concat(chunks).toString("utf8")
      });
    });
  });
}
