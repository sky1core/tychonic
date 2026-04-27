import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundleWorkflowCode, NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "../activities/index.js";
import { normalizeTemporalConfig, tychonicRuntimeDirs, type TemporalConfig } from "./manager.js";
import {
  assertNoInstalledWorkflowExportConflicts,
  listRuntimeWorkflowModules,
  workflowModuleFileUrl
} from "./workflowModules.js";
import { getActiveInstance } from "../runtime/instance.js";

// Local operation favors letting in-flight activities reach their own configured
// command timeout instead of cancelling them during worker shutdown.
export const DEFAULT_WORKER_SHUTDOWN_GRACE_TIME = "24h";
export const WORKER_SHUTDOWN_GRACE_TIME_ENV = "TYCHONIC_WORKER_SHUTDOWN_GRACE_TIME";
export const DEFAULT_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL = "5s";
export const WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL_ENV = "TYCHONIC_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL";
export const DEFAULT_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL = "5s";
export const WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL_ENV =
  "TYCHONIC_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL";

export interface RunTemporalWorkerOptions extends TemporalConfig {
  shutdownSignals?: boolean;
  shutdownGraceTime?: string | number;
  shutdownForceTime?: string | number;
  workflowBundle?: { code: string };
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
      process.env[WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL_ENV] ?? DEFAULT_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL,
    defaultHeartbeatThrottleInterval:
      process.env[WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL_ENV] ??
      DEFAULT_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL,
    shutdownGraceTime:
      options.shutdownGraceTime ?? process.env[WORKER_SHUTDOWN_GRACE_TIME_ENV] ?? DEFAULT_WORKER_SHUTDOWN_GRACE_TIME,
    ...(options.shutdownForceTime ? { shutdownForceTime: options.shutdownForceTime } : {}),
    activities
  });

  if (options.shutdownSignals ?? true) {
    const shutdown = (): void => {
      worker.shutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  await worker.run();
}

/**
 * Resolve the path the Temporal workflow bundler compiles. The worker
 * has exactly one workflow-loading path: read every `.mjs` file under
 * `<state>/workflows/modules/` and re-export from all of them. Whether
 * a file was placed there by `tychonic service install` (the workflow
 * bundle packaged with tychonic) or by `tychonic workflows install`
 * (an operator-supplied bundle) makes no difference at load time. The
 * worker does not re-seed, repair, or fall back — if the modules
 * directory is empty, workflow work cannot run and the error message
 * points the operator at the install commands.
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

  // The Temporal bundler's generated entrypoint imports
  // `@temporalio/workflow` relative to `workflowsPath`. Keep that path inside
  // a real installed bundle package so standard package resolution can find
  // the bundle's own dependencies. Do not inject Tychonic's node_modules.
  const generatedDir = join(dirname(installedBundles[0]!.workflowPath), ".tychonic");
  await mkdir(generatedDir, { recursive: true });
  const combinedPath = join(await realpath(generatedDir), "combined-workflows.mjs");
  // Each bundle's directory name equals the single workflow function it
  // exports (see SPEC §Workflow Modules → Workflow-default profile).
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
  return bundleWorkflowCode({ workflowsPath });
}
