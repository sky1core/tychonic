import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duration } from "@temporalio/common";
import { bundleWorkflowCode, NativeConnection, Worker, type BundleOptions } from "@temporalio/worker";
import * as activities from "../activities/index.js";
import { normalizeTemporalConfig, tychonicRuntimeDirs, type TemporalConfig } from "./manager.js";
import {
  assertNoInstalledWorkflowExportConflicts,
  listRuntimeWorkflowModules,
  workflowModuleFileUrl
} from "./workflowModules.js";
import { getActiveInstance } from "../runtime/instance.js";

const requireFromHere = createRequire(import.meta.url);
const temporalWorkflowPackageRoot = dirname(requireFromHere.resolve("@temporalio/workflow/package.json"));
const moduleFilePath = fileURLToPath(import.meta.url);
const tychonicWorkflowHelperPath = join(dirname(dirname(moduleFilePath)), `workflow${extname(moduleFilePath)}`);
type WebpackConfig = Parameters<NonNullable<BundleOptions["webpackConfigHook"]>>[0];

// Local operation favors letting in-flight activities reach their own configured
// command timeout instead of cancelling them during worker shutdown.
export const DEFAULT_WORKER_SHUTDOWN_GRACE_TIME = "24h" as Duration;
export const WORKER_SHUTDOWN_GRACE_TIME_ENV = "TYCHONIC_WORKER_SHUTDOWN_GRACE_TIME";
export const DEFAULT_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL = "5s" as Duration;
export const WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL_ENV = "TYCHONIC_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL";
export const DEFAULT_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL = "5s" as Duration;
export const WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL_ENV =
  "TYCHONIC_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL";

export interface RunTemporalWorkerOptions extends TemporalConfig {
  shutdownSignals?: boolean;
  shutdownGraceTime?: string | number;
  shutdownForceTime?: string | number;
  workflowBundle?: { code: string };
  onReady?: () => void | Promise<void>;
}

export async function runTemporalWorker(options: RunTemporalWorkerOptions = {}): Promise<void> {
  const config = normalizeTemporalConfig(options);
  const connection = await NativeConnection.connect({ address: config.address });
  const workflowBundle = options.workflowBundle ?? (await buildWorkflowBundle());
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowBundle,
    maxHeartbeatThrottleInterval:
      durationEnv(WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL_ENV, DEFAULT_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL),
    defaultHeartbeatThrottleInterval:
      durationEnv(WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL_ENV, DEFAULT_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL),
    shutdownGraceTime:
      (options.shutdownGraceTime as Duration | undefined) ??
      durationEnv(WORKER_SHUTDOWN_GRACE_TIME_ENV, DEFAULT_WORKER_SHUTDOWN_GRACE_TIME),
    ...(options.shutdownForceTime ? { shutdownForceTime: options.shutdownForceTime as Duration } : {}),
    activities
  });

  if (options.shutdownSignals ?? true) {
    let shutdownStarted = false;
    const shutdown = (): void => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      try {
        worker.shutdown();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Not running")) {
          process.stderr.write(`tychonic worker: shutdown request failed: ${message}\n`);
        }
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      const run = worker.run();
      try {
        await options.onReady?.();
        await run;
      } catch (error) {
        shutdown();
        throw error;
      }
    } finally {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
    return;
  }

  const run = worker.run();
  try {
    await options.onReady?.();
    await run;
  } catch (error) {
    worker.shutdown();
    throw error;
  }
}

function durationEnv(name: string, fallback: Duration): Duration {
  return (process.env[name] ?? fallback) as Duration;
}

/**
 * Resolve the path the Temporal workflow bundler compiles. The worker
 * has exactly one workflow-loading path: read every `.mjs` file under
 * `<state>/workflows/modules/` and re-export from all of them. Bundles arrive
 * there only through an explicit install operation such as
 * `tychonic workflows install <directory>`. The worker does not seed bundled
 * examples, re-seed missing workflows, repair the registry, or choose an
 * alternate source — if the modules directory is empty, workflow work cannot
 * run and the error message points the operator at the install commands.
 */
export async function resolveWorkflowModulePath(): Promise<string> {
  const installedBundles = await Promise.all(
    (await listRuntimeWorkflowModules()).map(async (bundle) => ({
      ...bundle,
      workflowPath: await realpath(bundle.workflowPath)
    }))
  );
  if (installedBundles.length === 0) {
    const activeInstance = getActiveInstance();
    if (activeInstance !== undefined) {
      throw new Error(
        `no workflow bundles installed in instance '${activeInstance}'. ` +
          `Install a bundle with \`tychonic workflows install <directory> --instance ${activeInstance}\` ` +
          "(for example, `workflows install ./examples/workflows/simpleWorkflow`), " +
          `then restart with \`tychonic runtime up --instance ${activeInstance}\`.`
      );
    }
    throw new Error(
      "no workflow bundles installed. Add an operator-supplied bundle with " +
        "`tychonic workflows install <directory>` (for example, " +
        "`tychonic workflows install ./examples/workflows/simpleWorkflow`)."
    );
  }
  await assertNoInstalledWorkflowExportConflicts(installedBundles);

  // Keep the entrypoint inside a real installed bundle package so dependencies
  // shipped with that bundle resolve through the standard package layout.
  const generatedDir = join(dirname(installedBundles[0]!.workflowPath), ".tychonic");
  await mkdir(generatedDir, { recursive: true });
  const combinedPath = join(await realpath(generatedDir), "combined-workflows.mjs");
  // Each bundle's directory name equals the single workflow function it
  // exports (see src/temporal/SPEC.md §Workflow-default Profile).
  // Re-export only that named function so bundle-private exports like
  // `defaultProfile` or helper functions do not collide in the combined
  // module.
  const lines = installedBundles.map((bundle) => {
    const url = workflowModuleFileUrl(bundle.workflowPath);
    return `export { ${bundle.name} } from ${JSON.stringify(url)};`;
  });
  await writeFile(
    combinedPath,
    ["// Generated by Tychonic. Do not edit.", ...lines, ""].join("\n"),
    "utf8"
  );
  return combinedPath;
}

export async function buildWorkflowBundle(): Promise<{ code: string }> {
  const workflowsPath = await resolveWorkflowModulePath();
  return bundleWorkflowCode({
    workflowsPath,
    webpackConfigHook: withTychonicWorkflowSdkResolver
  });
}

function withTychonicWorkflowSdkResolver(config: WebpackConfig): WebpackConfig {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        "@temporalio/workflow": temporalWorkflowPackageRoot,
        "tychonic/workflow": tychonicWorkflowHelperPath
      }
    }
  };
}
