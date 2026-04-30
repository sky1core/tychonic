#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command, Option } from "commander";
import { stringify } from "yaml";
import {
  assertTychonicWorkflowResult,
  artifactContentPath,
  listAgentSessions,
  listArtifacts,
  listInboxItems,
  listLiveOutputAttemptViews,
  liveOutputContentPath,
  workflowEvidenceView,
  workflowResultView,
  type TychonicWorkflowResult
} from "./temporalResultViews.js";
import { applyConfigOrDefaultProfileToRunInput } from "./runWorkflowInput.js";
import { stoppedWorkflowCliPayload } from "./waitMessages.js";
import {
  loadBundleDefaultProfile,
  resolveEffectiveBundleConfig
} from "../catalog/bundleConfig.js";
import { productName } from "../index.js";
import {
  getActiveInstance,
  setActiveInstance,
  validateInstanceName
} from "../runtime/instance.js";
import {
  spawnDetachedRuntime,
  readPidFile,
  isProcessAlive,
  writePidFile,
  removePidFileIfOwned
} from "../runtime/detached.js";
import { killAndRemoveInstance } from "../runtime/reset.js";
import { stopRuntimeParent } from "../runtime/stop.js";
import {
  replaceLaunchdWorker,
  installLaunchdServices,
  restartLaunchdService,
  statusLaunchdServices,
  uninstallLaunchdServices
} from "../service/launchd.js";
import {
  describeTychonicTemporalWorkflow,
  listTychonicTemporalWorkflows,
  queryInteractionPendingState,
  signalInteractionApproveState,
  signalInteractionModifyState,
  signalInteractionRejectState,
  signalNamedWorkflow,
  startNamedTemporalWorkflow,
  waitForTychonicWorkflowStopped,
  type TychonicTemporalWorkflowStatus
} from "../temporal/client.js";
import type { WorkflowStateRecord } from "../domain/types.js";
import { readFile as readFileAsync } from "node:fs/promises";
import { TemporalManager, tychonicRuntimeDirs, type TemporalConfig } from "../temporal/manager.js";
import type { StateRecordPatch } from "../temporal/types.js";
import { buildWorkflowBundle, runTemporalWorker } from "../temporal/worker.js";
import { join as pathJoin } from "node:path";
import {
  installRuntimeWorkflowModule,
  listRuntimeWorkflowModules,
  removeRuntimeWorkflowModule,
  runtimeWorkflowModulesDir,
  inspectBundle
} from "../temporal/workflowModules.js";
import { validateBundleFileShape } from "../temporal/bundleValidator.js";
import { productVersion } from "../version.js";

const program = new Command();
const INSTANCE_SELECTION_HELP =
  "\nInstance selection: --instance <name> is a global option. It is accepted before or after runtime subcommands, or set TYCHONIC_INSTANCE=<name> in the shell.";

program.name(productName).description("Local AI work operations manager").version(productVersion);
program.addHelpText(
  "after",
  "\nBasic flow: install a workflow, run `tychonic runtime up`, then run `tychonic run <workflow-name> --input-file <input.json> --wait`."
);

program.addOption(
  new Option(
    "--instance <name>",
    "isolated dev instance name; derives state dir, Temporal API port, and task queue from <name>. Falls back to $TYCHONIC_INSTANCE when omitted. Unset targets the operational paths."
  ).hideHelp()
);

program.hook("preAction", (thisCommand) => {
  const cliInstance = thisCommand.opts().instance as string | undefined;
  const envInstance = process.env.TYCHONIC_INSTANCE;
  const resolved =
    cliInstance !== undefined && cliInstance.length > 0
      ? cliInstance
      : envInstance !== undefined && envInstance.length > 0
        ? envInstance
        : undefined;
  if (resolved !== undefined) {
    validateInstanceName(resolved);
    setActiveInstance(resolved);
  } else {
    setActiveInstance(undefined);
  }
});

/**
 * `_meta` field for CLI JSON responses. Append as `_meta: cliInstanceMeta()`.
 * `instance` is the resolved active instance name or `null` when unset.
 */
function cliInstanceMeta(): { instance: string | null } {
  return { instance: getActiveInstance() ?? null };
}

function hiddenTemporalModeOption(): Option {
  return new Option("--temporal-mode <mode>", "advanced runtime mode").hideHelp();
}

function hiddenTemporalPortOption(): Option {
  return new Option("--temporal-port <port>", "advanced managed-local runtime API port")
    .argParser((value) => Number(value))
    .hideHelp();
}

function hiddenTemporalAddressOption(): Option {
  return new Option("--temporal-address <address>", "advanced runtime API address").hideHelp();
}

function hiddenTemporalNamespaceOption(): Option {
  return new Option("--temporal-namespace <name>", "advanced runtime namespace").hideHelp();
}

function hiddenTemporalTaskQueueOption(): Option {
  return new Option("--temporal-task-queue <name>", "advanced runtime task queue").hideHelp();
}

function hiddenInlineInputOption(): Option {
  return new Option("--input <json>", "advanced inline JSON object to pass as workflow input").hideHelp();
}

function hiddenVisibilityQueryOption(): Option {
  return new Option("--visibility-query <query>", "advanced Temporal visibility filter for listing workflows").hideHelp();
}

function hiddenIncludeResultOption(): Option {
  return new Option("--include-result", "advanced: include the full raw Tychonic workflow result").hideHelp();
}

/**
 * Refuse operational-only commands when an isolated dev instance is active.
 * Use at the top of any `service ...` action that must never touch launchd
 * while an instance is set.
 */
function assertOperationalOnly(commandLabel: string): void {
  const active = getActiveInstance();
  if (active !== undefined) {
    throw new Error(
      `${commandLabel} is operational-only; do not combine with --instance (active instance='${active}')`
    );
  }
}

const workflowsCommand = program
  .command("workflows")
  .description("Manage installed workflow bundles in the local runtime registry");

workflowsCommand
  .command("list")
  .description("List installed workflow bundles")
  .action(async () => {
    const bundles = await listRuntimeWorkflowModules();
    const modules = await Promise.all(
      bundles.map(async (bundle) => {
        const inspection = await inspectBundle({ name: bundle.name, workflowPath: bundle.workflowPath });
        return {
          name: bundle.name,
          path: bundle.path,
          workflowPath: bundle.workflowPath,
          workflowNames: inspection.workflowFunctionNames,
          moduleExports: inspection.exportNames,
          defaultProfile: inspection.defaultProfile
        };
      })
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          directory: runtimeWorkflowModulesDir(),
          modules,
          _meta: cliInstanceMeta()
        },
        null,
        2
      )
    );
  });

workflowsCommand
  .command("validate")
  .argument("<directory>", "workflow bundle directory to validate (not installed)")
  .description("Validate a workflow bundle directory without installing it")
  .action(async (directory: string) => {
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(directory);
      validateBundleFileShape(entries);
      const inspection = await inspectBundle({
        name: workflowsBundleDirName(directory),
        workflowPath: pathJoin(directory, "workflow.mjs")
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            bundle: {
              directory,
              workflowNames: inspection.workflowFunctionNames,
              moduleExports: inspection.exportNames,
              defaultProfile: inspection.defaultProfile
            }
          },
          null,
          2
        )
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    }
  });

workflowsCommand
  .command("install")
  .argument("<directory>", "workflow bundle directory")
  .description("Install a workflow bundle and refresh the LaunchAgent worker when applicable")
  .action(async (directory: string) => {
    const bundle = await installRuntimeWorkflowModule({ sourcePath: directory });
    const replacement = await tryReplaceLaunchdWorker();
    console.log(
      JSON.stringify(
        {
          ok: true,
          module: bundle,
          directory: runtimeWorkflowModulesDir(),
          ...replacement,
          _meta: cliInstanceMeta()
        },
        null,
        2
      )
    );
  });

workflowsCommand
  .command("remove")
  .argument("<name>", "workflow bundle name")
  .description("Remove an installed workflow bundle and refresh the LaunchAgent worker when applicable")
  .action(async (name: string) => {
    const bundle = await removeRuntimeWorkflowModule(name);
    const replacement = await tryReplaceLaunchdWorker();
    console.log(
      JSON.stringify(
        {
          ok: true,
          removed: bundle,
          directory: runtimeWorkflowModulesDir(),
          ...replacement,
          _meta: cliInstanceMeta()
        },
        null,
        2
      )
    );
  });

const configCommand = program
  .command("config")
  .description("Inspect a single installed bundle's configuration");

configCommand
  .command("show")
  .requiredOption("--workflow-name <name>", "installed workflow name")
  .option("--config <file>", "one-off Tychonic config YAML file to override the bundle config", undefined)
  .option("--format <format>", "yaml or json", "yaml")
  .description("Print one installed bundle's configuration")
  .action(async (options: { workflowName: string; config?: string; format: "yaml" | "json" }) => {
    if (!["yaml", "json"].includes(options.format)) {
      throw new Error("--format must be yaml or json");
    }
    const bundleDir = await bundleDirForInstalledName(options.workflowName);
    const resolved = await resolveEffectiveBundleConfig({
      bundleDir,
      ...(options.config ? { overridePath: options.config } : {})
    });
    const payload = {
      version: "tychonic.config.show.v2" as const,
      workflow: options.workflowName,
      bundleDir,
      source: resolved.source,
      profile: resolved.profile
    };
    if (options.format === "json") {
      console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
      return;
    }
    process.stdout.write(stringify(payload));
  });

configCommand
  .command("validate")
  .requiredOption("--workflow-name <name>", "installed workflow name")
  .option("--config <file>", "one-off Tychonic config YAML file to validate against the bundle", undefined)
  .description("Validate one installed bundle's configuration")
  .action(async (options: { workflowName: string; config?: string }) => {
    try {
      const bundleDir = await bundleDirForInstalledName(options.workflowName);
      const resolved = await resolveEffectiveBundleConfig({
        bundleDir,
        ...(options.config ? { overridePath: options.config } : {})
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            version: "tychonic.config.validate.v2",
            workflow: options.workflowName,
            source: resolved.source,
            profile: resolved.profile
          },
          null,
          2
        )
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            version: "tychonic.config.validate.v2",
            workflow: options.workflowName,
            error: error instanceof Error ? error.message : String(error)
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    }
  });

const runtimeCommand = program.command("runtime").description("Run the local Tychonic runtime");

runtimeCommand
  .command("up")
  .option("--project-dir <dir>", "project directory", process.cwd())
  .option("--temporal-mode <mode>", "Temporal runtime mode: managed-local or external")
  .option("--temporal-port <port>", "managed-local Temporal API port", (value) => Number(value))
  .option("--temporal-address <address>", "Temporal API address")
  .option("--temporal-namespace <name>", "Temporal namespace")
  .option("--temporal-task-queue <name>", "Temporal task queue")
  .option("--shutdown-grace-time <duration>", "worker drain time on shutdown before cancelling in-flight activities")
  .option(
    "--detach",
    "spawn the runtime in a new session and exit; requires an active instance from --instance or TYCHONIC_INSTANCE. PID is written under <stateDir>/runtime.pid, stdout/stderr tee into <logDir>/runtime.log.",
    false
  )
  .description("Start Temporal if needed, then run the worker in the foreground")
  .addHelpText("after", INSTANCE_SELECTION_HELP)
  .action(
    async (options: {
      projectDir: string;
      temporalMode?: TemporalConfig["mode"];
      temporalPort?: number;
      temporalAddress?: string;
      temporalNamespace?: string;
      temporalTaskQueue?: string;
      shutdownGraceTime?: string;
      detach?: boolean;
    }) => {
      if (options.detach) {
        await handleRuntimeUpDetach(options);
        return;
      }
      // Pre-check for isolated instance: bundles are explicit, not provided
      // by `service install`. Starting Temporal first and letting the worker
      // discover an empty registry would orphan the Temporal child process
      // when the worker crashes, and would leave the operator with an
      // already-open port to reset. Fail fast instead.
      {
        const activeInstance = getActiveInstance();
        if (activeInstance !== undefined) {
          const installed = await listRuntimeWorkflowModules();
          if (installed.length === 0) {
            throw new Error(
              `no workflow bundles installed in instance '${activeInstance}'. ` +
                `Install a bundle with \`tychonic workflows install <directory> --instance ${activeInstance}\` ` +
                "(for example, `workflows install ./examples/workflows/simpleWorkflow`), " +
                `then rerun \`tychonic runtime up --instance ${activeInstance}\`.`
            );
          }
        }
      }
      const foregroundRuntimePidFile = await claimForegroundRuntimePidFileIfNeeded();
      let temporalManagerForCleanup: TemporalManager | undefined;
      let stopTemporalOnFailure = false;
      try {
        const workflowBundle = await buildWorkflowBundle();
        const temporalConfig = temporalConfigFromOptions(options);
        const manager = new TemporalManager(temporalConfig);
        temporalManagerForCleanup = manager;
        // `inheritProcessGroup: true` keeps the spawned Temporal child in
        // this runtime parent's pgid. When the outer CLI invocation was
        // `runtime up --detach`, that pgid is the runtime parent's own
        // (the parent was spawned with `{ detached: true }`). `runtime
        // reset` then signals the entire group with `kill(-pgid)` and the
        // temporal child cannot orphan.
        const temporal = await manager.start({ inheritProcessGroup: true });
        stopTemporalOnFailure = temporal.health === "starting";
        await waitForTemporalReady(manager);
        // Install a SIGTERM/SIGINT cascade so the polite shutdown path
        // also reaches the temporal child. Process-group kill from
        // `runtime reset` already covers the SIGTERM-from-reset case;
        // this handler covers Ctrl-C in the foreground tty and any
        // direct `kill <runtimePid>` (without `-pgid`). SIGKILL is
        // uncatchable, so the structural process-group guarantee remains
        // the safety net.
        const temporalChildPid = temporal.pid;
        const cascadeAndExit = (signal: NodeJS.Signals): void => {
          if (typeof temporalChildPid === "number" && temporalChildPid > 0) {
            try {
              process.kill(temporalChildPid, signal);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              // ESRCH: the temporal child already exited. Anything else is
              // logged but does not block the parent's own shutdown — the
              // outer `runtime reset` will take a second pass.
              if (code !== "ESRCH") {
                process.stderr.write(
                  `tychonic runtime: failed to forward ${signal} to temporal pid ` +
                    `${temporalChildPid}: ${(error as Error).message}\n`
                );
              }
            }
          }
          // Re-raise the original signal with its default disposition so
          // the runtime parent itself exits with the conventional 128+sig
          // code. Removing our handler before re-raising avoids recursion.
          process.removeListener("SIGTERM", onSigterm);
          process.removeListener("SIGINT", onSigint);
          // Defer to the next tick so the listener removal completes
          // before the second delivery.
          process.nextTick(() => {
            process.kill(process.pid, signal);
          });
        };
        const onSigterm = (): void => cascadeAndExit("SIGTERM");
        const onSigint = (): void => cascadeAndExit("SIGTERM");
        process.on("SIGTERM", onSigterm);
        process.on("SIGINT", onSigint);

        console.log(
          JSON.stringify(
            {
              ok: true,
              mode: "foreground",
              temporal,
              worker: { status: "running" },
              ...(getActiveInstance()
                ? { stopCommand: `tychonic runtime stop --instance ${getActiveInstance()}` }
                : {}),
              workflows: { modules: await listRuntimeWorkflowModules() },
              _meta: cliInstanceMeta()
            },
            null,
            2
          )
        );

        await runTemporalWorker({
          ...temporalConfig,
          workflowBundle,
          ...(options.shutdownGraceTime ? { shutdownGraceTime: options.shutdownGraceTime } : {})
        });
      } catch (error) {
        if (stopTemporalOnFailure && temporalManagerForCleanup) {
          try {
            await temporalManagerForCleanup.stop();
          } catch (stopError) {
            process.stderr.write(
              `tychonic runtime: failed to stop Temporal after runtime startup failure: ${
                stopError instanceof Error ? stopError.message : String(stopError)
              }\n`
            );
          }
        }
        throw error;
      } finally {
        if (foregroundRuntimePidFile) {
          await removePidFileIfOwned(foregroundRuntimePidFile, process.pid);
        }
      }
    }
  );

runtimeCommand
  .command("reset", { hidden: true })
  .option("--yes", "skip the interactive confirmation prompt", false)
  .description(
    "Terminate the runtime for --instance <name> (SIGTERM → 10s → SIGKILL) and remove its state/log directories. Refuses to operate without --instance."
  )
  .action(async (options: { yes?: boolean }) => {
    await handleRuntimeReset({ yes: Boolean(options.yes) });
  });

runtimeCommand
  .command("stop")
  .description("Gracefully stop an isolated runtime for --instance <name> or TYCHONIC_INSTANCE")
  .addHelpText("after", INSTANCE_SELECTION_HELP)
  .action(async () => {
    await handleRuntimeStop();
  });

program
  .command("run")
  .argument("<workflow-name>", "installed workflow name")
  .addOption(hiddenInlineInputOption())
  .option("--input-file <file>", "path to a JSON object file containing the workflow input")
  .option(
    "--config <file>",
    "one-off Tychonic config YAML/JSON file that replaces the bundle's defaultProfile for this invocation"
  )
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .option("--workflow-id <id>", "workflow id")
  .option("--wait", "wait until the workflow needs caller action or returns a result")
  .description("Start a Tychonic workflow")
  .action(async (workflowName: string, options: RunCommandOptions) => {
    await startNamedWorkflowFromCli(workflowName, options);
  });

program
  .command("wait")
  .argument("<workflow-id>", "workflow id")
  .option("--run-id <id>", "workflow run id")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("Wait until a Tychonic workflow needs caller action or returns a result")
  .action(
    async (
      workflowId: string,
      options: TemporalCliOptions & {
        runId?: string;
      }
    ) => {
      const result = await waitForStoppedWorkflowFromCli({
        workflowId,
        ...(options.runId ? { runId: options.runId } : {}),
        ...temporalConfigFromOptions(options)
      });
      console.log(
        JSON.stringify(
          { ok: true, mode: "tychonic", ...stoppedWorkflowCliPayload(result), _meta: cliInstanceMeta() },
          null,
          2
        )
      );
    }
  );

program
  .command("signal", { hidden: true })
  .argument("<workflow-id>", "Temporal workflow id")
  .argument("<signal-name>", "Temporal signal name registered by the workflow")
  .option("--run-id <id>", "Temporal run id")
  .option("--payload-file <path>", "JSON file whose parsed contents are the signal payload")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("Send an arbitrary Temporal signal with optional JSON payload to a running workflow")
  .action(
    async (
      workflowId: string,
      signalName: string,
      options: {
        runId?: string;
        payloadFile?: string;
        temporalMode?: TemporalConfig["mode"];
        temporalPort?: number;
        temporalAddress?: string;
        temporalNamespace?: string;
        temporalTaskQueue?: string;
      }
    ) => {
      if (typeof workflowId !== "string" || workflowId.length === 0) {
        throw new Error("workflow-id must be a non-empty string");
      }
      if (typeof signalName !== "string" || signalName.length === 0) {
        throw new Error("signal-name must be a non-empty string");
      }
      let payload: unknown;
      if (options.payloadFile) {
        let raw: string;
        try {
          raw = await readFileAsync(options.payloadFile, "utf8");
        } catch (error) {
          throw new Error(
            `failed to read --payload-file ${options.payloadFile}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          throw new Error(
            `--payload-file ${options.payloadFile} contains invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      const result = await signalNamedWorkflow({
        workflowId,
        signalName,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(payload !== undefined ? { payload } : {}),
        ...temporalConfigFromOptions(options)
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "temporal",
            signalName,
            ...result,
            _meta: cliInstanceMeta()
          },
          null,
          2
        )
      );
    }
  );

program
  .command("status")
  .option("--workflow-id <id>", "workflow id to describe")
  .option("--run-id <id>", "workflow run id to describe")
  .option("--limit <n>", "maximum workflows to list", (value) => Number(value), 20)
  .addOption(hiddenIncludeResultOption())
  .addOption(hiddenVisibilityQueryOption())
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("Inspect workflow status")
  .action(
    async (options: {
      workflowId?: string;
      runId?: string;
      limit: number;
      includeResult?: boolean;
      visibilityQuery?: string;
      temporalMode?: TemporalConfig["mode"];
      temporalPort?: number;
      temporalAddress?: string;
      temporalNamespace?: string;
      temporalTaskQueue?: string;
    }) => {
      if (options.runId && !options.workflowId) {
        throw new Error("--run-id requires --workflow-id");
      }
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
      }

      if (options.workflowId) {
        const workflow = await describeTychonicTemporalWorkflow({
          workflowId: options.workflowId,
          ...(options.runId ? { runId: options.runId } : {}),
          includeResult: true,
          ...temporalConfigFromOptions(options)
        });
        const output: Record<string, unknown> = {
          ok: true,
          mode: "temporal"
        };
        if (workflow.result !== undefined) {
          try {
            assertTychonicWorkflowResult(workflow.result);
            output.evidence = workflowEvidenceView(workflow.result, workflow.workflowId, workflow.runId);
          } catch (error) {
            output.evidenceError = error instanceof Error ? error.message : String(error);
          }
        }
        output.workflow = options.includeResult ? workflow : workflowStatusWithoutRawResult(workflow);
        output._meta = cliInstanceMeta();
        console.log(
          JSON.stringify(output, null, 2)
        );
        return;
      }

      const result = await listTychonicTemporalWorkflows({
        limit: options.limit,
        ...(options.visibilityQuery ? { query: options.visibilityQuery } : {}),
        ...temporalConfigFromOptions(options)
      });
      console.log(
        JSON.stringify({ ok: true, mode: "temporal", ...result, _meta: cliInstanceMeta() }, null, 2)
      );
    }
  );

program
  .command("approve")
  .argument("<workflow-id>", "workflow id")
  .option("--state <name>", "workflow state name to approve; when omitted, queried from the workflow")
  .option("--run-id <id>", "workflow run id")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("Approve the currently gated interactive state")
  .action(
    async (
      workflowId: string,
      options: Omit<RequiredTemporalResultCommandOptions, "workflowId"> & {
        state?: string;
      }
    ) => {
      const state = await resolveInteractionState({
        workflowId,
        ...(options.state !== undefined ? { explicitState: options.state } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...temporalConfigFromOptions(options)
      });
      const result = await signalInteractionApproveState({
        workflowId,
        state,
        ...(options.runId ? { runId: options.runId } : {}),
        ...temporalConfigFromOptions(options)
      });
      console.log(
        JSON.stringify(
          { ok: true, mode: "temporal", state, ...result, _meta: cliInstanceMeta() },
          null,
          2
        )
      );
    }
  );

program
  .command("reject")
  .argument("<workflow-id>", "workflow id")
  .requiredOption("--feedback <text>", "non-empty feedback string delivered to the retried state")
  .option("--state <name>", "workflow state name to reject; when omitted, queried from the workflow")
  .option("--run-id <id>", "workflow run id")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("Reject the currently gated interactive state with feedback")
  .action(
    async (
      workflowId: string,
      options: Omit<RequiredTemporalResultCommandOptions, "workflowId"> & {
        state?: string;
        feedback: string;
      }
    ) => {
      if (typeof options.feedback !== "string" || options.feedback.length === 0) {
        throw new Error("--feedback must be a non-empty string");
      }
      const state = await resolveInteractionState({
        workflowId,
        ...(options.state !== undefined ? { explicitState: options.state } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...temporalConfigFromOptions(options)
      });
      const result = await signalInteractionRejectState({
        workflowId,
        state,
        feedback: options.feedback,
        ...(options.runId ? { runId: options.runId } : {}),
        ...temporalConfigFromOptions(options)
      });
      console.log(
        JSON.stringify(
          { ok: true, mode: "temporal", state, ...result, _meta: cliInstanceMeta() },
          null,
          2
        )
      );
    }
  );

program
  .command("modify")
  .argument("<workflow-id>", "workflow id")
  .option("--state <name>", "workflow state name to modify; when omitted, queried from the workflow")
  .option("--status <status>", "set state.status (succeeded|failed|skipped|blocked|timed_out)")
  .option("--reason <text>", "set state.reason")
  .option("--note <text>", "append a short note (becomes reason when reason is absent)")
  .option("--patch-file <path>", "JSON file containing state patch fields (status/reason/note/artifacts/findings)")
  .option("--run-id <id>", "workflow run id")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("Patch the pending interactive state")
  .action(
    async (
      workflowId: string,
      options: Omit<RequiredTemporalResultCommandOptions, "workflowId"> & {
        state?: string;
        status?: string;
        reason?: string;
        note?: string;
        patchFile?: string;
      }
    ) => {
      const state = await resolveInteractionState({
        workflowId,
        ...(options.state !== undefined ? { explicitState: options.state } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...temporalConfigFromOptions(options)
      });
      const patch = await composePatchFromCliOptions({
        ...(options.patchFile ? { patchFile: options.patchFile } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.note ? { note: options.note } : {})
      });
      const result = await signalInteractionModifyState({
        workflowId,
        state,
        patch,
        ...(options.runId ? { runId: options.runId } : {}),
        ...temporalConfigFromOptions(options)
      });
      console.log(
        JSON.stringify(
          { ok: true, mode: "temporal", state, ...result, _meta: cliInstanceMeta() },
          null,
          2
        )
      );
    }
  );

program
  .command("artifacts")
  .requiredOption("--workflow-id <id>", "workflow id")
  .option("--run-id <id>", "workflow run id")
  .option("--artifact <id>", "artifact id to print")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("List or print workflow artifacts")
  .action(async (options: RequiredTemporalResultCommandOptions & { artifact?: string }) => {
    const result = await loadTemporalWorkflowResult(options);
    if (options.artifact) {
      process.stdout.write(await readFile(artifactContentPath(result, options.artifact), "utf8"));
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "temporal",
          workflow_id: options.workflowId,
          ...workflowResultView(result),
          artifacts: listArtifacts(result)
        },
        null,
        2
      )
    );
  });

program
  .command("logs")
  .requiredOption("--workflow-id <id>", "workflow id")
  .option("--run-id <id>", "workflow run id")
  .option("--attempt <id>", "activity attempt id to print")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("List or print activity logs")
  .action(async (options: RequiredTemporalResultCommandOptions & { attempt?: string }) => {
    const result = await loadTemporalWorkflowResult(options);
    if (options.attempt) {
      process.stdout.write(await readFile(liveOutputContentPath(result, options.attempt), "utf8"));
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "temporal",
          workflow_id: options.workflowId,
          ...workflowResultView(result),
          attempts: listLiveOutputAttemptViews(result, options.workflowId, options.runId)
        },
        null,
        2
      )
    );
  });

const inboxCommand = program
  .command("inbox")
  .option("--workflow-id <id>", "workflow id")
  .option("--run-id <id>", "workflow run id")
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("List decision inbox items")
  .action(async (options: TemporalResultCommandOptions) => {
    requireWorkflowId(options);
    const result = await loadTemporalWorkflowResult(options);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "temporal",
          workflow_id: options.workflowId,
          ...workflowResultView(result),
          inbox: listInboxItems(result)
        },
        null,
        2
      )
    );
  });

function workflowStatusWithoutRawResult(
  workflow: TychonicTemporalWorkflowStatus
): Omit<TychonicTemporalWorkflowStatus, "result"> {
  const { result: _result, ...rest } = workflow;
  return rest;
}

const serviceCommand = program
  .command("service", { hidden: true })
  .description("Manage macOS launchd services for local Tychonic");

serviceCommand
  .command("install")
  .requiredOption("--project-dir <dir>", "project directory")
  .option("--temporal-port <port>", "managed-local Temporal API port", (value) => Number(value))
  .option("--node-path <path>", "advanced: Node executable path")
  .option("--cli-path <path>", "advanced: Tychonic CLI entrypoint path")
  .option("--temporal-cli-path <path>", "advanced: Temporal CLI executable path")
  .option("--worker-shutdown-grace-time <duration>", "worker drain time on shutdown before cancelling in-flight activities")
  .option("--allow-source-cli", "advanced: allow running from a source checkout; development only", false)
  .description("Install and load user LaunchAgents for Temporal and worker")
  .action(
    async (options: {
      projectDir: string;
      temporalPort?: number;
      nodePath?: string;
      cliPath?: string;
      temporalCliPath?: string;
      workerShutdownGraceTime?: string;
      allowSourceCli: boolean;
    }) => {
      assertOperationalOnly("tychonic service install");
      const result = await installLaunchdServices({
        projectDir: options.projectDir,
        ...(options.temporalPort !== undefined ? { temporalPort: options.temporalPort } : {}),
        ...(options.nodePath ? { nodePath: options.nodePath } : {}),
        ...(options.cliPath ? { cliPath: options.cliPath } : {}),
        ...(options.temporalCliPath ? { temporalCliPath: options.temporalCliPath } : {}),
        ...(options.workerShutdownGraceTime ? { workerShutdownGraceTime: options.workerShutdownGraceTime } : {}),
        allowSourceCli: options.allowSourceCli
      });
      console.log(JSON.stringify({ ok: true, service: result, _meta: cliInstanceMeta() }, null, 2));
    }
  );

serviceCommand
  .command("restart-worker")
  .option("--timeout-ms <ms>", "maximum time to wait for worker replacement", (value) => Number(value))
  .description("Start a replacement worker before gracefully retiring the old worker")
  .action(async (options: { timeoutMs?: number }) => {
    assertOperationalOnly("tychonic service restart-worker");
    console.log(
      JSON.stringify(
        {
          ok: true,
          worker_replacement: await replaceLaunchdWorker({
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
          }),
          _meta: cliInstanceMeta()
        },
        null,
        2
      )
    );
  });

serviceCommand
  .command("terminate-worker")
  .description("Send SIGTERM to the worker LaunchAgent and let launchd restart it after exit")
  .action(async () => {
    assertOperationalOnly("tychonic service terminate-worker");
    console.log(
      JSON.stringify(
        { ok: true, restart: await restartLaunchdService("worker"), _meta: cliInstanceMeta() },
        null,
        2
      )
    );
  });

serviceCommand
  .command("status")
  .description("Inspect Tychonic user LaunchAgents")
  .action(async () => {
    assertOperationalOnly("tychonic service status");
    console.log(
      JSON.stringify({ ok: true, services: await statusLaunchdServices(), _meta: cliInstanceMeta() }, null, 2)
    );
  });

serviceCommand
  .command("uninstall")
  .description("Unload and remove Tychonic user LaunchAgents")
  .action(async () => {
    assertOperationalOnly("tychonic service uninstall");
    console.log(
      JSON.stringify(
        { ok: true, service: await uninstallLaunchdServices(), _meta: cliInstanceMeta() },
        null,
        2
      )
    );
  });

const temporalCommand = program
  .command("temporal", { hidden: true })
  .description("Manage local Temporal runtime");

temporalCommand
  .command("status")
  .option("--temporal-mode <mode>", "Temporal runtime mode: managed-local or external")
  .option("--temporal-port <port>", "managed-local Temporal API port", (value) => Number(value))
  .option("--temporal-address <address>", "Temporal API address")
  .option("--temporal-namespace <name>", "Temporal namespace")
  .option("--temporal-task-queue <name>", "Temporal task queue")
  .description("Inspect Temporal runtime status")
  .action(async (options: TemporalCliOptions) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    console.log(JSON.stringify({ ok: true, status: await manager.status() }, null, 2));
  });

temporalCommand
  .command("doctor")
  .option("--temporal-mode <mode>", "Temporal runtime mode: managed-local or external")
  .option("--temporal-port <port>", "managed-local Temporal API port", (value) => Number(value))
  .option("--temporal-address <address>", "Temporal API address")
  .option("--temporal-namespace <name>", "Temporal namespace")
  .option("--temporal-task-queue <name>", "Temporal task queue")
  .description("Run Temporal runtime checks")
  .action(async (options: TemporalCliOptions) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    const report = await manager.doctor();
    console.log(JSON.stringify({ ok: report.overall !== "fail", report }, null, 2));
  });

temporalCommand
  .command("start", { hidden: true })
  .option("--temporal-mode <mode>", "Temporal runtime mode: managed-local or external")
  .option("--temporal-port <port>", "managed-local Temporal API port", (value) => Number(value))
  .option("--temporal-address <address>", "Temporal API address")
  .option("--temporal-namespace <name>", "Temporal namespace")
  .option("--temporal-task-queue <name>", "Temporal task queue")
  .description("Start or reuse managed-local Temporal")
  .action(async (options: TemporalCliOptions) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    console.log(
      JSON.stringify({ ok: true, status: await manager.start(), _meta: cliInstanceMeta() }, null, 2)
    );
  });

temporalCommand
  .command("stop", { hidden: true })
  .option("--temporal-mode <mode>", "Temporal runtime mode: managed-local only")
  .option("--temporal-port <port>", "managed-local Temporal API port", (value) => Number(value))
  .option("--temporal-address <address>", "Temporal API address")
  .option("--temporal-namespace <name>", "Temporal namespace")
  .option("--temporal-task-queue <name>", "Temporal task queue")
  .description("Stop Tychonic-managed local Temporal")
  .action(async (options: TemporalCliOptions) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    const status = await manager.stop();
    console.log(JSON.stringify({ ok: status.ok, status, _meta: cliInstanceMeta() }, null, 2));
    if (!status.ok) {
      process.exitCode = 1;
    }
  });

temporalCommand
  .command("worker", { hidden: true })
  .option("--temporal-mode <mode>", "Temporal runtime mode: managed-local or external")
  .option("--temporal-port <port>", "managed-local Temporal API port", (value) => Number(value))
  .option("--temporal-address <address>", "Temporal API address")
  .option("--temporal-namespace <name>", "Temporal namespace")
  .option("--temporal-task-queue <name>", "Temporal task queue")
  .option("--shutdown-grace-time <duration>", "worker drain time on shutdown before cancelling in-flight activities")
  .description("Run the Tychonic TypeScript Temporal worker")
  .action(async (options: {
    temporalMode?: TemporalConfig["mode"];
    temporalPort?: number;
    temporalAddress?: string;
    temporalNamespace?: string;
    temporalTaskQueue?: string;
    shutdownGraceTime?: string;
  }) => {
    await runTemporalWorker({
      ...temporalConfigFromOptions(options),
      ...(options.shutdownGraceTime ? { shutdownGraceTime: options.shutdownGraceTime } : {})
    });
  });

const sessionsCommand = program
  .command("sessions")
  .option("--workflow-id <id>", "workflow id")
  .option("--run-id <id>", "workflow run id")
  .option("--limit <n>", "maximum number of sessions", (value) => Number(value), 20)
  .addOption(hiddenTemporalModeOption())
  .addOption(hiddenTemporalPortOption())
  .addOption(hiddenTemporalAddressOption())
  .addOption(hiddenTemporalNamespaceOption())
  .addOption(hiddenTemporalTaskQueueOption())
  .description("List recorded agent sessions")
  .action(async (options: TemporalResultCommandOptions & { limit: number }) => {
    requireWorkflowId(options);
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error("--limit must be a positive integer");
    }
    const result = await loadTemporalWorkflowResult(options);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "temporal",
          workflow_id: options.workflowId,
          ...workflowResultView(result),
          sessions: listAgentSessions(result, options.limit)
        },
        null,
        2
      )
    );
  });

interface TemporalCliOptions {
  temporalMode?: TemporalConfig["mode"];
  temporalPort?: number;
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalTaskQueue?: string;
}

interface RunCommandOptions extends TemporalCliOptions {
  input?: string;
  inputFile?: string;
  config?: string;
  workflowId?: string;
  wait?: boolean;
}

async function startNamedWorkflowFromCli(workflowName: string, options: RunCommandOptions): Promise<void> {
  const rawInput = await resolveRunWorkflowInput(options);
  const workflowInput = await applyConfigOrDefaultProfileToRunInput({
    rawInput,
    ...(options.config ? { configPath: options.config } : {}),
    loadDefaultProfile: async () => {
      const bundleDir = await bundleDirForInstalledName(workflowName);
      return loadBundleDefaultProfile(bundleDir);
    }
  });
  const temporalConfig = temporalConfigFromOptions(options);
  const result = await startNamedTemporalWorkflow({
    workflowType: workflowName,
    ...(workflowInput.hasInput ? { input: workflowInput.input } : {}),
    wait: false,
    ...temporalConfig,
    ...(options.workflowId ? { workflowId: options.workflowId } : {})
  });
  if (options.wait) {
    const waitResult = await waitForStoppedWorkflowFromCli({
      workflowId: result.workflowId,
      runId: result.firstExecutionRunId,
      ...temporalConfig
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "tychonic",
          ...stoppedWorkflowCliPayload(waitResult),
          _meta: cliInstanceMeta()
        },
        null,
        2
      )
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "tychonic",
        message: `Workflow started. To wait until it needs caller action or returns a result, run \`tychonic wait ${result.workflowId}\`.`,
        workflowId: result.workflowId,
        runId: result.firstExecutionRunId,
        _meta: cliInstanceMeta()
      },
      null,
      2
    )
  );
}

async function waitForStoppedWorkflowFromCli(options: {
  workflowId: string;
  runId?: string;
  temporalMode?: TemporalConfig["mode"];
  temporalPort?: number;
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalTaskQueue?: string;
}): Promise<Awaited<ReturnType<typeof waitForTychonicWorkflowStopped>>> {
  return waitForTychonicWorkflowStopped({
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...temporalConfigFromOptions(options)
  });
}

async function resolveRunWorkflowInput(options: RunCommandOptions): Promise<{ hasInput: boolean; input?: unknown }> {
  if (options.input && options.inputFile) {
    throw new Error("--input and --input-file are mutually exclusive");
  }

  if (!options.input && !options.inputFile) {
    return { hasInput: false };
  }

  const raw = options.inputFile ? await readFile(options.inputFile, "utf8") : options.input;
  const label = options.inputFile ? `--input-file ${options.inputFile}` : "--input";
  try {
    return {
      hasInput: true,
      input: JSON.parse(raw ?? "null")
    };
  } catch (error) {
    throw new Error(`invalid workflow input JSON from ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface TemporalResultCommandOptions extends TemporalCliOptions {
  workflowId?: string;
  runId?: string;
}

/**
 * Resolve the state NAME for an interactive CLI command. When the
 * operator passes `--state` explicitly we use that value verbatim.
 * Otherwise we query the workflow's `interactionPendingStateQueryName`
 * and surface a clear error when the workflow has no currently-gated
 * state (auto mode, plugin without the hook, query timeout).
 */
async function resolveInteractionState(options: {
  workflowId: string;
  explicitState?: string;
  runId?: string;
  temporalMode?: TemporalConfig["mode"];
  temporalPort?: number;
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalTaskQueue?: string;
}): Promise<string> {
  if (options.explicitState !== undefined) {
    if (options.explicitState.length === 0) {
      throw new Error("--state must be a non-empty string");
    }
    return options.explicitState;
  }
  const queryResult = await queryInteractionPendingState({
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...temporalConfigFromOptions(options)
  });
  if (queryResult.resultError) {
    throw new Error(
      `pending-state query failed: ${queryResult.resultError}. Re-try or pass --state explicitly.`
    );
  }
  if (!queryResult.pendingState) {
    throw new Error(
      "workflow has no pending interactive state; pass --state explicitly or verify the workflow is running in interactive mode"
    );
  }
  return queryResult.pendingState;
}

async function composePatchFromCliOptions(options: {
  patchFile?: string;
  status?: string;
  reason?: string;
  note?: string;
}): Promise<StateRecordPatch> {
  const patch: Record<string, unknown> = {};

  if (options.patchFile) {
    let raw: string;
    try {
      raw = await readFileAsync(options.patchFile, "utf8");
    } catch (error) {
      throw new Error(
        `failed to read --patch-file ${options.patchFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `--patch-file ${options.patchFile} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`--patch-file ${options.patchFile} must contain a JSON object with state patch fields`);
    }
    Object.assign(patch, parsed);
  }

  if (options.status !== undefined) patch.status = options.status;
  if (options.reason !== undefined) patch.reason = options.reason;
  if (options.note !== undefined) patch.note = options.note;

  return patch as StateRecordPatch;
}

interface RequiredTemporalResultCommandOptions extends TemporalResultCommandOptions {
  workflowId: string;
}

function requireWorkflowId(options: TemporalResultCommandOptions): asserts options is RequiredTemporalResultCommandOptions {
  if (!options.workflowId) {
    throw new Error("--workflow-id is required");
  }
}

async function loadTemporalWorkflowResult(options: RequiredTemporalResultCommandOptions): Promise<TychonicWorkflowResult> {
  const workflow = await describeTychonicTemporalWorkflow({
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    includeResult: true,
    ...temporalConfigFromOptions(options)
  });

  if (!workflow.result) {
    const suffix = workflow.resultError ? `: ${workflow.resultError}` : "";
    throw new Error(`Temporal workflow result is unavailable while status is ${workflow.status}${suffix}`);
  }
  assertTychonicWorkflowResult(workflow.result);
  return workflow.result;
}

function workflowsBundleDirName(directory: string): string {
  const absolute = resolveAbsolute(directory).replace(/[\\/]+$/, "");
  const idx = Math.max(absolute.lastIndexOf("/"), absolute.lastIndexOf("\\"));
  const name = idx < 0 ? absolute : absolute.slice(idx + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`bundle directory name ${JSON.stringify(name)} does not match ^[A-Za-z0-9][A-Za-z0-9_.-]*$`);
  }
  return name;
}

function resolveAbsolute(path: string): string {
  if (path.startsWith("/")) return path;
  return pathJoin(process.cwd(), path);
}

async function bundleDirForInstalledName(name: string): Promise<string> {
  const bundles = await listRuntimeWorkflowModules();
  const match = bundles.find((bundle) => bundle.name === name);
  if (!match) {
    throw new Error(
      `no installed workflow named ${JSON.stringify(name)}. ` +
        "Run `tychonic workflows list` to list installed bundles."
    );
  }
  return match.path;
}

async function tryReplaceLaunchdWorker(): Promise<{ worker_replacement: unknown | null; note?: string }> {
  const active = getActiveInstance();
  if (active !== undefined) {
    return {
      worker_replacement: null,
      note:
        `instance='${active}' is a foreground-only isolated instance. ` +
        `If its runtime is already running, stop it with 'tychonic runtime stop --instance ${active}' ` +
        `and restart with 'tychonic runtime up --instance ${active}' ` +
        `(or 'tychonic runtime up --instance ${active} --detach') to pick up the new bundle. ` +
        `When TYCHONIC_INSTANCE=${active} is set in the shell, the --instance flag may be omitted.`
    };
  }
  try {
    const services = await statusLaunchdServices();
    const worker = services.find((service) => service.name === "worker");
    if (!worker || !worker.loaded) {
      return {
        worker_replacement: null,
        note: "The worker LaunchAgent is not loaded; the next manual worker start will pick up the installed bundles."
      };
    }
    return { worker_replacement: await replaceLaunchdWorker() };
  } catch (error) {
    return {
      worker_replacement: null,
      note: `Worker replacement was skipped: ${error instanceof Error ? error.message : String(error)}. Run \`tychonic service restart-worker\` to apply the change.`
    };
  }
}

/**
 * `runtime up --detach` handler. Spawns the current CLI again (same
 * `--instance <name>`) in a new session with stdio → `runtime.log`, then
 * exits 0. Refuses without an active instance — operational launchd
 * already supervises the production runtime; `--detach` is for isolated
 * instances only.
 */
async function handleRuntimeUpDetach(options: {
  projectDir: string;
  temporalMode?: TemporalConfig["mode"];
  temporalPort?: number;
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalTaskQueue?: string;
  shutdownGraceTime?: string;
}): Promise<void> {
  const instance = getActiveInstance();
  if (instance === undefined) {
    throw new Error(
      "runtime up --detach requires an active instance from --instance <name> or TYCHONIC_INSTANCE; detached mode is for isolated instances only"
    );
  }

  const dirs = tychonicRuntimeDirs();
  const pidFile = pathJoin(dirs.stateDir, "runtime.pid");
  const logFile = pathJoin(dirs.logDir, "runtime.log");

  let staleRemoved = false;
  const existingPid = await readPidFile(pidFile);
  if (existingPid > 0) {
    if (isProcessAlive(existingPid)) {
      throw new Error(
        `instance '${instance}' already has a runtime (pid=${existingPid}); stop it with ` +
          `'tychonic runtime stop --instance ${instance}' or use 'runtime reset --instance ${instance}' only for destructive cleanup`
      );
    }
    staleRemoved = true;
  }

  // Pre-check: detached child would die immediately if no bundles are installed.
  // Foreground mode surfaces this error on stderr so the operator sees it, but
  // detached mode would return a "success" JSON with a PID that silently exits
  // a few seconds later.
  const installedBundles = await listRuntimeWorkflowModules();
  if (installedBundles.length === 0) {
    throw new Error(
      `no workflow bundles installed in instance '${instance}'. ` +
        `Install a bundle with \`tychonic workflows install <directory> --instance ${instance}\` ` +
        "(for example, `workflows install ./examples/workflows/simpleWorkflow`), " +
        `then rerun \`tychonic runtime up --instance ${instance} --detach\`.`
    );
  }
  // Preflight the same bundle compile the foreground child will perform.
  // Without this, a missing bundle dependency can make the child exit after
  // the parent already printed a success-looking detached PID.
  await buildWorkflowBundle();

  // Reconstruct the flags the child should receive. `--detach` itself is
  // not forwarded (child runs foreground); `--instance` is re-passed
  // explicitly inside spawnDetachedRuntime.
  const extraArgs: string[] = [];
  if (options.projectDir) extraArgs.push("--project-dir", options.projectDir);
  if (options.temporalMode) extraArgs.push("--temporal-mode", options.temporalMode);
  if (options.temporalPort !== undefined)
    extraArgs.push("--temporal-port", String(options.temporalPort));
  if (options.temporalAddress) extraArgs.push("--temporal-address", options.temporalAddress);
  if (options.temporalNamespace) extraArgs.push("--temporal-namespace", options.temporalNamespace);
  if (options.temporalTaskQueue) extraArgs.push("--temporal-task-queue", options.temporalTaskQueue);
  if (options.shutdownGraceTime)
    extraArgs.push("--shutdown-grace-time", options.shutdownGraceTime);

  const result = await spawnDetachedRuntime({
    nodePath: process.execPath,
    cliPath: process.argv[1] ?? "",
    instance,
    extraArgs,
    logFile,
    pidFile
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "detached",
        pid: result.pid,
        pidFile: result.pidFile,
        logFile: result.logFile,
        stopCommand: `tychonic runtime stop --instance ${instance}`,
        ...(staleRemoved ? { staleRemoved: true } : {}),
        _meta: cliInstanceMeta()
      },
      null,
      2
    )
  );
}

async function claimForegroundRuntimePidFileIfNeeded(): Promise<string | undefined> {
  const instance = getActiveInstance();
  if (instance === undefined) {
    return undefined;
  }
  const dirs = tychonicRuntimeDirs();
  const pidFile = pathJoin(dirs.stateDir, "runtime.pid");
  const existingPid = await readPidFile(pidFile);
  if (existingPid > 0 && existingPid !== process.pid && isProcessAlive(existingPid)) {
    throw new Error(
      `instance '${instance}' already has a runtime (pid=${existingPid}); stop it with ` +
        `'tychonic runtime stop --instance ${instance}' or use 'runtime reset --instance ${instance}' only for destructive cleanup`
    );
  }
  await writePidFile(pidFile, process.pid);
  return pidFile;
}

/**
 * Prompt for an interactive yes/no confirmation from stdin. Returns true
 * only for exact `y` / `Y` / `yes` / `Yes` / `YES`. Any other input
 * (including EOF) returns false. Non-TTY stdin also returns false (the
 * caller should then pass `--yes` explicitly).
 */
async function promptConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    process.stderr.write(message);
    let data = "";
    const onData = (chunk: Buffer): void => {
      data += chunk.toString("utf8");
      const nl = data.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        const answer = data.slice(0, nl).trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/**
 * `runtime reset --instance <name>` handler. Requires an active
 * instance; operates only on the instance-scoped state/log/pid paths.
 */
async function handleRuntimeReset(options: { yes: boolean }): Promise<void> {
  const instance = getActiveInstance();
  if (instance === undefined) {
    throw new Error(
      "runtime reset requires --instance <name>; operational paths must not be reset through this command"
    );
  }
  // Redundant with preAction validation, but keeps the contract
  // self-evident at the action site (§3 precise match).
  validateInstanceName(instance);

  const dirs = tychonicRuntimeDirs();
  const pidFile = pathJoin(dirs.stateDir, "runtime.pid");

  if (!options.yes) {
    const lines = [
      `About to reset isolated instance '${instance}'. This will:`,
      `  - SIGTERM (then SIGKILL after 10s) the pid recorded in: ${pidFile}`,
      `  - remove state dir: ${dirs.stateDir}`,
      `  - remove log dir:   ${dirs.logDir}`,
      `Proceed? [y/N] `
    ];
    const confirmed = await promptConfirm(lines.join("\n"));
    if (!confirmed) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            cancelled: true,
            instance,
            _meta: cliInstanceMeta()
          },
          null,
          2
        )
      );
      return;
    }
  }

  const result = await killAndRemoveInstance({
    instance,
    pidFile,
    stateDir: dirs.stateDir,
    logDir: dirs.logDir
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        instance: result.instance,
        killedPid: result.killedPid,
        killedSignal: result.killedSignal,
        // Surface the temporal-child cleanup separately so operators
        // can confirm the cascade reached both the runtime parent and
        // the spawned Temporal server.
        killedTemporalPid: result.killedTemporalPid,
        killedTemporalSignal: result.killedTemporalSignal,
        removed: result.removed,
        _meta: cliInstanceMeta()
      },
      null,
      2
    )
  );
}

async function handleRuntimeStop(): Promise<void> {
  const instance = getActiveInstance();
  if (instance === undefined) {
    throw new Error("runtime stop requires --instance <name>; operational paths must not be stopped through this command");
  }
  validateInstanceName(instance);
  const dirs = tychonicRuntimeDirs();
  const pidFile = pathJoin(dirs.stateDir, "runtime.pid");
  const result = await stopRuntimeParent({ instance, pidFile });
  const temporal =
    result.ok && (result.state === "stopped" || result.state === "not_running")
      ? await new TemporalManager(temporalConfigFromOptions({})).stop()
      : undefined;
  const ok = result.ok && (temporal?.ok ?? true);
  console.log(
    JSON.stringify(
      { ...result, ok, ...(temporal ? { temporal } : {}), _meta: cliInstanceMeta() },
      null,
      2
    )
  );
  if (!ok) {
    process.exitCode = 1;
  }
}

function temporalConfigFromOptions(options: {
  temporalMode?: TemporalConfig["mode"];
  temporalPort?: number;
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalTaskQueue?: string;
}): TemporalConfig {
  return {
    ...(options.temporalMode ? { mode: options.temporalMode } : {}),
    ...(options.temporalPort !== undefined ? { apiPort: options.temporalPort } : {}),
    ...(options.temporalAddress ? { address: options.temporalAddress } : {}),
    ...(options.temporalNamespace ? { namespace: options.temporalNamespace } : {}),
    ...(options.temporalTaskQueue ? { taskQueue: options.temporalTaskQueue } : {})
  };
}

async function waitForTemporalReady(manager: TemporalManager, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastMessage = "Temporal is not reachable";
  while (Date.now() <= deadline) {
    const status = await manager.status();
    if (status.portOpen) {
      return;
    }
    lastMessage = status.message ?? lastMessage;
    await sleep(250);
  }
  throw new Error(`Temporal did not become ready within ${timeoutMs}ms: ${lastMessage}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
