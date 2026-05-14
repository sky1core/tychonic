import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTychonicWorkflowResult,
  workflowEvidenceView,
  type TychonicWorkflowResult
} from "../cli/temporalResultViews.js";
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

const DEFAULT_STATUS_UI_PORT = 19733;

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
      output.evidence = {
        ...workflowEvidenceView(workflow.result, workflow.workflowId, workflow.runId),
        states: workflow.result.run.states,
        state_attempt_summaries: workflowStateAttemptSummaries(workflow.result.run)
      };
    } catch (error) {
      output.evidenceError = error instanceof Error ? error.message : String(error);
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
}> {
  const stateNameById = new Map(run.states.map((state) => [state.id, state.name]));
  return run.activity_attempts.map((attempt) => {
    const stateName = stateNameById.get(attempt.state_id);
    return {
      id: attempt.id,
      state_id: attempt.state_id,
      ...(stateName ? { state_name: stateName } : {}),
      kind: attempt.kind,
      status: attempt.status
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
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

  response.writeHead(200, { "content-type": contentType(filePath) });
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
    ...(workflow.resultError ? { resultError: workflow.resultError } : {})
  };
}

function normalizeLoopbackBindHost(host: string): string | undefined {
  const normalized = host.toLowerCase();
  if (normalized === "[::1]") {
    return "::1";
  }
  return isLoopbackHost(normalized) ? normalized : undefined;
}

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  const host = hostFromHeader(hostHeader);
  return host !== undefined && isLoopbackHost(host.toLowerCase());
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
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
