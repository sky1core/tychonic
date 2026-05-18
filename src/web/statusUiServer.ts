import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { parse as parseYaml } from "yaml";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTychonicWorkflowResult,
  workflowEvidenceView,
  type TychonicWorkflowResult
} from "../cli/temporalResultViews.js";
import { runArtifactStoreForRun } from "../storage/runArtifactStore.js";
import {
  parseDeclarativeWorkflowSpecYaml,
  type DeclarativeTransition,
  type DeclarativeWorkflowSpec
} from "../declarative/workflowSpec.js";
import {
  describeTychonicTemporalWorkflow,
  listTychonicTemporalWorkflows,
  type DescribeTychonicTemporalWorkflowOptions,
  type ListTychonicTemporalWorkflowsOptions,
  type TychonicTemporalWorkflowList,
  type TychonicTemporalWorkflowStatus
} from "../temporal/client.js";
import type { TemporalConfig } from "../temporal/manager.js";
import { BUNDLE_FILE_NAMES, runtimeWorkflowModulesDir } from "../temporal/workflowModules.js";
import { tychonicRunsParentDir } from "../runtime/runDirs.js";

export interface StatusUiServerOptions extends TemporalConfig {
  uiHost?: string;
  uiPort?: number;
  staticDir?: string;
}

export interface StatusUiServerHandle {
  server: Server;
  url: string;
  staticDir: string;
}

export interface StatusUiServerDeps {
  listWorkflows: (options: ListTychonicTemporalWorkflowsOptions) => Promise<TychonicTemporalWorkflowList>;
  describeWorkflow: (options: DescribeTychonicTemporalWorkflowOptions) => Promise<TychonicTemporalWorkflowStatus>;
}

export const DEFAULT_STATUS_UI_PORT = 19733;

type PendingActiveStateView = {
  state: {
    id: string;
    name: string;
    status: "running";
    reason: "pending_activity";
    activity_attempt_ids: string[];
    artifact_ids: string[];
    finding_ids: string[];
    started_at?: string;
  };
  attemptId: string;
};

export function defaultStatusUiStaticDir(): string {
  return fileURLToPath(new URL("../../dist/web-client", import.meta.url));
}

export async function startStatusUiServer(options: StatusUiServerOptions = {}): Promise<StatusUiServerHandle> {
  return startStatusUiServerWithDeps(options, {
    listWorkflows: listTychonicTemporalWorkflows,
    describeWorkflow: describeTychonicTemporalWorkflow
  });
}

export async function startStatusUiServerWithDeps(
  options: StatusUiServerOptions,
  deps: StatusUiServerDeps
): Promise<StatusUiServerHandle> {
  const host = normalizeLoopbackBindHost(options.uiHost ?? "127.0.0.1");
  if (!host) {
    throw new Error("--host must be a loopback address for the local-only status UI");
  }
  const port = options.uiPort ?? DEFAULT_STATUS_UI_PORT;
  const staticDir = resolve(options.staticDir ?? defaultStatusUiStaticDir());
  await assertStatusUiStaticDir(staticDir);
  const temporalConfig = temporalConfigFromStatusUiOptions(options);
  const server = createServer((request, response) => {
    void handleStatusUiRequest({
      request,
      response,
      staticDir,
      temporalConfig,
      deps
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    url: `http://${formatUrlHost(host)}:${boundPort}`,
    staticDir
  };
}

async function assertStatusUiStaticDir(staticDir: string): Promise<void> {
  const indexPath = join(staticDir, "index.html");
  const indexStat = await stat(indexPath).catch(() => undefined);
  if (!indexStat?.isFile()) {
    throw new Error(`status UI assets not found under ${staticDir}; run npm run build:web-client`);
  }
}

export async function handleStatusUiRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  staticDir: string;
  temporalConfig: TemporalConfig;
  deps: StatusUiServerDeps;
}): Promise<void> {
  const { request, response, staticDir, temporalConfig, deps } = input;
  try {
    if (!isLoopbackHostHeader(request.headers.host)) {
      writeJson(response, 403, { ok: false, error: "host header must be loopback for the local-only status UI" });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(response, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/events") {
      await handleStatusEventsApi(request, response, url, temporalConfig, deps);
      return;
    }
    if (url.pathname === "/api/workflows") {
      await handleWorkflowListApi(response, url, temporalConfig, deps);
      return;
    }
    if (url.pathname.startsWith("/api/workflows/")) {
      await handleWorkflowDetailApi(response, url, temporalConfig, deps);
      return;
    }

    await serveStaticAsset(request, response, staticDir, url.pathname);
  } catch (error) {
    writeJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleWorkflowListApi(
  response: ServerResponse,
  url: URL,
  temporalConfig: TemporalConfig,
  deps: StatusUiServerDeps
): Promise<void> {
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    writeJson(response, 400, { ok: false, error: "limit must be a positive integer" });
    return;
  }
  const query = url.searchParams.get("query");
  const result = await deps.listWorkflows({
    limit,
    ...(query ? { query } : {}),
    ...temporalConfig
  });
  writeJson(response, 200, { ok: true, ...result });
}

async function handleStatusEventsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  temporalConfig: TemporalConfig,
  deps: StatusUiServerDeps
): Promise<void> {
  if (request.method === "HEAD") {
    response.writeHead(200, statusEventHeaders());
    response.end();
    return;
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 30 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    writeJson(response, 400, { ok: false, error: "limit must be a positive integer" });
    return;
  }

  const workflowId = url.searchParams.get("workflowId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  response.writeHead(200, statusEventHeaders());
  response.write(": connected\n\n");

  let closed = false;
  let sequence = 0;
  let queuedRefresh: ReturnType<typeof setTimeout> | undefined;
  const closeWatchers: Array<() => void> = [];

  const close = () => {
    if (closed) return;
    closed = true;
    if (queuedRefresh) clearTimeout(queuedRefresh);
    for (const closeWatcher of closeWatchers.splice(0)) closeWatcher();
    if (!response.destroyed && !response.writableEnded) response.end();
  };

  const sendRefresh = () => {
    if (closed) return;
    sequence += 1;
    if (!writeStatusEvent(response, "refresh", {
      sequence,
      workflowId,
      ...(runId ? { runId } : {}),
      createdAt: new Date().toISOString()
    })) close();
  };

  const queueRefresh = () => {
    if (closed || queuedRefresh) return;
    queuedRefresh = setTimeout(() => {
      queuedRefresh = undefined;
      sendRefresh();
    }, 50);
  };

  request.on("close", close);
  request.on("aborted", close);
  sendRefresh();
  if (workflowId && runId) {
    try {
      const closeWatcher = await watchSelectedRunEvidence({
        workflowId,
        runId,
        temporalConfig,
        deps,
        onChange: queueRefresh
      });
      if (closed) closeWatcher();
      else closeWatchers.push(closeWatcher);
    } catch (error) {
      if (!closed) {
        if (!writeStatusEvent(response, "status_error", {
          message: error instanceof Error ? error.message : String(error)
        })) close();
      }
    }
  }
}

async function watchSelectedRunEvidence(input: {
  workflowId: string;
  runId: string;
  temporalConfig: TemporalConfig;
  deps: StatusUiServerDeps;
  onChange: () => void;
}): Promise<() => void> {
  const watchers: FSWatcher[] = [];
  const watchedDirs = new Set<string>();
  let closed = false;
  let liveOutputWatcher: FSWatcher | undefined;
  let attachInFlight = false;

  const closeLiveOutputWatcher = () => {
    if (!liveOutputWatcher) return;
    liveOutputWatcher.close();
    liveOutputWatcher = undefined;
  };

  const watchDir = (dir: string, onChange: (filename: string | Buffer | null) => void): boolean => {
    const resolvedDir = resolve(dir);
    if (closed || watchedDirs.has(resolvedDir)) return true;
    try {
      const watcher = watch(resolvedDir, { persistent: false }, (_event, filename) => {
        if (!closed) onChange(filename);
      });
      watchers.push(watcher);
      watchedDirs.add(resolvedDir);
      return true;
    } catch {
      return false;
    }
  };

  const watchExistingAncestor = async (
    targetDir: string,
    onChange: (filename: string | Buffer | null) => void
  ): Promise<void> => {
    let current = resolve(targetDir);
    while (!closed) {
      try {
        if ((await stat(current)).isDirectory()) {
          watchDir(current, onChange);
          return;
        }
      } catch { /* try parent */ }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };

  const refreshAndAttach = () => {
    if (closed || attachInFlight) return;
    attachInFlight = true;
    void attachSelectedRunWatchers().finally(() => {
      attachInFlight = false;
    });
    input.onChange();
  };

  const watchLiveOutputFile = async (
    artifactsDir: string,
    liveDir: string,
    promptPrefix: string,
    heartbeatAttemptId: string | undefined
  ) => {
    if (closed || !promptPrefix) return;
    const files = await readdir(artifactsDir).catch((): string[] => []);
    if (closed) return;
    const heartbeatPromptFile = heartbeatAttemptId ? `${promptPrefix}${heartbeatAttemptId}.txt` : undefined;
    const promptFile = heartbeatPromptFile && files.includes(heartbeatPromptFile)
      ? heartbeatPromptFile
      : files
        .filter((f) => f.startsWith(promptPrefix) && f.endsWith(".txt"))
        .sort()
        .at(-1);
    if (!promptFile) return;
    const attemptId = promptFile.slice(promptPrefix.length, -".txt".length);
    const liveOutputPath = join(liveDir, `${attemptId}.log`);
    closeLiveOutputWatcher();
    if (closed) return;
    try {
      const watcher = watch(liveOutputPath, { persistent: false }, input.onChange);
      if (closed) {
        watcher.close();
        return;
      }
      liveOutputWatcher = watcher;
      input.onChange();
    } catch {
      /* live log may not exist yet; liveDir watcher will observe creation */
    }
  };

  async function attachSelectedRunWatchers(): Promise<void> {
    if (closed) return;
    let workflow: TychonicTemporalWorkflowStatus;
    try {
      workflow = await input.deps.describeWorkflow({
        workflowId: input.workflowId,
        runId: input.runId,
        includeResult: true,
        ...input.temporalConfig
      });
    } catch {
      return;
    }
    if (closed || workflow.status !== "RUNNING") return;
    if (!workflow.result) {
      await watchExistingAncestor(tychonicRunsParentDir(), refreshAndAttach);
      return;
    }
    try {
      assertTychonicWorkflowResult(workflow.result);
    } catch {
      return;
    }
    const pendingActiveState = pendingActiveStateView(workflow, workflow.result);
    const activeStateName = pendingActiveState?.state.name ??
      (workflow.result.activeState?.status === "running" ? workflow.result.activeState.name : undefined);
    const store = runArtifactStoreForRun(workflow.result.run);
    const runDir = store.runDir(workflow.result.run.id);
    const artifactsDir = store.artifactsDir(workflow.result.run.id);
    const liveDir = store.liveDir(workflow.result.run.id);
    const promptPrefix = activeStateName ? `${activeStateName}_prompt-` : undefined;

    await watchExistingAncestor(dirname(runDir), () => {
      refreshAndAttach();
    });
    await watchExistingAncestor(runDir, (filename) => {
      const changedName = filename === null ? undefined : String(filename);
      if (changedName === undefined || changedName === "artifacts" || changedName === "live") refreshAndAttach();
    });
    await watchExistingAncestor(artifactsDir, (filename) => {
      if (!promptPrefix || filename === null || String(filename).startsWith(promptPrefix)) {
        if (promptPrefix) void watchLiveOutputFile(artifactsDir, liveDir, promptPrefix, pendingActiveState?.attemptId);
        input.onChange();
      }
    });
    await watchExistingAncestor(liveDir, (filename) => {
      if (filename === null || String(filename).endsWith(".log")) {
        if (promptPrefix) void watchLiveOutputFile(artifactsDir, liveDir, promptPrefix, pendingActiveState?.attemptId);
        input.onChange();
      }
    });
    if (promptPrefix) await watchLiveOutputFile(artifactsDir, liveDir, promptPrefix, pendingActiveState?.attemptId);
  }

  await attachSelectedRunWatchers();
  return () => {
    closed = true;
    closeLiveOutputWatcher();
    for (const watcher of watchers) watcher.close();
  };
}

function statusEventHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  };
}

function writeStatusEvent(response: ServerResponse, event: string, payload: Record<string, unknown>): boolean {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

async function statusEventSignature(input: {
  limit: number;
  workflowId?: string;
  runId?: string;
  temporalConfig: TemporalConfig;
  deps: StatusUiServerDeps;
}): Promise<string> {
  const workflows = await input.deps.listWorkflows({
    limit: input.limit,
    ...input.temporalConfig
  });
  const workflowSummaries = workflows.workflows.map((workflow) => ({
    workflowId: workflow.workflowId,
    runId: workflow.runId,
    status: workflow.status,
    historyLength: workflow.historyLength,
    closeTime: workflow.closeTime,
    executionTime: workflow.executionTime
  }));
  const selected = input.workflowId
    ? await input.deps.describeWorkflow({
        workflowId: input.workflowId,
        ...(input.runId ? { runId: input.runId } : {}),
        includeResult: true,
        ...input.temporalConfig
      })
    : undefined;
  return JSON.stringify({
    workflows: workflowSummaries,
    selected: selected ? await workflowStatusEventSignature(selected) : undefined
  });
}

async function workflowStatusEventSignature(workflow: TychonicTemporalWorkflowStatus): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    workflowId: workflow.workflowId,
    runId: workflow.runId,
    status: workflow.status,
    historyLength: workflow.historyLength,
    closeTime: workflow.closeTime,
    resultError: workflow.resultError,
    result: workflowResultEventSignature(workflow.result)
  };
  if (workflow.status === "RUNNING" && workflow.result && isRecord(workflow.result)) {
    const activeState = isRecord(workflow.result.activeState) ? workflow.result.activeState : undefined;
    if (activeState && activeState.status === "running" && typeof activeState.name === "string") {
      base.activeStateName = activeState.name;
      try {
        const run = workflow.result.run as TychonicWorkflowResult["run"];
        const store = runArtifactStoreForRun(run);
        const promptPrefix = `${activeState.name}_prompt-`;
        const artifactFiles = await readdir(store.artifactsDir(run.id));
        const promptFile = artifactFiles.filter((f: string) => f.startsWith(promptPrefix) && f.endsWith(".txt")).sort().at(-1);
        if (promptFile) {
          base.hasPrompt = true;
          const attemptId = promptFile.slice(promptPrefix.length, -".txt".length);
          try {
            const logStat = await stat(join(store.liveDir(run.id), `${attemptId}.log`));
            base.liveLogSize = logStat.size;
          } catch { /* live log may not exist yet */ }
        }
      } catch { /* artifacts dir may not exist yet */ }
    }
  }
  return base;
}

function workflowResultEventSignature(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  const run = isRecord(result.run) ? result.run : undefined;
  const states = Array.isArray(run?.states) ? run.states : [];
  const attempts = Array.isArray(run?.activity_attempts) ? run.activity_attempts : [];
  const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : [];
  const findings = Array.isArray(run?.findings) ? run.findings : [];
  const inbox = Array.isArray(run?.inbox) ? run.inbox : [];
  const latestState = states.length > 0 && isRecord(states[states.length - 1]) ? states[states.length - 1] : undefined;
  return {
    status: typeof result.status === "string" ? result.status : undefined,
    runStatus: typeof run?.status === "string" ? run.status : undefined,
    updatedAt: typeof run?.updated_at === "string" ? run.updated_at : undefined,
    stateCount: states.length,
    attemptCount: attempts.length,
    artifactCount: artifacts.length,
    findingCount: findings.length,
    inboxCount: inbox.length,
    latestState: latestState
      ? {
          id: latestState.id,
          name: latestState.name,
          status: latestState.status,
          reason: latestState.reason,
          finished_at: latestState.finished_at
        }
      : undefined,
    activeState: isRecord(result.activeState)
      ? { name: result.activeState.name, status: result.activeState.status }
      : undefined
  };
}

function pendingActiveStateView(
  workflow: TychonicTemporalWorkflowStatus,
  result: TychonicWorkflowResult
): PendingActiveStateView | undefined {
  const candidates: Array<{ view: PendingActiveStateView; sortTime: number }> = [];
  for (const activity of workflow.pendingActivities) {
    for (const detail of activity.heartbeatDetails ?? []) {
      if (!isRecord(detail)) continue;
      if (detail.runId !== result.run.id) continue;
      if (typeof detail.state !== "string" || detail.state.length === 0) continue;
      const attemptId = typeof detail.attemptId === "string" && detail.attemptId.length > 0
        ? detail.attemptId
        : `activity_${activity.activityId}`;
      const view: PendingActiveStateView = {
        state: {
          id: `pending:${detail.state}:${attemptId}`,
          name: detail.state,
          status: "running",
          reason: "pending_activity",
          activity_attempt_ids: [attemptId],
          artifact_ids: [],
          finding_ids: [],
          ...(activity.lastStartedTime ?? activity.lastHeartbeatTime
            ? { started_at: activity.lastStartedTime ?? activity.lastHeartbeatTime }
            : {})
        },
        attemptId
      };
      const sortTime = Date.parse(activity.lastHeartbeatTime ?? activity.lastStartedTime ?? "");
      candidates.push({ view, sortTime: Number.isFinite(sortTime) ? sortTime : 0 });
    }
  }
  return candidates.sort((a, b) => b.sortTime - a.sortTime)[0]?.view;
}

async function handleWorkflowDetailApi(
  response: ServerResponse,
  url: URL,
  temporalConfig: TemporalConfig,
  deps: StatusUiServerDeps
): Promise<void> {
  const encodedWorkflowId = url.pathname.slice("/api/workflows/".length);
  const workflowId = decodeURIComponent(encodedWorkflowId);
  if (workflowId.length === 0) {
    writeJson(response, 400, { ok: false, error: "workflow id is required" });
    return;
  }
  const runId = url.searchParams.get("runId") ?? undefined;
  const workflow = await deps.describeWorkflow({
    workflowId,
    ...(runId ? { runId } : {}),
    includeResult: true,
    ...temporalConfig
  });
  const output: Record<string, unknown> = { ok: true, workflow: workflowStatusUiView(workflow) };
  const workflowGraph = await loadWorkflowDefinitionGraph(workflow.type);
  if (workflowGraph.kind === "loaded") {
    output.workflowGraph = {
      mermaid: workflowGraph.mermaid,
      definition: workflowGraph.definition
    };
  } else if (workflowGraph.kind === "error") {
    output.workflowGraphError = workflowGraph.error;
  }
  if (workflow.result !== undefined) {
    try {
      assertTychonicWorkflowResult(workflow.result);
      const pendingActiveState = pendingActiveStateView(workflow, workflow.result);
      output.runContext = workflowRunContextView(workflow.result, workflow.input, workflow.inputError);
      const evidenceView = {
        ...workflowEvidenceView(workflow.result, workflow.workflowId, workflow.runId),
        states: workflow.result.run.states,
        state_attempt_summaries: workflowStateAttemptSummaries(workflow.result.run)
      };
      output.evidence = evidenceView;
      if (pendingActiveState) {
        output.pendingActiveState = pendingActiveState.state;
      }
      output.artifactContents = await loadArtifactContents(workflow.result);
      output.stateConfigs = await loadStateConfigs(workflow.result);
      const activeEvidence = await loadActiveStateEvidence(workflow.result, pendingActiveState);
      if (activeEvidence) {
        output.activeStateEvidence = activeEvidence;
      }
    } catch (error) {
      output.evidenceError = error instanceof Error ? error.message : String(error);
    }
  } else {
    const runContext = workflowRunContextView(undefined, workflow.input, workflow.inputError);
    if (runContext !== undefined) {
      output.runContext = runContext;
    }
  }
  writeJson(response, 200, output);
}

function workflowStateAttemptSummaries(run: TychonicWorkflowResult["run"]): Array<{
  id: string;
  state_id: string;
  state_name?: string;
  kind: string;
  status: string;
  command?: string;
  agent_session_id?: string;
}> {
  const stateNameById = new Map(run.states.map((state) => [state.id, state.name]));
  return run.activity_attempts.map((attempt) => {
    const stateName = stateNameById.get(attempt.state_id);
    return {
      id: attempt.id,
      state_id: attempt.state_id,
      ...(stateName ? { state_name: stateName } : {}),
      kind: attempt.kind,
      status: attempt.status,
      ...(attempt.command ? { command: attempt.command } : {}),
      ...(attempt.agent_session_id ? { agent_session_id: attempt.agent_session_id } : {})
    };
  });
}

async function loadWorkflowDefinitionGraph(
  workflowType: string
): Promise<{ kind: "loaded"; mermaid: string; definition: WorkflowDefinitionGraph } | { kind: "missing" } | { kind: "error"; error: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(workflowType)) {
    return { kind: "error", error: `workflow type is not a valid installed bundle name: ${workflowType}` };
  }
  const modulesDir = runtimeWorkflowModulesDir();
  const bundleDir = join(modulesDir, workflowType);
  const graphPath = join(bundleDir, BUNDLE_FILE_NAMES.generatedMermaid);
  const specPath = join(bundleDir, BUNDLE_FILE_NAMES.workflowSpec);
  try {
    const [mermaid, workflowYaml] = await Promise.all([
      readFile(graphPath, "utf8"),
      readFile(specPath, "utf8")
    ]);
    const spec = parseDeclarativeWorkflowSpecYaml({
      source: workflowYaml,
      bundleName: workflowType,
      sourcePath: BUNDLE_FILE_NAMES.workflowSpec
    });
    return {
      kind: "loaded",
      mermaid,
      definition: workflowDefinitionGraph(spec)
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { kind: "missing" };
    }
    return {
      kind: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

type WorkflowDefinitionGraph = {
  start: string;
  maxSteps: number;
  states: Array<{
    name: string;
    type: string;
    reviewReturnTo?: string;
  }>;
  edges: Array<{
    id: string;
    from: string;
    label: "pass" | "fail";
    to?: string;
    finish?: boolean;
  }>;
};

function workflowDefinitionGraph(spec: DeclarativeWorkflowSpec): WorkflowDefinitionGraph {
  return {
    start: spec.start,
    maxSteps: spec.max_steps,
    states: Object.entries(spec.states).map(([name, state]) => ({
      name,
      type: state.type,
      ...(state.on_fail_return_to ? { reviewReturnTo: state.on_fail_return_to } : {})
    })),
    edges: Object.entries(spec.states).flatMap(([name, state]) => [
      workflowDefinitionEdge(name, "pass", state.on_pass),
      workflowDefinitionEdge(name, "fail", state.on_fail)
    ])
  };
}

function workflowDefinitionEdge(
  from: string,
  label: "pass" | "fail",
  transition: DeclarativeTransition
): WorkflowDefinitionGraph["edges"][number] {
  if ("finish" in transition) {
    return {
      id: `${from}:${label}:finish`,
      from,
      label,
      finish: true
    };
  }
  return {
    id: `${from}:${label}:${transition.goto}`,
    from,
    label,
    to: transition.goto
  };
}

async function serveStaticAsset(
  request: IncomingMessage,
  response: ServerResponse,
  staticDir: string,
  pathname: string
): Promise<void> {
  const filePath = staticFilePath(staticDir, pathname);
  const fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat?.isFile()) {
    if (isAssetPath(pathname)) {
      writeJson(response, 404, { ok: false, error: "status UI asset not found" });
      return;
    }
    const fallbackPath = join(staticDir, "index.html");
    const fallback = await readFile(fallbackPath).catch(() => undefined);
    if (!fallback) {
      writeJson(response, 503, {
        ok: false,
        error: `status UI assets not found under ${staticDir}; run npm run build:web-client`
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    if (request.method !== "HEAD") response.end(fallback);
    else response.end();
    return;
  }

  const content = await readFile(filePath).catch(() => undefined);
  if (content === undefined) {
    if (isAssetPath(pathname)) {
      writeJson(response, 404, { ok: false, error: "status UI asset not found" });
      return;
    }
    writeJson(response, 503, {
      ok: false,
      error: `status UI asset could not be read from ${filePath}`
    });
    return;
  }

  const cacheHeader = isAssetPath(pathname) ? "public, max-age=31536000, immutable" : "no-cache";
  response.writeHead(200, { "content-type": contentType(filePath), "cache-control": cacheHeader });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(content);
}

function staticFilePath(staticDir: string, pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return join(staticDir, "index.html");
  }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = resolve(staticDir, normalize(requested));
  const rel = relative(staticDir, resolved);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("/")) {
    return join(staticDir, "index.html");
  }
  return resolved;
}

function isAssetPath(pathname: string): boolean {
  return pathname.startsWith("/assets/") || pathname === "/favicon.svg" || pathname === "/favicon.ico";
}

function workflowStatusUiView(workflow: TychonicTemporalWorkflowStatus): Record<string, unknown> {
  return {
    workflowId: workflow.workflowId,
    runId: workflow.runId,
    type: workflow.type,
    taskQueue: workflow.taskQueue,
    status: workflow.status,
    ...(workflow.historyLength !== undefined ? { historyLength: workflow.historyLength } : {}),
    startTime: workflow.startTime,
    ...(workflow.executionTime ? { executionTime: workflow.executionTime } : {}),
    ...(workflow.closeTime ? { closeTime: workflow.closeTime } : {}),
    ...(workflow.pendingActivities.length > 0 ? { pendingActivityCount: workflow.pendingActivities.length } : {}),
    ...(workflow.inputError ? { inputError: workflow.inputError } : {}),
    ...(workflow.resultError ? { resultError: workflow.resultError } : {})
  };
}

function workflowRunContextView(
  result: TychonicWorkflowResult | undefined,
  input: unknown,
  inputError: string | undefined
): Record<string, unknown> | undefined {
  const inputRecord = isRecord(input) ? input : undefined;
  const promptAdditions = promptAdditionsView(inputRecord?.promptAdditions);
  const cwd = stringValue(inputRecord?.cwd) ?? result?.run.cwd;
  const goal = stringValue(inputRecord?.goal) ?? result?.run.goal;
  const view = {
    ...(cwd ? { cwd } : {}),
    ...(goal ? { goal } : {}),
    ...(promptAdditions ? { promptAdditions } : {}),
    ...(result?.run.created_at ? { createdAt: result.run.created_at } : {}),
    ...(result?.run.updated_at ? { updatedAt: result.run.updated_at } : {}),
    ...(result?.run.artifact_root ? { artifactRoot: result.run.artifact_root } : {}),
    ...(result?.worktreePath ? { worktreePath: result.worktreePath } : {}),
    ...(result?.run.profile_snapshot_artifact_id ? { profileSnapshotArtifactId: result.run.profile_snapshot_artifact_id } : {}),
    ...(inputError ? { inputError } : {})
  };
  return Object.keys(view).length > 0 ? view : undefined;
}

function promptAdditionsView(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLoopbackBindHost(host: string): string | undefined {
  const normalized = host.toLowerCase();
  if (normalized === "[::1]") {
    return "::1";
  }
  return isLoopbackBindHost(normalized) ? normalized : undefined;
}

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  const host = hostFromHeader(hostHeader);
  if (host === undefined) {
    return false;
  }
  if (isLoopbackRequestHost(host.toLowerCase())) {
    return true;
  }
  const allowed = process.env.TYCHONIC_WEB_ALLOWED_HOSTS;
  if (allowed) {
    return allowed.split(",").some((h) => h.trim().toLowerCase() === host.toLowerCase());
  }
  return false;
}

function hostFromHeader(hostHeader: string): string | undefined {
  const trimmed = hostHeader.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    const bracketEnd = trimmed.indexOf("]");
    if (bracketEnd < 0) {
      return undefined;
    }
    const rest = trimmed.slice(bracketEnd + 1);
    if (rest.length > 0 && !/^:\d+$/.test(rest)) {
      return undefined;
    }
    return trimmed.slice(1, bracketEnd);
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 0) {
    return trimmed;
  }
  if (colonCount === 1) {
    const [host, port] = trimmed.split(":");
    return host && port && /^\d+$/.test(port) ? host : undefined;
  }
  return trimmed;
}

function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function isLoopbackRequestHost(host: string): boolean {
  return isLoopbackBindHost(host) || host === "localhost";
}

async function loadArtifactContents(
  result: TychonicWorkflowResult
): Promise<Record<string, { content: string }>> {
  const out: Record<string, { content: string }> = {};
  try {
    const store = runArtifactStoreForRun(result.run);
    await Promise.all(
      result.run.artifacts.map(async (artifact) => {
        try {
          const filePath = store.artifactPath(result.run, artifact.id);
          out[artifact.id] = { content: await readFile(filePath, "utf8") };
        } catch { /* skip unreadable */ }
      })
    );
  } catch { /* no artifact root */ }
  return out;
}

async function loadActiveStateEvidence(
  result: TychonicWorkflowResult,
  pendingActiveState?: PendingActiveStateView
): Promise<{ promptContent?: string; liveOutput?: string } | undefined> {
  const activeStateName = pendingActiveState?.state.name ??
    (result.activeState?.status === "running" ? result.activeState.name : undefined);
  if (!activeStateName) return undefined;
  try {
    const store = runArtifactStoreForRun(result.run);
    const artifactsDir = store.artifactsDir(result.run.id);
    const liveDir = store.liveDir(result.run.id);
    let promptContent: string | undefined;
    let liveOutput: string | undefined;
    let attemptId: string | undefined;
    const promptPrefix = `${activeStateName}_prompt-`;
    try {
      const files = await readdir(artifactsDir);
      const heartbeatPromptFile = pendingActiveState ? `${promptPrefix}${pendingActiveState.attemptId}.txt` : undefined;
      const promptFile = heartbeatPromptFile && files.includes(heartbeatPromptFile)
        ? heartbeatPromptFile
        : files
          .filter((f) => f.startsWith(promptPrefix) && f.endsWith(".txt"))
          .sort()
          .at(-1);
      if (promptFile) {
        promptContent = await readFile(join(artifactsDir, promptFile), "utf8");
        attemptId = promptFile.slice(promptPrefix.length, -".txt".length);
      }
    } catch { /* artifacts dir may not exist yet */ }
    if (attemptId) {
      try {
        liveOutput = await readFile(join(liveDir, `${attemptId}.log`), "utf8");
      } catch { /* live log may not exist yet */ }
    }
    if (!promptContent && !liveOutput) return undefined;
    const out: { promptContent?: string; liveOutput?: string } = {};
    if (promptContent) out.promptContent = promptContent;
    if (liveOutput) out.liveOutput = liveOutput;
    return out;
  } catch { return undefined; }
}

async function loadStateConfigs(
  result: TychonicWorkflowResult
): Promise<Record<string, { type?: string; command?: string; agent?: string; model?: string; timeout?: string }>> {
  const out: Record<string, { type?: string; command?: string; agent?: string; model?: string; timeout?: string }> = {};
  try {
    const profileArtifactId = result.run.profile_snapshot_artifact_id;
    if (!profileArtifactId) return out;
    const store = runArtifactStoreForRun(result.run);
    const filePath = store.artifactPath(result.run, profileArtifactId);
    const content = await readFile(filePath, "utf8");
    const parsed = parseYaml(content);
    if (parsed && typeof parsed === "object" && "states" in parsed && parsed.states && typeof parsed.states === "object") {
      for (const [name, config] of Object.entries(parsed.states as Record<string, unknown>)) {
        if (!config || typeof config !== "object") continue;
        const cfg = config as Record<string, unknown>;
        const entry: Record<string, string> = {};
        if (typeof cfg.type === "string") entry.type = cfg.type;
        if (typeof cfg.command === "string") entry.command = cfg.command;
        if (typeof cfg.agent === "string") entry.agent = cfg.agent;
        if (typeof cfg.model === "string") entry.model = cfg.model;
        if (typeof cfg.timeout === "string") entry.timeout = cfg.timeout;
        if (Object.keys(entry).length > 0) out[name] = entry;
      }
    }
  } catch { /* profile not available */ }
  return out;
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
  response.end(JSON.stringify(body, null, 2));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    default:
      return "application/octet-stream";
  }
}

function temporalConfigFromStatusUiOptions(options: StatusUiServerOptions): TemporalConfig {
  return {
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.apiPort !== undefined ? { apiPort: options.apiPort } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.taskQueue ? { taskQueue: options.taskQueue } : {})
  };
}
