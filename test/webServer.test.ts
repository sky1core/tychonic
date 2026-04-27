import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRuntimeWorkflowModules,
  runtimeWorkflowModulesDir
} from "../src/temporal/workflowModules.js";
import { startWebServer } from "../src/web/server.js";
import type { WebTemporalClient } from "../src/web/server.js";
import type { TychonicWorkflowResult } from "../src/cli/temporalResultViews.js";

let server: Server | undefined;
const describeWithLoopback = (await canBindLoopback()) ? describe : describe.skip;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

describeWithLoopback("startWebServer", () => {
  it("serves health and Temporal-backed run state endpoints", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-web-"));
    const webClientRoot = await createWebClientFixture(cwd);
    const started = await startWebServer({
      cwd,
      port: 0,
      webClientRoot,
      temporalClient: {
        listWorkflows: async () => ({
          address: "127.0.0.1:7233",
          namespace: "default",
          taskQueue: "tychonic",
          workflows: [
            {
              workflowId: "tychonic_fix_loop_web",
              runId: "temporal-run",
              type: "fixLoopWorkflow",
              taskQueue: "tychonic",
              status: "COMPLETED",
              historyLength: 12,
              startTime: "2026-04-19T00:00:00.000Z"
            }
          ]
        }),
        describeWorkflow: async () => ({
          workflowId: "tychonic_fix_loop_web",
          runId: "temporal-run",
          type: "fixLoopWorkflow",
          taskQueue: "tychonic",
          status: "COMPLETED",
          historyLength: 12,
          startTime: "2026-04-19T00:00:00.000Z",
          pendingActivities: [],
          result: fakeResult(cwd)
        }),
        signalInboxContinuation: async () => ({ workflowId: "unused", signaled: true }),
        signalInboxDismiss: async () => ({ workflowId: "unused", signaled: true }),
        signalSessionRegistration: async () => ({ workflowId: "unused", signaled: true }),
        signalSessionResume: async () => ({ workflowId: "unused", signaled: true })
      }
    });
    server = started.server;

    await expect(fetchJSON(`${started.url}/health`)).resolves.toMatchObject({ ok: true });
    const operatorSurface = await fetchText(`${started.url}/`);
    expect(operatorSurface).toContain("Tychonic");
    expect(operatorSurface).toContain('id="root"');
    expect(operatorSurface).toContain("/assets/app.js");
    await expect(fetchText(`${started.url}/assets/app.js`)).resolves.toContain("test client");
    await expect(fetchText(`${started.url}/design-compare.html`)).resolves.toContain("visual compare");
    await expect(fetchText(`${started.url}/screenshots/current/phone.png`)).resolves.toBe("png fixture");
    await expect(fetchJSON(`${started.url}/package.json`, 404)).resolves.toMatchObject({
      ok: false,
      error: "asset not found"
    });
    await expect(fetchJSON(`${started.url}/src/web/server.ts`, 404)).resolves.toMatchObject({
      ok: false,
      error: "asset not found"
    });
    await expect(fetchStatus(`${started.url}/favicon.ico`)).resolves.toBe(204);
    await expect(fetchJSON(`${started.url}/runs`)).resolves.toMatchObject({
      ok: true,
      mode: "temporal",
      workflows: [{ workflowId: "tychonic_fix_loop_web" }]
    });
    await expect(fetchJSON(`${started.url}/runs/tychonic_fix_loop_web?result=1`)).resolves.toMatchObject({
      ok: true,
      workflow: { result: { runId: "run_web", status: "waiting_user" } }
    });
    await expect(fetchJSON(`${started.url}/inbox?workflow_id=tychonic_fix_loop_web`)).resolves.toMatchObject({
      ok: true,
      inbox: [{ id: "inbox_1" }]
    });
    await expect(fetchJSON(`${started.url}/sessions?workflow_id=tychonic_fix_loop_web`)).resolves.toMatchObject({
      ok: true,
      sessions: [{ id: "session_web" }]
    });
    await expect(fetchJSON(`${started.url}/artifact?workflow_id=tychonic_fix_loop_web`)).resolves.toMatchObject({
      ok: true,
      artifacts: [{ id: "artifact_web", kind: "worker_output" }]
    });
    await expect(fetchJSON(`${started.url}/log?workflow_id=tychonic_fix_loop_web`)).resolves.toMatchObject({
      ok: true,
      attempts: [{ id: "attempt_web", kind: "work" }]
    });
  });

  it("returns a build-required error instead of serving an alternate operator surface when client assets are missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-web-missing-client-"));
    const started = await startWebServer({
      cwd,
      port: 0,
      webClientRoot: join(cwd, "missing-web-client"),
      temporalClient: fakeTemporalClient(cwd)
    });
    server = started.server;

    await expect(fetchJSON(`${started.url}/`, 503)).resolves.toMatchObject({
      ok: false,
      error: "web client is not built",
      remediation: "run npm run build"
    });
    await expect(fetchJSON(`${started.url}/assets/app.js`, 404)).resolves.toMatchObject({
      ok: false,
      error: "asset not found"
    });
  });

  it("refuses non-loopback binds in the core web server unless explicitly allowed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-web-bind-"));
    await expect(
      startWebServer({
        cwd,
        host: "0.0.0.0",
        port: 0,
        temporalClient: fakeTemporalClient(cwd)
      })
    ).rejects.toThrow(/refusing to bind Tychonic web API to non-loopback host/);
  });

  it("serves the installed workflow bundle registry through /workflows", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-web-catalog-"));

    const started = await startWebServer({
      cwd,
      port: 0,
      temporalClient: {
        listWorkflows: async () => ({
          address: "127.0.0.1:7233",
          namespace: "default",
          taskQueue: "tychonic",
          workflows: []
        }),
        describeWorkflow: async () => ({
          workflowId: "unused",
          runId: "unused-run",
          type: "fixLoopWorkflow",
          taskQueue: "tychonic",
          status: "RUNNING",
          historyLength: 0,
          startTime: "2026-04-19T00:00:00.000Z",
          pendingActivities: []
        }),
        signalInboxContinuation: async () => ({ workflowId: "unused", signaled: true }),
        signalInboxDismiss: async () => ({ workflowId: "unused", signaled: true }),
        signalSessionRegistration: async () => ({ workflowId: "unused", signaled: true }),
        signalSessionResume: async () => ({ workflowId: "unused", signaled: true })
      }
    });
    server = started.server;

    const expectedModules = await listRuntimeWorkflowModules();
    await expect(fetchJSON(`${started.url}/workflows`)).resolves.toEqual({
      ok: true,
      directory: runtimeWorkflowModulesDir(),
      modules: expectedModules
    });
  });

});

async function fetchJSON(url: string, expectedStatus = 200, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: init?.headers ?? (init?.body ? { "content-type": "application/json" } : undefined)
  });
  expect(response.status).toBe(expectedStatus);
  return await response.json();
}

async function fetchJSONWithHost(
  urlText: string,
  host: string,
  expectedStatus: number,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<unknown> {
  const url = new URL(urlText);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: { ...init.headers, host }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          try {
            expect(response.statusCode).toBe(expectedStatus);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    if (init.body) {
      request.end(init.body);
    } else {
      request.end();
    }
  });
}

async function fetchText(url: string, expectedStatus = 200): Promise<string> {
  const response = await fetch(url);
  expect(response.status).toBe(expectedStatus);
  return await response.text();
}

async function fetchStatus(url: string): Promise<number> {
  const response = await fetch(url);
  return response.status;
}

async function canBindLoopback(): Promise<boolean> {
  const probe = createHttpServer((_, response) => response.end("ok"));
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        probe.off("error", reject);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
    return true;
  } catch {
    probe.close();
    return false;
  }
}

function fakeResult(cwd: string): TychonicWorkflowResult {
  return {
    runId: "run_web",
    status: "waiting_user",
    artifactRoot: join(cwd, ".tychonic", "runs", "run_web"),
    worktreePath: join(cwd, ".tychonic", "worktrees", "run_web"),
    run: {
      schema_version: "tychonic.run.v1",
      id: "run_web",
      template: "simple_workflow",
      status: "waiting_user",
      goal: "inspect web result",
      cwd,
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:01.000Z",
      states: [
        {
          id: "state_web",
          name: "work",
          status: "succeeded",
          reason: "ok",
          activity_attempt_ids: ["attempt_web", "attempt_reset"],
          artifact_ids: ["artifact_web"],
          finding_ids: [],
          started_at: "2026-04-19T00:00:00.000Z",
          finished_at: "2026-04-19T00:00:01.000Z"
        }
      ],
      activity_attempts: [
        {
          id: "attempt_web",
          state_id: "state_web",
          kind: "work",
          status: "succeeded",
          reason: "ok",
          cwd,
          command: "node worker.js",
          live_output_path: ".tychonic/runs/run_web/live/attempt_web.log",
          agent_session_id: "session_web",
          started_at: "2026-04-19T00:00:00.000Z"
        },
        {
          id: "attempt_reset",
          state_id: "state_web",
          kind: "deterministic_command",
          status: "succeeded",
          reason: "reset",
          cwd,
          exit_code: 0,
          command: "git reset --hard",
          started_at: "2026-04-19T00:00:00.500Z"
        }
      ],
      agent_sessions: [
        {
          id: "session_web",
          agent: "codex",
          role: "worker",
          cwd,
          status: "unknown",
          started_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      artifacts: [
        {
          id: "artifact_web",
          kind: "worker_output",
          path: ".tychonic/runs/run_web/artifacts/worker-output.txt",
          created_at: "2026-04-19T00:00:01.000Z"
        }
      ],
      findings: [],
      inbox: [
        {
          id: "inbox_1",
          status: "open",
          title: "Review finding",
          detail: "Continue work",
          action: { kind: "triage", reason: "test" },
          created_at: "2026-04-19T00:00:01.000Z"
        }
      ]
    }
  };
}

function validProfile(name: string, template: string): string {
  return [
    "version: tychonic.config.v1",
    "states:",
    `  ${name}:`,
    "    type: review",
    `    command: node ${template}.js`,
    ""
  ].join("\n");
}

async function createWebClientFixture(cwd: string): Promise<string> {
  const webClientRoot = join(cwd, "web-client");
  await mkdir(join(webClientRoot, "assets"), { recursive: true });
  await writeFile(
    join(webClientRoot, "index.html"),
    '<!doctype html><html><head><title>Tychonic</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
    "utf8"
  );
  await writeFile(join(webClientRoot, "assets", "app.js"), 'console.log("test client");', "utf8");
  await writeFile(join(webClientRoot, "design-compare.html"), "<!doctype html><title>visual compare</title>", "utf8");
  await mkdir(join(webClientRoot, "screenshots", "current"), { recursive: true });
  await writeFile(join(webClientRoot, "screenshots", "current", "phone.png"), "png fixture", "utf8");
  return webClientRoot;
}

function fakeTemporalClient(cwd: string): WebTemporalClient {
  return {
    listWorkflows: async () => ({
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic",
      workflows: []
    }),
    describeWorkflow: async () => ({
      workflowId: "tychonic_fix_loop_web",
      runId: "temporal-run",
      type: "fixLoopWorkflow",
      taskQueue: "tychonic",
      status: "RUNNING",
      historyLength: 12,
      startTime: "2026-04-19T00:00:00.000Z",
      pendingActivities: [],
      result: fakeResult(cwd)
    })
  };
}
