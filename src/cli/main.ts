#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { stringify } from "yaml";
import { checkOrApplyWorkerPatch } from "../bootstrap/patchRunner.js";
import {
  assertTychonicWorkflowResult,
  artifactContentPath,
  listCandidateExecutionRows,
  listAgentSessions,
  listArtifacts,
  listInboxItems,
  listLiveOutputAttempts,
  liveOutputContentPath,
  workflowResultView,
  type TychonicWorkflowResult
} from "./temporalResultViews.js";
import { resolveSimpleWorkflowCliOptions } from "./simpleWorkflowCliOptions.js";
import { parseAgentCandidatesJSON } from "./agentCandidateJson.js";
import {
  loadBundleConfig,
  resolveEffectiveBundleConfig
} from "../catalog/bundleConfig.js";
import { parseBundleConfigYaml } from "../catalog/loadProfile.js";
import { checkProjectGuardrails } from "../guardrails/checker.js";
import { productName } from "../index.js";
import { assertLoopbackHost } from "../net/loopback.js";
import {
  getActiveInstance,
  resolveWebPort,
  setActiveInstance,
  validateInstanceName
} from "../runtime/instance.js";
import {
  spawnDetachedRuntime,
  readPidFile,
  isProcessAlive
} from "../runtime/detached.js";
import { killAndRemoveInstance } from "../runtime/reset.js";
import {
  replaceLaunchdWorker,
  installLaunchdServices,
  restartLaunchdService,
  statusLaunchdServices,
  uninstallLaunchdServices
} from "../service/launchd.js";
import { startWebServer, type StartedWebServer } from "../web/server.js";
import {
  describeTychonicTemporalWorkflow,
  listTychonicTemporalWorkflows,
  queryInteractionPendingState,
  signalInteractionApproveState,
  signalInteractionModifyState,
  signalInteractionRejectState,
  signalSimpleWorkflowContinuation,
  signalSimpleWorkflowExtendIterations,
  signalSimpleWorkflowInboxDismiss,
  signalSimpleWorkflowRegisterSession,
  signalSimpleWorkflowResumeSession,
  startNamedTemporalWorkflow
} from "../temporal/client.js";
import type { WorkflowStateRecord } from "../domain/types.js";
import { readFile as readFileAsync } from "node:fs/promises";
import { TemporalManager, tychonicRuntimeDirs, type TemporalConfig } from "../temporal/manager.js";
import type { SimpleWorkflowContinuationSignalInput, StateRecordPatch } from "../temporal/types.js";
import { runTemporalWorker } from "../temporal/worker.js";
import { join as pathJoin } from "node:path";
import {
  installRuntimeWorkflowModule,
  listRuntimeWorkflowModules,
  removeRuntimeWorkflowModule,
  runtimeWorkflowModulesDir,
  inspectBundle,
  loadBundleConfigFromDisk
} from "../temporal/workflowModules.js";
import {
  normalizeBundleRequires,
  validateBundleFileShape,
  validateBundleRequires
} from "../temporal/bundleValidator.js";
import { productVersion } from "../version.js";

const program = new Command();

program.name(productName).description("Local AI work operations manager").version(productVersion);

program.option(
  "--instance <name>",
  "isolated dev instance name; replaces state dir, frontend port, and task queue derived from <name>. Falls back to $TYCHONIC_INSTANCE when omitted. Unset targets the operational paths."
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

program
  .command("guardrails")
  .option("--cwd <dir>", "project root to check", process.cwd())
  .description("Check Tychonic project guardrails and print JSON")
  .action(async (options: { cwd: string }) => {
    const result = await checkProjectGuardrails({ root: options.cwd });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

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
          configPath: bundle.configPath,
          workflowExports: inspection.exportNames,
          requires: inspection.requires
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
      const config = await loadBundleConfigFromDisk(directory);
      const inspection = await inspectBundle({
        name: workflowsBundleDirName(directory),
        workflowPath: pathJoin(directory, "workflow.mjs")
      });
      const requires = normalizeBundleRequires(inspection.requires);
      validateBundleRequires({ requires, config });
      console.log(
        JSON.stringify(
          {
            ok: true,
            bundle: {
              directory,
              workflowExports: inspection.exportNames,
              requires: inspection.requires
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
  .description("Install a workflow bundle into the local runtime registry and replace the worker")
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
  .description("Remove an installed workflow bundle and replace the worker")
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
  .requiredOption("--workflow <name>", "installed workflow bundle name")
  .option("--config <file>", "one-off Tychonic config YAML file to override the bundle config", undefined)
  .option("--format <format>", "yaml or json", "yaml")
  .description("Print one installed bundle's configuration")
  .action(async (options: { workflow: string; config?: string; format: "yaml" | "json" }) => {
    if (!["yaml", "json"].includes(options.format)) {
      throw new Error("--format must be yaml or json");
    }
    const bundleDir = await bundleDirForInstalledName(options.workflow);
    const resolved = await resolveEffectiveBundleConfig({
      bundleDir,
      ...(options.config ? { overridePath: options.config } : {})
    });
    const payload = {
      version: "tychonic.config.show.v2" as const,
      workflow: options.workflow,
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
  .requiredOption("--workflow <name>", "installed workflow bundle name")
  .option("--config <file>", "one-off Tychonic config YAML file to validate against the bundle", undefined)
  .description("Validate one installed bundle's configuration")
  .action(async (options: { workflow: string; config?: string }) => {
    try {
      const bundleDir = await bundleDirForInstalledName(options.workflow);
      const resolved = await resolveEffectiveBundleConfig({
        bundleDir,
        ...(options.config ? { overridePath: options.config } : {})
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            version: "tychonic.config.validate.v2",
            workflow: options.workflow,
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
            workflow: options.workflow,
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
  .option("--cwd <dir>", "working directory exposed to the web catalog", process.cwd())
  .option("--no-web", "do not start the local web server")
  .option("--web-host <host>", "web host", "127.0.0.1")
  .option(
    "--web-port <port>",
    "web port. Omit to let --instance <name> derive a port (18000 + fnv1a32(name) mod 1000); when both --instance and --web-port are unset, defaults to 8765 (operational).",
    (value) => Number(value)
  )
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--allow-network-bind", "allow non-loopback web bind; unsupported for public alpha without private-network controls", false)
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .option("--shutdown-grace-time <duration>", "worker drain time on shutdown before cancelling in-flight activities")
  .option(
    "--detach",
    "spawn the runtime in a new session and exit; requires --instance. PID is written under <stateDir>/runtime.pid, stdout/stderr tee into <logDir>/runtime.log.",
    false
  )
  .description("Start Temporal if needed, then run worker and optional web server in the foreground")
  .action(
    async (options: {
      cwd: string;
      web: boolean;
      webHost: string;
      webPort?: number;
      allowNetworkBind: boolean;
      frontendPort?: number;
      uiPort?: number;
      mode?: TemporalConfig["mode"];
      address?: string;
      namespace?: string;
      taskQueue?: string;
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
                "(for example, `workflows install dist/workflow-bundles/simpleWorkflow`), " +
                `then rerun \`tychonic runtime up --instance ${activeInstance}\`.`
            );
          }
        }
      }
      const temporalConfig = temporalConfigFromOptions(options);
      const manager = new TemporalManager(temporalConfig);
      const temporal = await manager.start();
      await waitForTemporalReady(manager);
      const resolvedWebPort = resolveWebPort(options.webPort);
      const web = options.web
        ? await startWebServer({
            cwd: options.cwd,
            host: options.webHost,
            port: resolvedWebPort,
            ...(options.allowNetworkBind ? { allowNetworkBind: true } : {}),
            ...temporalConfig
          })
        : undefined;

      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "foreground",
            temporal,
            ...(web ? { web: { url: web.url } } : {}),
            worker: { status: "running" },
            workflows: { modules: await listRuntimeWorkflowModules() },
            _meta: cliInstanceMeta()
          },
          null,
          2
        )
      );

      try {
        await runTemporalWorker({
          ...temporalConfig,
          ...(options.shutdownGraceTime ? { shutdownGraceTime: options.shutdownGraceTime } : {})
        });
      } finally {
        await closeStartedWebServer(web);
      }
    }
  );

runtimeCommand
  .command("reset")
  .option("--yes", "skip the interactive confirmation prompt", false)
  .description(
    "Terminate the detached runtime for --instance <name> (SIGTERM → 10s → SIGKILL) and remove its state/log directories. Refuses to operate without --instance."
  )
  .action(async (options: { yes?: boolean }) => {
    await handleRuntimeReset({ yes: Boolean(options.yes) });
  });

program
  .command("run")
  .argument("<workflow-type>", "workflow export name")
  .option("--input <json>", "single JSON argument to pass as workflow input")
  .option("--input-file <file>", "path to a JSON file containing the workflow input")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .option("--workflow-id <id>", "Temporal workflow id")
  .option("--wait", "wait for Temporal workflow completion and print the run result")
  .description("Start a Tychonic workflow through Temporal")
  .action(async (workflowType: string, options: RunCommandOptions) => {
    await startNamedWorkflowFromCli(workflowType, options);
  });

program
  .command("simple_workflow:patch")
  .requiredOption("--patch-file <path>", "explicit worker_patch artifact file")
  .option("--cwd <dir>", "source working directory", process.cwd())
  .option("--apply", "apply the worker patch to the source workspace")
  .description("Check or apply a simple_workflow worker_patch artifact")
  .action(async (options: { patchFile: string; cwd: string; apply?: boolean }) => {
    const result = await checkOrApplyWorkerPatch({
      cwd: options.cwd,
      patchFile: options.patchFile,
      apply: Boolean(options.apply)
    });
    const ok = result.status !== "does_not_apply";
    console.log(
      JSON.stringify(
        {
          ok,
          run_id: result.run.id,
          mode: result.mode,
          status: result.status,
          source_workspace: result.sourceWorkspace,
          artifact_id: result.artifact.id,
          patch_file: result.patchFile,
          ...(result.output ? { output: result.output.trim() } : {}),
          ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {})
        },
        null,
        2
      )
    );
    if (!ok) {
      process.exitCode = 1;
    }
  });

program
  .command("simple_workflow:continue")
  .requiredOption("--workflow-id <id>", "Temporal workflow id for a waiting_user simple_workflow run")
  .option("--run-id <id>", "Temporal run id")
  .option("--max-iterations <n>", "fresh auto-continue iteration budget", (value) => Number(value))
  .option("--verify-command <cmd>", "override verify command for the extended run")
  .option("--command-timeout <ms>", "per-command timeout in milliseconds", (value) => Number(value))
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description(
    "Extend a waiting_user simple_workflow with a fresh auto-continue iteration budget that loops over remaining inbox items"
  )
  .action(
    async (options: {
      workflowId: string;
      runId?: string;
      maxIterations?: number;
      verifyCommand?: string;
      commandTimeout?: number;
      mode?: TemporalConfig["mode"];
      address?: string;
      namespace?: string;
      taskQueue?: string;
    }) => {
      if (options.maxIterations !== undefined) {
        if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
          throw new Error("--max-iterations must be a positive integer");
        }
      }
      const result = await signalSimpleWorkflowExtendIterations({
        workflowId: options.workflowId,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
        ...(options.verifyCommand ? { verifyCommand: options.verifyCommand } : {}),
        ...(options.commandTimeout ? { commandTimeoutMs: options.commandTimeout } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
      });
      console.log(JSON.stringify({ ok: true, mode: "temporal", ...result }, null, 2));
    }
  );

program
  .command("status")
  .option("--workflow-id <id>", "Temporal workflow id to describe")
  .option("--run-id <id>", "Temporal run id to describe")
  .option("--result", "include completed workflow result from Temporal history")
  .option("--limit <n>", "maximum workflows to list", (value) => Number(value), 20)
  .option("--query <query>", "Temporal visibility query for listing workflows")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Inspect Tychonic workflow status through Temporal")
  .action(
    async (options: {
      workflowId?: string;
      runId?: string;
      result?: boolean;
      limit: number;
      query?: string;
      mode?: TemporalConfig["mode"];
      address?: string;
      namespace?: string;
      taskQueue?: string;
    }) => {
      if (options.runId && !options.workflowId) {
        throw new Error("--run-id requires --workflow-id");
      }
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
      }

      if (options.workflowId) {
        const result = await describeTychonicTemporalWorkflow({
          workflowId: options.workflowId,
          ...(options.runId ? { runId: options.runId } : {}),
          includeResult: Boolean(options.result),
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.address ? { address: options.address } : {}),
          ...(options.namespace ? { namespace: options.namespace } : {}),
          ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
        });
        console.log(
          JSON.stringify(
            { ok: true, mode: "temporal", workflow: result, _meta: cliInstanceMeta() },
            null,
            2
          )
        );
        return;
      }

      const result = await listTychonicTemporalWorkflows({
        limit: options.limit,
        ...(options.query ? { query: options.query } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
      });
      console.log(
        JSON.stringify({ ok: true, mode: "temporal", ...result, _meta: cliInstanceMeta() }, null, 2)
      );
    }
  );

program
  .command("resume")
  .argument("<session-id>", "agent session id")
  .requiredOption("--workflow-id <id>", "Temporal workflow id")
  .option("--run-id <id>", "Temporal run id")
  .option("--config <file>", "one-off Tychonic config YAML file for review defaults")
  .option("--cwd <dir>", "working directory for profile resolution", process.cwd())
  .requiredOption("--prompt <text>", "prompt to send to the session resume command")
  .requiredOption("--verify-command <cmd>", "deterministic verification command after resume")
  .option("--review-command <cmd>", "structured reviewer command after resume verification succeeds")
  .option("--review-agent <name>", "reviewer agent label for custom review commands")
  .option("--review-candidates-json <json>", "ordered review candidates JSON array")
  .option("--command-timeout <ms>", "resume command timeout in milliseconds", (value) => Number(value))
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Resume an agent session through Temporal")
  .action(
    async (
      sessionId: string,
      options: RequiredTemporalResultCommandOptions & {
        config?: string;
        cwd: string;
        prompt: string;
        verifyCommand: string;
        reviewCommand?: string;
        reviewAgent?: string;
        reviewCandidatesJson?: string;
        commandTimeout?: number;
      }
    ) => {
      void options.cwd;
      const reviewCandidates = options.reviewCandidatesJson
        ? parseAgentCandidatesJSON(options.reviewCandidatesJson, "--review-candidates-json")
        : undefined;
      const resolved = options.config
        ? resolveSimpleWorkflowCliOptions({
            cwd: options.cwd,
            verifyCommand: options.verifyCommand,
            ...(options.reviewCommand ? { reviewCommand: options.reviewCommand } : {}),
            ...(options.reviewAgent ? { reviewAgent: options.reviewAgent } : {}),
            ...(reviewCandidates ? { reviewCandidates: reviewCandidates } : {}),
            ...(options.commandTimeout ? { commandTimeout: options.commandTimeout } : {}),
            profile: (
              await resolveBundleConfigForWorkflow({
                workflowId: options.workflowId,
                ...(options.runId ? { runId: options.runId } : {}),
                overridePath: options.config,
                ...(options.mode ? { mode: options.mode } : {}),
                ...(options.address ? { address: options.address } : {}),
                ...(options.namespace ? { namespace: options.namespace } : {}),
                ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
              })
            ).profile
          })
        : undefined;
      const result = await signalSimpleWorkflowResumeSession({
        workflowId: options.workflowId,
        ...(options.runId ? { runId: options.runId } : {}),
        sessionId,
        prompt: options.prompt,
        verifyCommand: options.verifyCommand,
        ...(resolved?.reviewCommand ?? options.reviewCommand
          ? { reviewCommand: resolved?.reviewCommand ?? options.reviewCommand }
          : {}),
        ...(resolved?.reviewAgent ?? options.reviewAgent
          ? { reviewAgent: resolved?.reviewAgent ?? options.reviewAgent }
          : {}),
        ...(resolved?.reviewCandidates
          ? { reviewCandidates: resolved.reviewCandidates }
          : reviewCandidates
            ? { reviewCandidates }
            : {}),
        ...(resolved?.commandTimeoutMs ?? options.commandTimeout
          ? { commandTimeoutMs: resolved?.commandTimeoutMs ?? options.commandTimeout }
          : {}),
        ...(resolved?.activityTimeouts ? { activityTimeouts: resolved.activityTimeouts } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
      });
      console.log(JSON.stringify({ ok: true, mode: "temporal", ...result }, null, 2));
    }
  );

program
  .command("approve")
  .argument("<workflow-id>", "Temporal workflow id")
  .option("--state <name>", "state NAME to approve; when omitted, queried from the workflow")
  .option("--run-id <id>", "Temporal run id")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Approve the currently gated interactive state through Temporal")
  .action(
    async (
      workflowId: string,
      options: Omit<RequiredTemporalResultCommandOptions, "workflowId"> & {
        state?: string;
      }
    ) => {
      const state = await resolveInteractionState({
        workflowId,
        ...(options.state ? { explicitState: options.state } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
      });
      const result = await signalInteractionApproveState({
        workflowId,
        state,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
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
  .argument("<workflow-id>", "Temporal workflow id")
  .requiredOption("--feedback <text>", "non-empty feedback string delivered to the retried state")
  .option("--state <name>", "state NAME to reject; when omitted, queried from the workflow")
  .option("--run-id <id>", "Temporal run id")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
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
        ...(options.state ? { explicitState: options.state } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
      });
      const result = await signalInteractionRejectState({
        workflowId,
        state,
        feedback: options.feedback,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
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
  .argument("<workflow-id>", "Temporal workflow id")
  .option("--state <name>", "state NAME to modify; when omitted, queried from the workflow")
  .option("--status <status>", "set state.status (succeeded|failed|skipped|blocked|timed_out)")
  .option("--reason <text>", "set state.reason")
  .option("--note <text>", "append a short note (becomes reason when reason is absent)")
  .option("--patch-file <path>", "JSON file containing a full StateRecordPatch (status/reason/note/artifacts/findings)")
  .option("--run-id <id>", "Temporal run id")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Patch the latest state record for a gated interactive state (pass-with-overlay)")
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
        ...(options.state ? { explicitState: options.state } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
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
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.address ? { address: options.address } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
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
  .requiredOption("--workflow-id <id>", "Temporal workflow id")
  .option("--run-id <id>", "Temporal run id")
  .option("--artifact <id>", "artifact id to print")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("List or print workflow artifacts through Temporal result metadata")
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
  .requiredOption("--workflow-id <id>", "Temporal workflow id")
  .option("--run-id <id>", "Temporal run id")
  .option("--attempt <id>", "activity attempt id to print")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("List or print live activity logs through Temporal result metadata")
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
          attempts: listLiveOutputAttempts(result)
        },
        null,
        2
      )
    );
  });

program
  .command("candidates")
  .requiredOption("--workflow-id <id>", "Temporal workflow id")
  .option("--run-id <id>", "Temporal run id")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("List agent-backed candidate execution rows through Temporal result metadata")
  .action(async (options: RequiredTemporalResultCommandOptions) => {
    const result = await loadTemporalWorkflowResult(options);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "temporal",
          workflow_id: options.workflowId,
          ...workflowResultView(result),
          candidates: listCandidateExecutionRows(result)
        },
        null,
        2
      )
    );
  });

const inboxCommand = program
  .command("inbox")
  .option("--workflow-id <id>", "Temporal workflow id")
  .option("--run-id <id>", "Temporal run id")
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("List decision inbox items through Temporal result metadata")
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

inboxCommand
  .command("execute")
  .argument("<item-id>", "decision inbox item id")
  .option("--config <file>", "one-off Tychonic config YAML file for worker/review/verify defaults")
  .option("--cwd <dir>", "working directory for profile resolution", process.cwd())
  .option("--command <cmd>", "fresh worker command for triage inbox items")
  .option("--goal <text>", "fresh worker goal")
  .option("--agent <name>", "fresh worker agent label")
  .option("--resume-command <cmd>", "resume command to attach to fresh command worker sessions")
  .option("--worker-candidates-json <json>", "ordered worker candidates JSON array")
  .option("--verify-command <cmd>", "deterministic verification command after continuation")
  .option("--review-command <cmd>", "structured reviewer command after continuation verification succeeds")
  .option("--review-agent <name>", "reviewer agent label for custom review commands")
  .option("--review-candidates-json <json>", "ordered review candidates JSON array")
  .option("--command-timeout <ms>", "continuation command timeout in milliseconds", (value) => Number(value))
  .description("Execute a decision inbox item through Temporal")
  .action(
    async (
      itemId: string,
      options: {
        config?: string;
        cwd: string;
        command?: string;
        goal?: string;
        agent?: string;
        resumeCommand?: string;
        workerCandidatesJson?: string;
        verifyCommand?: string;
        reviewCommand?: string;
        reviewAgent?: string;
        reviewCandidatesJson?: string;
        commandTimeout?: number;
      }
    ) => {
      const workflowOptions = inboxCommand.opts<TemporalResultCommandOptions>();
      requireWorkflowId(workflowOptions);
      void options.cwd;
      const workerCandidates = options.workerCandidatesJson
        ? parseAgentCandidatesJSON(options.workerCandidatesJson, "--worker-candidates-json")
        : undefined;
      const reviewCandidates = options.reviewCandidatesJson
        ? parseAgentCandidatesJSON(options.reviewCandidatesJson, "--review-candidates-json")
        : undefined;
      const resolved = options.config
        ? resolveSimpleWorkflowCliOptions({
            cwd: options.cwd,
            ...(options.command ? { command: options.command } : {}),
            ...(options.verifyCommand ? { verifyCommand: options.verifyCommand } : {}),
            ...(options.goal ? { goal: options.goal } : {}),
            ...(options.agent ? { agent: options.agent } : {}),
            ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
            ...(workerCandidates ? { workerCandidates: workerCandidates } : {}),
            ...(options.reviewCommand ? { reviewCommand: options.reviewCommand } : {}),
            ...(options.reviewAgent ? { reviewAgent: options.reviewAgent } : {}),
            ...(reviewCandidates ? { reviewCandidates: reviewCandidates } : {}),
            ...(options.commandTimeout ? { commandTimeout: options.commandTimeout } : {}),
            profile: (
              await resolveBundleConfigForWorkflow({
                workflowId: workflowOptions.workflowId as string,
                ...(workflowOptions.runId ? { runId: workflowOptions.runId } : {}),
                overridePath: options.config,
                ...(workflowOptions.mode ? { mode: workflowOptions.mode } : {}),
                ...(workflowOptions.address ? { address: workflowOptions.address } : {}),
                ...(workflowOptions.namespace ? { namespace: workflowOptions.namespace } : {}),
                ...(workflowOptions.taskQueue ? { taskQueue: workflowOptions.taskQueue } : {})
              })
            ).profile
          })
        : undefined;
      const verifyCommand = options.verifyCommand ?? resolved?.verifyCommand;
      const continuationFields: Partial<SimpleWorkflowContinuationSignalInput> = {
        ...(resolved?.command ?? options.command ? { command: resolved?.command ?? options.command } : {}),
        ...(resolved?.agent ?? options.agent ? { agent: resolved?.agent ?? options.agent } : {}),
        ...(resolved?.resumeCommand ?? options.resumeCommand
          ? { resumeCommand: resolved?.resumeCommand ?? options.resumeCommand }
          : {}),
        ...(resolved?.workerCandidates
          ? { workerCandidates: resolved.workerCandidates }
          : workerCandidates
            ? { workerCandidates }
            : {}),
        ...(resolved?.goal ?? options.goal ? { goal: resolved?.goal ?? options.goal } : {}),
        ...(resolved?.reviewCommand ?? options.reviewCommand
          ? { reviewCommand: resolved?.reviewCommand ?? options.reviewCommand }
          : {}),
        ...(resolved?.reviewAgent ?? options.reviewAgent
          ? { reviewAgent: resolved?.reviewAgent ?? options.reviewAgent }
          : {}),
        ...(resolved?.reviewCandidates
          ? { reviewCandidates: resolved.reviewCandidates }
          : reviewCandidates
            ? { reviewCandidates }
            : {}),
        ...(resolved?.commandTimeoutMs ?? options.commandTimeout
          ? { commandTimeoutMs: resolved?.commandTimeoutMs ?? options.commandTimeout }
          : {}),
        ...(resolved?.activityTimeouts ? { activityTimeouts: resolved.activityTimeouts } : {})
      };
      const result = await signalSimpleWorkflowContinuation({
        workflowId: workflowOptions.workflowId,
        ...(workflowOptions.runId ? { runId: workflowOptions.runId } : {}),
        inboxItemId: itemId,
        ...(verifyCommand ? { verifyCommand } : {}),
        ...(continuationFields.command ? { command: continuationFields.command } : {}),
        ...(continuationFields.agent ? { agent: continuationFields.agent } : {}),
        ...(continuationFields.resumeCommand ? { resumeCommand: continuationFields.resumeCommand } : {}),
        ...(continuationFields.workerCandidates ? { workerCandidates: continuationFields.workerCandidates } : {}),
        ...(continuationFields.goal ? { goal: continuationFields.goal } : {}),
        ...(continuationFields.reviewCommand ? { reviewCommand: continuationFields.reviewCommand } : {}),
        ...(continuationFields.reviewAgent ? { reviewAgent: continuationFields.reviewAgent } : {}),
        ...(continuationFields.reviewCandidates ? { reviewCandidates: continuationFields.reviewCandidates } : {}),
        ...(continuationFields.commandTimeoutMs ? { commandTimeoutMs: continuationFields.commandTimeoutMs } : {}),
        ...(continuationFields.activityTimeouts ? { activityTimeouts: continuationFields.activityTimeouts } : {}),
        ...(workflowOptions.mode ? { mode: workflowOptions.mode } : {}),
        ...(workflowOptions.address ? { address: workflowOptions.address } : {}),
        ...(workflowOptions.namespace ? { namespace: workflowOptions.namespace } : {}),
        ...(workflowOptions.taskQueue ? { taskQueue: workflowOptions.taskQueue } : {})
      });
      console.log(JSON.stringify({ ok: true, mode: "temporal", ...result }, null, 2));
    }
  );

inboxCommand
  .command("dismiss")
  .argument("<item-id>", "decision inbox item id")
  .option("--reason <text>", "optional dismissal reason to preserve in Temporal run data")
  .description("Dismiss a decision inbox item through Temporal")
  .action(async (itemId: string, options: { reason?: string }) => {
    const workflowOptions = inboxCommand.opts<TemporalResultCommandOptions>();
    requireWorkflowId(workflowOptions);
    const result = await signalSimpleWorkflowInboxDismiss({
      workflowId: workflowOptions.workflowId,
      ...(workflowOptions.runId ? { runId: workflowOptions.runId } : {}),
      inboxItemId: itemId,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(workflowOptions.mode ? { mode: workflowOptions.mode } : {}),
      ...(workflowOptions.address ? { address: workflowOptions.address } : {}),
      ...(workflowOptions.namespace ? { namespace: workflowOptions.namespace } : {}),
      ...(workflowOptions.taskQueue ? { taskQueue: workflowOptions.taskQueue } : {})
    });
    console.log(JSON.stringify({ ok: true, mode: "temporal", ...result }, null, 2));
  });

program
  .command("web")
  .option("--cwd <dir>", "working directory", process.cwd())
  .option("--host <host>", "host", "127.0.0.1")
  .option("--port <port>", "port", (value) => Number(value), 8765)
  .option("--allow-network-bind", "allow non-loopback web bind; unsupported for public alpha without private-network controls", false)
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Start the local Tychonic status web server")
  .action(
    async (options: {
      cwd: string;
      host: string;
      port: number;
      allowNetworkBind: boolean;
      frontendPort?: number;
      uiPort?: number;
      mode?: TemporalConfig["mode"];
      address?: string;
      namespace?: string;
      taskQueue?: string;
    }) => {
      assertLoopbackHost(options.host, options.allowNetworkBind);
      const temporalConfig = temporalConfigFromOptions(options);
      const started = await startWebServer({
        cwd: options.cwd,
        host: options.host,
        port: options.port,
        ...(options.allowNetworkBind ? { allowNetworkBind: true } : {}),
        ...temporalConfig
      });
      console.log(JSON.stringify({ ok: true, url: started.url }, null, 2));
    }
  );

const serviceCommand = program.command("service").description("Manage macOS launchd services for local Tychonic");

serviceCommand
  .command("install")
  .requiredOption("--project-cwd <dir>", "project directory exposed to the web catalog")
  .option("--web-host <host>", "web host", "127.0.0.1")
  .option("--web-port <port>", "web port", (value) => Number(value), 8765)
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--allow-network-bind", "allow non-loopback web bind; unsupported for public alpha without private-network controls", false)
  .option("--node-path <path>", "absolute node executable path")
  .option("--cli-path <path>", "absolute Tychonic CLI JavaScript path")
  .option("--temporal-cli-path <path>", "absolute temporal executable path")
  .option("--worker-shutdown-grace-time <duration>", "worker drain time on shutdown before cancelling in-flight activities")
  .option("--allow-source-cli", "allow launchd services to execute a source checkout CLI; development only", false)
  .description("Install and load user LaunchAgents for Temporal, worker, and web")
  .action(
    async (options: {
      projectCwd: string;
      webHost: string;
      webPort: number;
      frontendPort?: number;
      uiPort?: number;
      allowNetworkBind: boolean;
      nodePath?: string;
      cliPath?: string;
      temporalCliPath?: string;
      workerShutdownGraceTime?: string;
      allowSourceCli: boolean;
    }) => {
      assertOperationalOnly("tychonic service install");
      const result = await installLaunchdServices({
        projectCwd: options.projectCwd,
        webHost: options.webHost,
        webPort: options.webPort,
        ...(options.frontendPort ? { frontendPort: options.frontendPort } : {}),
        ...(options.uiPort ? { uiPort: options.uiPort } : {}),
        allowNetworkBind: options.allowNetworkBind,
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
  .option("--replacement-timeout-ms <ms>", "maximum time to wait for old and temporary replacement workers to drain", (value) => Number(value))
  .description("Start a replacement worker before gracefully retiring the old worker")
  .action(async (options: { replacementTimeoutMs?: number }) => {
    assertOperationalOnly("tychonic service restart-worker");
    console.log(
      JSON.stringify(
        {
          ok: true,
          worker_replacement: await replaceLaunchdWorker({
            ...(options.replacementTimeoutMs ? { timeoutMs: options.replacementTimeoutMs } : {})
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

const temporalCommand = program.command("temporal").description("Manage local Temporal runtime");

temporalCommand
  .command("status")
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Inspect Temporal runtime status")
  .action(async (options: { mode?: TemporalConfig["mode"]; frontendPort?: number; uiPort?: number; address?: string; namespace?: string; taskQueue?: string }) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    console.log(JSON.stringify({ ok: true, status: await manager.status() }, null, 2));
  });

temporalCommand
  .command("doctor")
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Run Temporal runtime checks")
  .action(async (options: { mode?: TemporalConfig["mode"]; frontendPort?: number; uiPort?: number; address?: string; namespace?: string; taskQueue?: string }) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    const report = await manager.doctor();
    console.log(JSON.stringify({ ok: report.overall !== "fail", report }, null, 2));
  });

temporalCommand
  .command("start")
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Start or reuse managed-local Temporal")
  .action(async (options: { mode?: TemporalConfig["mode"]; frontendPort?: number; uiPort?: number; address?: string; namespace?: string; taskQueue?: string }) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    console.log(
      JSON.stringify({ ok: true, status: await manager.start(), _meta: cliInstanceMeta() }, null, 2)
    );
  });

temporalCommand
  .command("stop")
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--mode <mode>", "managed-local only")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("Stop Tychonic-managed local Temporal")
  .action(async (options: { mode?: TemporalConfig["mode"]; frontendPort?: number; uiPort?: number; address?: string; namespace?: string; taskQueue?: string }) => {
    const manager = new TemporalManager(temporalConfigFromOptions(options));
    const status = await manager.stop();
    console.log(JSON.stringify({ ok: status.ok, status, _meta: cliInstanceMeta() }, null, 2));
    if (!status.ok) {
      process.exitCode = 1;
    }
  });

temporalCommand
  .command("worker")
  .option("--frontend-port <port>", "managed-local Temporal frontend port", (value) => Number(value))
  .option("--ui-port <port>", "managed-local Temporal UI port", (value) => Number(value))
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .option("--shutdown-grace-time <duration>", "worker drain time on shutdown before cancelling in-flight activities")
  .description("Run the Tychonic TypeScript Temporal worker")
  .action(async (options: {
    frontendPort?: number;
    uiPort?: number;
    mode?: TemporalConfig["mode"];
    address?: string;
    namespace?: string;
    taskQueue?: string;
    shutdownGraceTime?: string;
  }) => {
    await runTemporalWorker({
      ...temporalConfigFromOptions(options),
      ...(options.shutdownGraceTime ? { shutdownGraceTime: options.shutdownGraceTime } : {})
    });
  });

const sessionsCommand = program
  .command("sessions")
  .option("--workflow-id <id>", "Temporal workflow id")
  .option("--run-id <id>", "Temporal run id")
  .option("--limit <n>", "maximum number of sessions", (value) => Number(value), 20)
  .option("--mode <mode>", "managed-local or external")
  .option("--address <address>", "Temporal frontend address")
  .option("--namespace <name>", "Temporal namespace")
  .option("--task-queue <name>", "Temporal task queue")
  .description("List recorded agent sessions through Temporal result metadata")
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

sessionsCommand
  .command("register")
  .requiredOption("--agent <name>", "agent name")
  .requiredOption("--id <id>", "Tychonic session id")
  .option("--role <role>", "worker, reviewer, or verifier", "worker")
  .requiredOption("--session-cwd <dir>", "working directory for the agent session")
  .option("--external-session-id <id>", "external agent session id")
  .option("--resume-command <cmd>", "command used to resume this session")
  .option("--status <status>", "running, succeeded, failed, timed_out, or unknown", "unknown")
  .description("Register an agent session through Temporal")
  .action(
    async (options: {
      agent: string;
      id: string;
      role: "worker" | "reviewer" | "verifier";
      sessionCwd: string;
      externalSessionId?: string;
      resumeCommand?: string;
      status: "running" | "succeeded" | "failed" | "timed_out" | "unknown";
    }) => {
      const workflowOptions = sessionsCommand.opts<TemporalResultCommandOptions>();
      requireWorkflowId(workflowOptions);
      if (!["worker", "reviewer", "verifier"].includes(options.role)) {
        throw new Error("--role must be one of worker, reviewer, verifier");
      }
      if (!["running", "succeeded", "failed", "timed_out", "unknown"].includes(options.status)) {
        throw new Error("--status must be one of running, succeeded, failed, timed_out, unknown");
      }
      const result = await signalSimpleWorkflowRegisterSession({
        workflowId: workflowOptions.workflowId,
        ...(workflowOptions.runId ? { runId: workflowOptions.runId } : {}),
        id: options.id,
        agent: options.agent,
        role: options.role,
        cwd: options.sessionCwd,
        status: options.status,
        ...(options.externalSessionId ? { externalSessionId: options.externalSessionId } : {}),
        ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
        startedAt: new Date().toISOString(),
        ...(workflowOptions.mode ? { mode: workflowOptions.mode } : {}),
        ...(workflowOptions.address ? { address: workflowOptions.address } : {}),
        ...(workflowOptions.namespace ? { namespace: workflowOptions.namespace } : {}),
        ...(workflowOptions.taskQueue ? { taskQueue: workflowOptions.taskQueue } : {})
      });
      console.log(JSON.stringify({ ok: true, mode: "temporal", ...result }, null, 2));
    }
  );

interface RunCommandOptions {
  input?: string;
  inputFile?: string;
  mode?: TemporalConfig["mode"];
  address?: string;
  namespace?: string;
  taskQueue?: string;
  workflowId?: string;
  wait?: boolean;
}

async function startNamedWorkflowFromCli(workflowType: string, options: RunCommandOptions): Promise<void> {
  const workflowInput = await resolveRunWorkflowInput(options);
  const result = await startNamedTemporalWorkflow({
    workflowType,
    ...(workflowInput.hasInput ? { input: workflowInput.input } : {}),
    wait: Boolean(options.wait),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.taskQueue ? { taskQueue: options.taskQueue } : {}),
    ...(options.workflowId ? { workflowId: options.workflowId } : {})
  });
  console.log(JSON.stringify({ ok: true, mode: "temporal", ...result, _meta: cliInstanceMeta() }, null, 2));
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

interface TemporalResultCommandOptions {
  workflowId?: string;
  runId?: string;
  mode?: TemporalConfig["mode"];
  address?: string;
  namespace?: string;
  taskQueue?: string;
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
  mode?: TemporalConfig["mode"];
  address?: string;
  namespace?: string;
  taskQueue?: string;
}): Promise<string> {
  if (options.explicitState && options.explicitState.length > 0) {
    return options.explicitState;
  }
  const queryResult = await queryInteractionPendingState({
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
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
      throw new Error(`--patch-file ${options.patchFile} must contain a JSON object matching StateRecordPatch`);
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
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
  });

  if (!workflow.result) {
    const suffix = workflow.resultError ? `: ${workflow.resultError}` : "";
    throw new Error(`Temporal workflow result is unavailable while status is ${workflow.status}${suffix}`);
  }
  assertTychonicWorkflowResult(workflow.result);
  return workflow.result;
}

function workflowsBundleDirName(directory: string): string {
  const absolute = resolveAbsolute(directory);
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
      `no installed workflow bundle named ${JSON.stringify(name)}. ` +
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
      note: `instance='${active}' is a foreground-only isolated instance; stop and restart 'tychonic runtime up --instance ${active}' (or 'runtime up --instance ${active} --detach') to pick up the new bundle.`
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

type ResolveBundleConfigOptions = {
  workflowId: string;
  runId?: string;
  overridePath?: string;
  mode?: TemporalConfig["mode"];
  address?: string;
  namespace?: string;
  taskQueue?: string;
};

async function resolveBundleConfigForWorkflow(options: ResolveBundleConfigOptions): Promise<{
  profile: Awaited<ReturnType<typeof loadBundleConfig>>;
  source: "bundle" | { override: string };
  workflowType: string;
}> {
  const description = await describeTychonicTemporalWorkflow({
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
  });
  const workflowType = description.type;
  if (options.overridePath) {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(options.overridePath, "utf8");
    return {
      profile: parseBundleConfigYaml(raw),
      source: { override: options.overridePath },
      workflowType
    };
  }
  const bundleDir = await bundleDirForInstalledName(workflowType);
  return {
    profile: await loadBundleConfig(bundleDir),
    source: "bundle",
    workflowType
  };
}

/**
 * `runtime up --detach` handler. Spawns the current CLI again (same
 * `--instance <name>`) in a new session with stdio → `runtime.log`, then
 * exits 0. Refuses without an active instance — operational launchd
 * already supervises the production runtime; `--detach` is for isolated
 * instances only.
 */
async function handleRuntimeUpDetach(options: {
  cwd: string;
  web: boolean;
  webHost: string;
  webPort?: number;
  allowNetworkBind: boolean;
  frontendPort?: number;
  uiPort?: number;
  mode?: TemporalConfig["mode"];
  address?: string;
  namespace?: string;
  taskQueue?: string;
  shutdownGraceTime?: string;
}): Promise<void> {
  const instance = getActiveInstance();
  if (instance === undefined) {
    throw new Error(
      "runtime up --detach requires --instance <name>; detached mode is for isolated instances only"
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
        `instance '${instance}' already has a detached runtime (pid=${existingPid}); stop it with 'tychonic runtime reset --instance ${instance}'`
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
        "(for example, `workflows install dist/workflow-bundles/simpleWorkflow`), " +
        `then rerun \`tychonic runtime up --instance ${instance} --detach\`.`
    );
  }

  // Reconstruct the flags the child should receive. `--detach` itself is
  // not forwarded (child runs foreground); `--instance` is re-passed
  // explicitly inside spawnDetachedRuntime.
  const extraArgs: string[] = [];
  if (options.cwd) extraArgs.push("--cwd", options.cwd);
  if (options.web === false) extraArgs.push("--no-web");
  if (options.webHost) extraArgs.push("--web-host", options.webHost);
  if (options.webPort !== undefined) extraArgs.push("--web-port", String(options.webPort));
  if (options.allowNetworkBind) extraArgs.push("--allow-network-bind");
  if (options.frontendPort !== undefined)
    extraArgs.push("--frontend-port", String(options.frontendPort));
  if (options.uiPort !== undefined) extraArgs.push("--ui-port", String(options.uiPort));
  if (options.mode) extraArgs.push("--mode", options.mode);
  if (options.address) extraArgs.push("--address", options.address);
  if (options.namespace) extraArgs.push("--namespace", options.namespace);
  if (options.taskQueue) extraArgs.push("--task-queue", options.taskQueue);
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
        ...(staleRemoved ? { staleRemoved: true } : {}),
        _meta: cliInstanceMeta()
      },
      null,
      2
    )
  );
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
        removed: result.removed,
        _meta: cliInstanceMeta()
      },
      null,
      2
    )
  );
}

function temporalConfigFromOptions(options: {
  mode?: TemporalConfig["mode"];
  frontendPort?: number;
  uiPort?: number;
  address?: string;
  namespace?: string;
  taskQueue?: string;
}): TemporalConfig {
  return {
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.frontendPort ? { frontendPort: options.frontendPort } : {}),
    ...(options.uiPort ? { uiPort: options.uiPort } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
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

async function closeStartedWebServer(started: StartedWebServer | undefined): Promise<void> {
  if (!started) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    started.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
