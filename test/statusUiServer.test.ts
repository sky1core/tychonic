import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultStatusUiStaticDir,
  handleStatusUiRequest,
  startStatusUiServerWithDeps,
  type StatusUiServerDeps
} from "../src/web/statusUiServer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("status UI server", () => {
  it("points the default static directory at built web assets", () => {
    expect(defaultStatusUiStaticDir()).toMatch(/dist[\\/]web-client$/);
  });

  it("serves local assets and Temporal-backed workflow evidence", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "tychonic-status-ui-"));
    tempDirs.push(staticDir);
    await mkdir(join(staticDir, "assets"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Tychonic</title>");
    await writeFile(join(staticDir, "assets", "font.woff2"), "");

    const now = "2026-05-12T00:00:00.000Z";
    const deps: StatusUiServerDeps = {
      listWorkflows: async () => ({
        address: "127.0.0.1:7233",
        namespace: "default",
        taskQueue: "tychonic",
        workflows: [
          {
            workflowId: "tychonic_simpleWorkflow_test",
            runId: "temporal_run_1",
            type: "simpleWorkflow",
            taskQueue: "tychonic",
            status: "RUNNING",
            startTime: now
          }
        ]
      }),
      describeWorkflow: async () => ({
        workflowId: "tychonic_simpleWorkflow_test",
        runId: "temporal_run_1",
        type: "simpleWorkflow",
        taskQueue: "tychonic",
        status: "RUNNING",
        startTime: now,
        pendingActivities: [],
        result: {
          runId: "run_1",
          status: "succeeded",
          run: {
            schema_version: "tychonic.run.v1",
            id: "run_1",
            template: "simpleWorkflow",
            status: "succeeded",
            cwd: staticDir,
            created_at: now,
            updated_at: now,
            states: [
              {
                id: "state_1",
                name: "verify",
                status: "succeeded",
                reason: "checks passed",
                activity_attempt_ids: [],
                artifact_ids: [],
                finding_ids: [],
                started_at: now,
                finished_at: now
              }
            ],
            activity_attempts: [],
            agent_sessions: [],
            artifacts: [],
            findings: [],
            inbox: []
          }
        }
      })
    };

    await expect(statusUiRequest(staticDir, "/", deps).then((response) => response.body)).resolves.toContain("Tychonic");
    await expect(statusUiRequest(staticDir, "/missing/route", deps).then((response) => response.body)).resolves.toContain("Tychonic");

    const missingAsset = await statusUiRequest(staticDir, "/assets/stale.js", deps);
    expect(missingAsset.status).toBe(404);
    expect(JSON.parse(missingAsset.body)).toMatchObject({ ok: false, error: "status UI asset not found" });
    await expect(statusUiRequest(staticDir, "/assets/font.woff2", deps).then((response) => response.headers["content-type"])).resolves.toBe(
      "font/woff2"
    );

    const list = JSON.parse((await statusUiRequest(staticDir, "/api/workflows", deps)).body);
    expect(list).toMatchObject({
      ok: true,
      workflows: [{ workflowId: "tychonic_simpleWorkflow_test", type: "simpleWorkflow" }]
    });

    const rebound = await statusUiRequest(staticDir, "/api/workflows", deps, "attacker.example");
    expect(rebound.status).toBe(403);

    const detail = JSON.parse((await statusUiRequest(staticDir, "/api/workflows/tychonic_simpleWorkflow_test", deps)).body);
    expect(detail).toMatchObject({
      ok: true,
      workflow: {
        workflowId: "tychonic_simpleWorkflow_test",
        runId: "temporal_run_1",
        type: "simpleWorkflow",
        status: "RUNNING"
      },
      evidence: {
        runId: "run_1",
        template: "simpleWorkflow",
        status: "succeeded",
        latest_state: { name: "verify", status: "succeeded" },
        counts: { states: 1, attempts: 0 }
      }
    });
    expect(detail.workflow.result).toBeUndefined();
  });

  it("rejects non-loopback bind hosts", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "tychonic-status-ui-"));
    tempDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Tychonic</title>");

    await expect(
      startStatusUiServerWithDeps(
        { uiHost: "0.0.0.0", uiPort: 0, staticDir },
        {
          listWorkflows: async () => ({
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "tychonic",
            workflows: []
          }),
          describeWorkflow: async () => {
            throw new Error("not used");
          }
        }
      )
    ).rejects.toThrow("loopback");
  });

  it("rejects localhost bind hosts instead of trusting name resolution", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "tychonic-status-ui-"));
    tempDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Tychonic</title>");

    await expect(
      startStatusUiServerWithDeps(
        { uiHost: "localhost", uiPort: 0, staticDir },
        {
          listWorkflows: async () => ({
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "tychonic",
            workflows: []
          }),
          describeWorkflow: async () => {
            throw new Error("not used");
          }
        }
      )
    ).rejects.toThrow("loopback");
  });

  it("fails before listening when status UI assets are missing", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "tychonic-status-ui-missing-"));
    tempDirs.push(staticDir);

    await expect(
      startStatusUiServerWithDeps(
        { uiPort: 0, staticDir },
        {
          listWorkflows: async () => ({
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "tychonic",
            workflows: []
          }),
          describeWorkflow: async () => {
            throw new Error("not used");
          }
        }
      )
    ).rejects.toThrow("status UI assets not found");
  });
});

async function statusUiRequest(
  staticDir: string,
  url: string,
  deps: StatusUiServerDeps,
  host = "127.0.0.1"
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let status = 200;
  const headers: Record<string, string> = {};
  let body = "";
  const response = {
    writeHead(code: number, nextHeaders: Record<string, string>) {
      status = code;
      Object.assign(headers, nextHeaders);
      return response;
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
      return response;
    }
  };
  await handleStatusUiRequest({
    request: { method: "GET", url, headers: { host } } as never,
    response: response as never,
    staticDir,
    temporalConfig: {},
    deps
  });
  return { status, headers, body };
}
