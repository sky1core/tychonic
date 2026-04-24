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
  signalSimpleWorkflowContinuation,
  signalSimpleWorkflowInboxDismiss,
  signalSimpleWorkflowRegisterSession,
  signalSimpleWorkflowResumeSession,
  type SignalSimpleWorkflowSignalResult,
  type TychonicTemporalWorkflowList,
  type TychonicTemporalWorkflowStatus
} from "../temporal/client.js";
import type { TemporalConfig } from "../temporal/manager.js";
import type { AgentCandidateInput } from "../temporal/types.js";
import type { AgentSessionRecord } from "../domain/types.js";
import { assertLoopbackHost, isLoopbackHost } from "../net/loopback.js";
import { assertNoInlineSecrets } from "../security/inlineSecrets.js";

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
  signalInboxContinuation: (options: {
    workflowId: string;
    runId?: string;
    inboxItemId: string;
    command?: string;
    agent?: string;
    resumeCommand?: string;
    workerCandidates?: AgentCandidateInput[];
    goal?: string;
    verifyCommand: string;
    reviewCommand?: string;
    reviewAgent?: string;
    reviewCandidates?: AgentCandidateInput[];
    commandTimeoutMs?: number;
  }) => Promise<SignalSimpleWorkflowSignalResult>;
  signalInboxDismiss: (options: {
    workflowId: string;
    runId?: string;
    inboxItemId: string;
    reason?: string;
  }) => Promise<SignalSimpleWorkflowSignalResult>;
  signalSessionRegistration: (options: {
    workflowId: string;
    runId?: string;
    id: string;
    agent: string;
    role: AgentSessionRecord["role"];
    cwd: string;
    status?: AgentSessionRecord["status"];
    externalSessionId?: string;
    resumeCommand?: string;
    startedAt: string;
  }) => Promise<SignalSimpleWorkflowSignalResult>;
  signalSessionResume: (options: {
    workflowId: string;
    runId?: string;
    sessionId: string;
    prompt: string;
    verifyCommand: string;
    reviewCommand?: string;
    reviewAgent?: string;
    reviewCandidates?: AgentCandidateInput[];
    commandTimeoutMs?: number;
  }) => Promise<SignalSimpleWorkflowSignalResult>;
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

    if (request.method === "POST" && url.pathname === "/inbox/execute") {
      const body = await readJSONBody(request);
      const verifyCommand = requiredBodyString(body, "verify_command", "verifyCommand");
      assertNoInlineSecrets(verifyCommand, "verify command");
      const result = await temporalClient.signalInboxContinuation({
        workflowId: requiredBodyString(body, "workflow_id", "workflowId"),
        ...optionalRunId(body),
        inboxItemId: requiredBodyString(body, "inbox_item_id", "inboxItemId"),
        ...optionalWorkerFields(body),
        verifyCommand,
        ...optionalReviewFields(body)
      });
      sendJSON(response, 200, { ok: true, mode: "temporal", ...result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/inbox/dismiss") {
      const body = await readJSONBody(request);
      const reason = optionalBodyString(body, "reason");
      const result = await temporalClient.signalInboxDismiss({
        workflowId: requiredBodyString(body, "workflow_id", "workflowId"),
        ...optionalRunId(body),
        inboxItemId: requiredBodyString(body, "inbox_item_id", "inboxItemId"),
        ...(reason ? { reason } : {})
      });
      sendJSON(response, 200, { ok: true, mode: "temporal", ...result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/sessions/register") {
      const body = await readJSONBody(request);
      const role = optionalBodyString(body, "role") ?? "worker";
      const status = optionalBodyString(body, "status") ?? "unknown";
      const externalSessionId = optionalBodyString(body, "external_session_id", "externalSessionId");
      const resumeCommand = optionalBodyString(body, "resume_command", "resumeCommand");
      assertOptionalInlineSecretFree(resumeCommand, "registered resume command");
      if (!["worker", "reviewer", "verifier"].includes(role)) {
        throw new Error("role must be one of worker, reviewer, verifier");
      }
      if (!["running", "succeeded", "failed", "timed_out", "unknown"].includes(status)) {
        throw new Error("status must be one of running, succeeded, failed, timed_out, unknown");
      }
      const result = await temporalClient.signalSessionRegistration({
        workflowId: requiredBodyString(body, "workflow_id", "workflowId"),
        ...optionalRunId(body),
        id: requiredBodyString(body, "id", "session_id", "sessionId"),
        agent: requiredBodyString(body, "agent"),
        role: role as AgentSessionRecord["role"],
        cwd: requiredBodyString(body, "session_cwd", "sessionCwd", "cwd"),
        status: status as AgentSessionRecord["status"],
        ...(externalSessionId ? { externalSessionId } : {}),
        ...(resumeCommand ? { resumeCommand } : {}),
        startedAt: optionalBodyString(body, "started_at", "startedAt") ?? new Date().toISOString()
      });
      sendJSON(response, 200, { ok: true, mode: "temporal", ...result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/resume") {
      const body = await readJSONBody(request);
      const verifyCommand = requiredBodyString(body, "verify_command", "verifyCommand");
      assertNoInlineSecrets(verifyCommand, "verify command");
      const result = await temporalClient.signalSessionResume({
        workflowId: requiredBodyString(body, "workflow_id", "workflowId"),
        ...optionalRunId(body),
        sessionId: requiredBodyString(body, "session_id", "sessionId"),
        prompt: requiredBodyString(body, "prompt"),
        verifyCommand,
        ...optionalReviewFields(body)
      });
      sendJSON(response, 200, { ok: true, mode: "temporal", ...result });
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
      }),
    signalInboxContinuation: (options) =>
      signalSimpleWorkflowContinuation({
        ...config,
        ...options
      }),
    signalInboxDismiss: (options) =>
      signalSimpleWorkflowInboxDismiss({
        ...config,
        ...options
      }),
    signalSessionRegistration: (options) =>
      signalSimpleWorkflowRegisterSession({
        ...config,
        ...options
      }),
    signalSessionResume: (options) =>
      signalSimpleWorkflowResumeSession({
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

async function readJSONBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function optionalRunId(body: Record<string, unknown>): { runId?: string } {
  const runId = optionalBodyString(body, "run_id", "runId");
  return runId ? { runId } : {};
}

function optionalReviewFields(body: Record<string, unknown>): {
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  commandTimeoutMs?: number;
} {
  const reviewCommand = optionalBodyString(body, "review_command", "reviewCommand");
  const reviewAgent = optionalBodyString(body, "review_agent", "reviewAgent");
  const reviewCandidates = optionalAgentCandidates(body, "review_candidates", "reviewCandidates");
  const commandTimeoutMs = optionalBodyNumber(body, "command_timeout_ms", "commandTimeoutMs");
  assertOptionalInlineSecretFree(reviewCommand, "review command");
  assertAgentCandidatesInlineSecretFree(reviewCandidates, "review candidate");
  assertReviewCandidatesDoNotResume(reviewCandidates);
  return {
    ...(reviewCommand ? { reviewCommand } : {}),
    ...(reviewAgent ? { reviewAgent } : {}),
    ...(reviewCandidates ? { reviewCandidates } : {}),
    ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {})
  };
}

function optionalWorkerFields(body: Record<string, unknown>): {
  command?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  goal?: string;
} {
  const command = optionalBodyString(body, "command");
  const agent = optionalBodyString(body, "agent");
  const resumeCommand = optionalBodyString(body, "resume_command", "resumeCommand");
  const workerCandidates = optionalAgentCandidates(body, "worker_candidates", "workerCandidates");
  const goal = optionalBodyString(body, "goal");
  assertOptionalInlineSecretFree(command, "worker command");
  assertOptionalInlineSecretFree(resumeCommand, "worker resume command");
  assertAgentCandidatesInlineSecretFree(workerCandidates, "worker candidate");
  return {
    ...(command ? { command } : {}),
    ...(agent ? { agent } : {}),
    ...(resumeCommand ? { resumeCommand } : {}),
    ...(workerCandidates ? { workerCandidates } : {}),
    ...(goal ? { goal } : {})
  };
}

function optionalAgentCandidates(body: Record<string, unknown>, ...names: string[]): AgentCandidateInput[] | undefined {
  for (const name of names) {
    const value = body[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(`${name} must be an array`);
    }
    return value.map((item, index) => agentCandidateFromBody(item, `${name}[${index}]`));
  }
  return undefined;
}

function agentCandidateFromBody(value: unknown, name: string): AgentCandidateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const body = value as Record<string, unknown>;
  const agent = requiredBodyString(body, "agent");
  const command = optionalBodyString(body, "command");
  const resumeCommand = optionalBodyString(body, "resume_command", "resumeCommand");
  assertOptionalInlineSecretFree(command, `${name} command`);
  assertOptionalInlineSecretFree(resumeCommand, `${name} resume command`);
  return {
    agent,
    ...(command ? { command } : {}),
    ...(resumeCommand ? { resumeCommand } : {})
  };
}

function assertOptionalInlineSecretFree(command: string | undefined, label: string): void {
  if (command) {
    assertNoInlineSecrets(command, label);
  }
}

function assertAgentCandidatesInlineSecretFree(candidates: AgentCandidateInput[] | undefined, label: string): void {
  for (const candidate of candidates ?? []) {
    assertOptionalInlineSecretFree(candidate.command, `${label} ${candidate.agent} command`);
    assertOptionalInlineSecretFree(candidate.resumeCommand, `${label} ${candidate.agent} resume command`);
  }
}

function assertReviewCandidatesDoNotResume(candidates: AgentCandidateInput[] | undefined): void {
  for (const candidate of candidates ?? []) {
    if (candidate.resumeCommand) {
      throw new Error(`review candidate ${candidate.agent} must not set resumeCommand`);
    }
  }
}

function requiredBodyString(body: Record<string, unknown>, ...names: string[]): string {
  const value = optionalBodyString(body, ...names);
  if (!value) {
    throw new Error(`missing required body field: ${names[0]}`);
  }
  return value;
}

function optionalBodyString(body: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = body[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} must be a non-empty string`);
    }
    return value;
  }
  return undefined;
}

function optionalBodyBoolean(body: Record<string, unknown>, ...names: string[]): boolean | undefined {
  for (const name of names) {
    const value = body[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "boolean") {
      throw new Error(`${name} must be a boolean`);
    }
    return value;
  }
  return undefined;
}

function optionalBodyNumber(body: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = body[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number`);
    }
    return value;
  }
  return undefined;
}
