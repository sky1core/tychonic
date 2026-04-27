import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listRuntimeWorkflowModules,
  runtimeWorkflowModulesDir
} from "../temporal/workflowModules.js";
import {
  assertTychonicWorkflowResult,
  artifactContentPath,
  listArtifacts,
  listAgentSessions,
  listInboxItems,
  listLiveOutputAttempts,
  liveOutputContentPath,
  workflowResultView,
  type TychonicWorkflowResult
} from "../cli/temporalResultViews.js";
import {
  describeTychonicTemporalWorkflow,
  listTychonicTemporalWorkflows,
  type TychonicTemporalWorkflowList,
  type TychonicTemporalWorkflowStatus
} from "../temporal/client.js";
import type { TemporalConfig } from "../temporal/manager.js";
import { assertLoopbackHost, isLoopbackHost } from "../net/loopback.js";

export interface WebServerOptions extends TemporalConfig {
  cwd: string;
  host?: string;
  port?: number;
  webClientRoot?: string;
  temporalClient?: WebTemporalClient;
  allowNetworkBind?: boolean;
}

export interface WebTemporalClient {
  listWorkflows: (options: { limit?: number; query?: string }) => Promise<TychonicTemporalWorkflowList>;
  describeWorkflow: (options: {
    workflowId: string;
    runId?: string;
    includeResult?: boolean;
  }) => Promise<TychonicTemporalWorkflowStatus>;
}

export interface StartedWebServer {
  server: Server;
  url: string;
}

export async function startWebServer(options: WebServerOptions): Promise<StartedWebServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  assertLoopbackHost(host, options.allowNetworkBind === true);
  const temporalClient = options.temporalClient ?? defaultTemporalClient(options);
  const webClientRoot = options.webClientRoot ?? defaultWebClientRoot(options.cwd);
  const server = createServer((request, response) => {
    void handleRequest(options.cwd, webClientRoot, temporalClient, host, options.allowNetworkBind === true, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${actualPort}` };
}

function defaultWebClientRoot(cwd: string): string {
  const packageWebClientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web-client");
  if (existsSync(join(packageWebClientRoot, "index.html"))) {
    return packageWebClientRoot;
  }
  return resolve(cwd, "dist", "web-client");
}

async function handleRequest(
  cwd: string,
  webClientRoot: string,
  temporalClient: WebTemporalClient,
  boundHost: string,
  allowNetworkBind: boolean,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (!validateHostHeader(boundHost, allowNetworkBind, request, response)) {
      return;
    }

    if (request.method === "POST" && !validateMutationRequest(request, response)) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJSON(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && shouldServeClientAsset(url.pathname)) {
      if (await trySendClientAsset(webClientRoot, url.pathname, response)) {
        return;
      }
      if (url.pathname === "/") {
        sendJSON(response, 503, {
          ok: false,
          error: "web client is not built",
          remediation: "run npm run build"
        });
        return;
      }
      sendJSON(response, 404, { ok: false, error: "asset not found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/workflows") {
      const modules = await listRuntimeWorkflowModules();
      sendJSON(response, 200, {
        ok: true,
        directory: runtimeWorkflowModulesDir(),
        modules
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      const limit = positiveIntegerQuery(url, "limit") ?? 20;
      const query = optionalQuery(url, "query");
      const result = await temporalClient.listWorkflows({
        limit,
        ...(query ? { query } : {})
      });
      sendJSON(response, 200, { ok: true, mode: "temporal", ...result });
      return;
    }

    const runMatch = request.method === "GET" ? /^\/runs\/([^/]+)$/.exec(url.pathname) : null;
    if (runMatch) {
      const workflowId = decodeURIComponent(runMatch[1] ?? "");
      const runId = optionalQuery(url, "run_id");
      const result = await temporalClient.describeWorkflow({
        workflowId,
        ...(runId ? { runId } : {}),
        includeResult: boolQuery(url, "result")
      });
      sendJSON(response, 200, { ok: true, mode: "temporal", workflow: result });
      return;
    }

    if (request.method === "GET" && url.pathname === "/inbox") {
      const workflowId = requiredQuery(url, "workflow_id");
      const result = await loadWorkflowResult(temporalClient, workflowId, optionalQuery(url, "run_id"));
      sendJSON(response, 200, {
        ok: true,
        mode: "temporal",
        workflow_id: workflowId,
        ...workflowResultView(result),
        inbox: listInboxItems(result)
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      const workflowId = requiredQuery(url, "workflow_id");
      const limit = positiveIntegerQuery(url, "limit") ?? 20;
      const result = await loadWorkflowResult(temporalClient, workflowId, optionalQuery(url, "run_id"));
      sendJSON(response, 200, {
        ok: true,
        mode: "temporal",
        workflow_id: workflowId,
        ...workflowResultView(result),
        sessions: listAgentSessions(result, limit)
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/artifact") {
      const workflowId = requiredQuery(url, "workflow_id");
      const result = await loadWorkflowResult(temporalClient, workflowId, optionalQuery(url, "run_id"));
      const artifactId = optionalQuery(url, "id");
      if (artifactId) {
        sendText(response, 200, await readFile(artifactContentPath(result, artifactId), "utf8"));
        return;
      }
      sendJSON(response, 200, {
        ok: true,
        mode: "temporal",
        workflow_id: workflowId,
        ...workflowResultView(result),
        artifacts: listArtifacts(result)
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/log") {
      const workflowId = requiredQuery(url, "workflow_id");
      const result = await loadWorkflowResult(temporalClient, workflowId, optionalQuery(url, "run_id"));
      const attemptId = optionalQuery(url, "attempt");
      if (attemptId) {
        sendText(response, 200, await readFile(liveOutputContentPath(result, attemptId), "utf8"));
        return;
      }
      sendJSON(response, 200, {
        ok: true,
        mode: "temporal",
        workflow_id: workflowId,
        ...workflowResultView(result),
        attempts: listLiveOutputAttempts(result)
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "POST") {
      sendJSON(response, 405, { ok: false, error: "method not allowed" });
      return;
    }

    sendJSON(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJSON(response, 500, { ok: false, error: message });
  }
}

function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function validateMutationRequest(request: IncomingMessage, response: ServerResponse): boolean {
  const contentType = headerValue(request, "content-type");
  if (!contentType.toLowerCase().split(";").map((part) => part.trim()).includes("application/json")) {
    sendJSON(response, 415, { ok: false, error: "mutation requests require content-type application/json" });
    return false;
  }

  if (headerValue(request, "sec-fetch-site").toLowerCase() === "cross-site") {
    sendJSON(response, 403, { ok: false, error: "cross-site mutation requests are not allowed" });
    return false;
  }

  const origin = headerValue(request, "origin");
  if (origin && !originMatchesHost(origin, headerValue(request, "host"))) {
    sendJSON(response, 403, { ok: false, error: "cross-origin mutation requests are not allowed" });
    return false;
  }

  return true;
}

function validateHostHeader(
  boundHost: string,
  allowNetworkBind: boolean,
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  if (allowNetworkBind || !isLoopbackHost(boundHost)) {
    return true;
  }
  const host = hostHeaderHostname(headerValue(request, "host"));
  if (host && isLoopbackHost(host)) {
    return true;
  }
  sendJSON(response, 403, { ok: false, error: "loopback web requests require a loopback Host header" });
  return false;
}

function hostHeaderHostname(hostHeader: string): string | undefined {
  if (!hostHeader) {
    return undefined;
  }
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

function originMatchesHost(origin: string, host: string): boolean {
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function shouldServeClientAsset(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/assets/") || pathname.startsWith("/screenshots/") || extname(pathname) !== "";
}

async function trySendClientAsset(root: string, pathname: string, response: ServerResponse): Promise<boolean> {
  const assetPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const absolute = resolve(root, assetPath);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/") || rel.includes(":")) {
    return false;
  }

  try {
    const body = await readFile(absolute);
    response.writeHead(200, { "content-type": contentTypeFor(absolute) });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function defaultTemporalClient(config: TemporalConfig): WebTemporalClient {
  return {
    listWorkflows: (options) =>
      listTychonicTemporalWorkflows({
        ...config,
        ...options
      }),
    describeWorkflow: (options) =>
      describeTychonicTemporalWorkflow({
        ...config,
        ...options
      })
  };
}

async function loadWorkflowResult(
  temporalClient: WebTemporalClient,
  workflowId: string,
  runId?: string
): Promise<TychonicWorkflowResult> {
  const workflow = await temporalClient.describeWorkflow({
    workflowId,
    ...(runId ? { runId } : {}),
    includeResult: true
  });
  if (!workflow.result) {
    const suffix = workflow.resultError ? `: ${workflow.resultError}` : "";
    throw new Error(`Temporal workflow result is unavailable while status is ${workflow.status}${suffix}`);
  }
  assertTychonicWorkflowResult(workflow.result);
  return workflow.result;
}

function requiredQuery(url: URL, name: string): string {
  const value = optionalQuery(url, name);
  if (!value) {
    throw new Error(`missing required query parameter: ${name}`);
  }
  return value;
}

function optionalQuery(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

function positiveIntegerQuery(url: URL, name: string): number | undefined {
  const value = optionalQuery(url, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boolQuery(url: URL, name: string): boolean {
  const value = optionalQuery(url, name);
  return value === "1" || value === "true";
}

