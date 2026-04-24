import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
}

export async function runTemporalWorker(options: RunTemporalWorkerOptions = {}): Promise<void> {
  const config = normalizeTemporalConfig(options);
  const connection = await NativeConnection.connect({ address: config.address });
  const workflowBundle = await buildWorkflowBundle();
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
          "(for example, `workflows install dist/workflow-bundles/simpleWorkflow`), " +
          `then restart with \`tychonic runtime up --instance ${activeInstance}\`.`
      );
    }
    throw new Error(
      "no workflow bundles installed. Reinstall the Tychonic service with " +
        "`tychonic service install` to restore the packaged workflow bundles, " +
        "or add an operator-supplied bundle with `tychonic workflows install <directory>`."
    );
  }
  await assertNoInstalledWorkflowExportConflicts(installedBundles);

  const generatedDir = join(tychonicRuntimeDirs().stateDir, "workflows");
  await mkdir(generatedDir, { recursive: true });
  const combinedPath = join(await realpath(generatedDir), "combined-workflows.mjs");
  // Each bundle's directory name equals the single workflow function it
  // exports (see SPEC §Workflow Modules → Required state declaration).
  // Re-export only that named function so bundle-private exports like
  // `requires` or helper functions do not collide in the combined module.
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

/**
 * Bundle every installed workflow module with a webpack `resolve.modules`
 * extension that points at the Tychonic package's own `node_modules`.
 * Every module in `~/Library/Application Support/Tychonic/workflows/modules/`
 * — packaged or operator-installed — goes through the same path; the
 * worker draws no distinction. Webpack's default upward `node_modules`
 * walk finds nothing under that directory, so adding the Tychonic
 * package's `node_modules` to the resolver lets workflow authors write
 * plain `import { proxyActivities } from "@temporalio/workflow"`
 * without any install-time symlink or packaging step. SPEC §Plugin
 * Composition Path.
 */
export async function buildWorkflowBundle(): Promise<{ code: string }> {
  const workflowsPath = await resolveWorkflowModulePath();
  const extraResolveDirs = tychonicWebpackResolveDirs();
  return bundleWorkflowCode({
    workflowsPath,
    webpackConfigHook: (config) => {
      config.resolve = config.resolve ?? {};
      const existing = config.resolve.modules ?? [];
      config.resolve.modules = [...extraResolveDirs, ...existing];
      return config;
    }
  });
}

function tychonicWebpackResolveDirs(): string[] {
  const require = createRequire(import.meta.url);
  const dirs = new Set<string>();
  // Walk up from the compiled worker.js to find the nearest node_modules; that's
  // the tychonic package's own install. Works whether the package is installed
  // under a user prefix (npm -g, launchd `~/Library/Application Support`) or
  // resolved out of the source checkout during development.
  try {
    const workflowPkg = require.resolve("@temporalio/workflow/package.json");
    dirs.add(dirname(dirname(dirname(workflowPkg))));
  } catch {
    // fall through to the structural guess below
  }
  dirs.add(resolve(fileURLToPath(import.meta.url), "..", "..", "..", "node_modules"));
  return [...dirs];
}
