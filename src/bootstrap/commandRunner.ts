import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildExecutablePathValue } from "../system/executables.js";

export interface CommandRunResult {
  status: "succeeded" | "failed" | "timed_out";
  exitCode?: number;
  output: string;
  timedOut: boolean;
}

export interface CommandRunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  liveOutputPath?: string;
  maxOutputBytes?: number;
  stdin?: string;
  onProgress?: () => void;
  progressIntervalMs?: number;
  /**
   * Optional abort signal. When aborted, the child process receives SIGTERM
   * immediately and SIGKILL after 1 second. The result resolves with
   * `status: "failed"` and `timedOut: false`; callers that need to surface a
   * Temporal cancellation should throw `CancelledFailure` themselves after
   * observing the abort (typically through `heartbeatActivity`).
   */
  signal?: AbortSignal;
}

const ADAPTER_CONTROL_ENV_KEYS = new Set([
  "TYCHONIC_CODEX_REVIEW_COMMAND",
  "TYCHONIC_TEST_REVIEW_COMMAND"
]);

export function sanitizeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !ADAPTER_CONTROL_ENV_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  sanitized.PATH = buildExecutablePathValue(env);
  return sanitized;
}

export async function runCommand(options: CommandRunOptions): Promise<CommandRunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let progressInterval: NodeJS.Timeout | undefined;

  if (options.liveOutputPath) {
    await mkdir(dirname(options.liveOutputPath), { recursive: true });
    await writeFile(options.liveOutputPath, "", "utf8");
  }
  const liveStream = options.liveOutputPath
    ? createWriteStream(options.liveOutputPath, { flags: "a" })
    : undefined;

  return await new Promise<CommandRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ status: "failed", output: "", timedOut: false });
      return;
    }
    const child = spawn(failFastShellCommand(options.command), {
      cwd: options.cwd,
      env: sanitizeChildEnv(options.env),
      shell: true,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      const childPid = child.pid;
      if (childPid) {
        try {
          process.kill(-childPid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 1_000).unref();
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.stdin) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }

    const appendOutput = (chunk: Buffer): void => {
      options.onProgress?.();
      liveStream?.write(chunk);
      if (outputBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - outputBytes;
        const bounded = chunk.subarray(0, remaining);
        chunks.push(bounded);
        outputBytes += bounded.byteLength;
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    if (options.onProgress) {
      options.onProgress();
      progressInterval = setInterval(options.onProgress, options.progressIntervalMs ?? 10_000);
      progressInterval.unref();
    }

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      reject(error);
    });

    timeout = setTimeout(() => {
      timedOut = true;
      const childPid = child.pid;
      if (childPid) {
        try {
          process.kill(-childPid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }

        setTimeout(() => {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 1_000).unref();
      }
    }, options.timeoutMs);

    child.on("close", async (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      options.signal?.removeEventListener("abort", onAbort);

      const output = Buffer.concat(chunks).toString("utf8");
      if (options.liveOutputPath) {
        await new Promise<void>((streamResolve) => {
          liveStream?.end(streamResolve);
        });
      }

      if (aborted) {
        resolve({ status: "failed", output, timedOut: false });
        return;
      }

      if (timedOut) {
        resolve({ status: "timed_out", output, timedOut });
        return;
      }

      if (exitCode === 0) {
        resolve({ status: "succeeded", exitCode: 0, output, timedOut });
        return;
      }

      resolve({
        status: "failed",
        ...(exitCode === null ? {} : { exitCode }),
        output,
        timedOut
      });
    });
  });
}

export async function withPeriodicProgress<T>(
  onProgress: (() => void) | undefined,
  run: () => Promise<T>,
  intervalMs = 10_000
): Promise<T> {
  if (!onProgress) {
    return await run();
  }

  onProgress();
  const interval = setInterval(onProgress, intervalMs);
  interval.unref();

  try {
    return await run();
  } finally {
    clearInterval(interval);
  }
}

function failFastShellCommand(command: string): string {
  return ["set -e", command].join("\n");
}
