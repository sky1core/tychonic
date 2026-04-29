/**
 * Kiro built-in adapter (binary `kiro-cli acp`) — PARTIAL: prose review needs a normalizer.
 *
 * This adapter uses Kiro's Agent Client Protocol surface instead of the
 * interactive `kiro-cli chat` wrapper. ACP gives Tychonic a process-owned
 * `sessionId` through `session/new` and a standard `session/load` resume path.
 *
 * Kiro's ACP surface is an agent/server. The wrapper below acts as the minimal client
 * that Tychonic needs for worker sessions: initialize, create/load a session,
 * send one prompt turn, answer filesystem and terminal requests inside the
 * workflow worktree, and expose the ACP session id back to the host.
 * `--model <model>` is included only when the state config declares `model`.
 *
 * Reviewer role can inspect and run checks, but it is non-mutating: direct
 * file writes are rejected and tracked file changes fail the turn. Kiro still
 * needs a host normalizer because it does not provide a Tychonic
 * structured-review contract.
 */

import { productVersion } from "../version.js";
import type {
  AdapterCommand,
  AdapterResumeInput,
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter
} from "./types.js";
import { AdapterUnsupported } from "./types.js";
import { shellQuote } from "./shell.js";

const BIN = "kiro-cli";
const SESSION_EXPORT_START = "__TYCHONIC_KIRO_SESSION_START__";
const SESSION_EXPORT_END = "__TYCHONIC_KIRO_SESSION_END__";

function shouldTrustAllTools(input: AdapterRunInput): boolean {
  if (input.trustAllTools !== undefined) {
    return input.trustAllTools;
  }
  return input.role !== "review";
}

function buildCommand(input: AdapterRunInput, resumeSessionId?: string): string {
  const trustAllTools = shouldTrustAllTools(input) ? "1" : "0";
  return [
    'tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/tychonic-kiro.XXXXXX")',
    'prompt_file="$tmpdir/prompt.txt"',
    'cleanup() { rm -rf -- "$tmpdir"; }',
    "trap cleanup EXIT",
    'cat > "$prompt_file"',
    "status=0",
    [
      "node --input-type=module -",
      '"$prompt_file"',
      shellQuote(resumeSessionId ?? ""),
      shellQuote(trustAllTools),
      shellQuote(productVersion),
      shellQuote(input.model ?? ""),
      shellQuote(input.role),
      "<<'NODE'"
    ].join(" "),
    KIRO_CLIENT_SOURCE,
    "NODE",
    "status=$?",
    'exit "$status"'
  ].join("\n");
}

function extractSessionId(stdout: string): string | undefined {
  const start = stdout.indexOf(SESSION_EXPORT_START);
  if (start < 0) {
    return undefined;
  }
  const jsonStart = start + SESSION_EXPORT_START.length;
  const end = stdout.indexOf(SESSION_EXPORT_END, jsonStart);
  if (end < 0) {
    throw new Error("kiro session export marker start was present without an end marker");
  }
  const jsonText = stdout.slice(jsonStart, end).trim();
  const parsed = JSON.parse(jsonText) as { session_id?: unknown };
  return typeof parsed.session_id === "string" && parsed.session_id.length > 0
    ? parsed.session_id
    : undefined;
}

function unsupportedReviewResume(): AdapterUnsupported {
  return new AdapterUnsupported(
    "kiro",
    "review",
    "kiro-cli acp reviewer resume is unsupported; review states run fresh and use a normalizer"
  );
}

export const kiroAdapter: AgentAdapter = {
  name: "kiro",

  runNew(input: AdapterRunInput): AdapterCommand {
    return { command: buildCommand(input) };
  },

  runResume(input: AdapterResumeInput): AdapterCommand {
    if (input.role === "review") {
      throw unsupportedReviewResume();
    }
    return { command: buildCommand(input, input.sessionId) };
  },

  parseResult(stdout: string, _stderr: string, _exitCode: number): AdapterRunResult {
    const sessionId = extractSessionId(stdout);
    return sessionId === undefined ? {} : { sessionId };
  }
};

const KIRO_CLIENT_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const promptPath = process.argv[2];
const resumeSessionId = process.argv[3] || "";
const trustAllTools = process.argv[4] === "1";
const productVersion = process.argv[5] || "0.0.0";
const model = process.argv[6] || "";
const role = process.argv[7] || "work";
const workspaceRoot = process.cwd();
const promptText = await readFile(promptPath, "utf8");

const child = spawn("kiro-cli", [
  "acp",
  ...(model ? ["--model", model] : []),
  ...(trustAllTools ? ["--trust-all-tools"] : [])
], {
  cwd: workspaceRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

let nextRequestId = 1;
let stdoutBuffer = "";
let closed = false;
let promptTurnActive = false;
const pending = new Map();
const terminals = new Map();
let nextTerminalId = 1;

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  for (;;) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (line.length > 0) {
      void handleLine(line).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        child.stdin.end();
        terminateChild();
        process.exitCode = 1;
      });
    }
  }
});
child.on("close", (code, signal) => {
  closed = true;
  const error = new Error("kiro-cli acp exited before completing pending requests (code=" + code + ", signal=" + signal + ")");
  for (const entry of pending.values()) {
    entry.reject(error);
  }
  pending.clear();
});
child.on("error", (error) => {
  for (const entry of pending.values()) {
    entry.reject(error);
  }
  pending.clear();
});

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: role !== "review" },
      terminal: true
    },
    clientInfo: { name: "tychonic", version: productVersion }
  });

  const reviewTrackedDiffBefore = role === "review"
    ? await trackedDiffSnapshot(workspaceRoot)
    : undefined;
  const sessionId = await openSession(init);
  console.log("");
  console.log("__TYCHONIC_KIRO_SESSION_START__");
  console.log(JSON.stringify({ session_id: sessionId }));
  console.log("__TYCHONIC_KIRO_SESSION_END__");

  const promptResult = await sendPrompt(sessionId);
  const stopReason = promptResult && typeof promptResult === "object" ? promptResult.stopReason : undefined;
  if (stopReason !== undefined && stopReason !== "end_turn") {
    throw new Error("kiro-cli acp ended prompt with stopReason=" + String(stopReason));
  }
  if (reviewTrackedDiffBefore !== undefined) {
    await assertReviewDidNotModifyTrackedFiles(workspaceRoot, reviewTrackedDiffBefore);
  }

  child.stdin.end();
  await waitForChildExitOrTerminate();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  child.stdin.end();
  terminateChild();
  process.exitCode = 1;
}

async function openSession(init) {
  if (resumeSessionId) {
    const canLoad = Boolean(init?.agentCapabilities?.loadSession);
    if (!canLoad) {
      throw new Error("kiro-cli acp did not advertise loadSession support");
    }
    await request("session/load", {
      sessionId: resumeSessionId,
      cwd: workspaceRoot,
      mcpServers: []
    });
    return resumeSessionId;
  }

  const result = await request("session/new", {
    cwd: workspaceRoot,
    mcpServers: []
  });
  const sessionId = result?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("kiro-cli acp session/new did not return a sessionId");
  }
  return sessionId;
}

async function sendPrompt(sessionId) {
  const content = [{ type: "text", text: promptText }];
  promptTurnActive = true;
  try {
    return await request("session/prompt", { sessionId, prompt: content });
  } catch (error) {
    if (!isInvalidParams(error)) {
      throw error;
    }
    return await request("session/prompt", { sessionId, content });
  } finally {
    promptTurnActive = false;
  }
}

function request(method, params) {
  if (closed) {
    return Promise.reject(new Error("kiro-cli acp process is already closed"));
  }
  const id = nextRequestId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method });
    child.stdin.write(JSON.stringify(payload) + "\n");
  });
}

function respond(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error("kiro-cli acp wrote non-JSON stdout: " + line.slice(0, 200));
  }

  if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      entry.reject(toRpcError(entry.method, message.error));
    } else {
      entry.resolve(message.result);
    }
    return;
  }

  if (typeof message.method !== "string") {
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    handleNotification(message.method, message.params);
    return;
  }

  try {
    const result = await handleClientRequest(message.method, message.params ?? {});
    respond(message.id, result);
  } catch (error) {
    respondError(message.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

function handleNotification(method, params) {
  if (
    method === "session/update" ||
    method === "session/notification" ||
    method === "_kiro.dev/session/update"
  ) {
    if (promptTurnActive) {
      printSessionUpdate(params);
    }
    return;
  }
  if (method === "_kiro.dev/metadata") {
    console.log(JSON.stringify({
      type: "kiro_metadata",
      sessionId: params?.sessionId,
      contextUsagePercentage: params?.contextUsagePercentage,
      meteringUsage: params?.meteringUsage,
      turnDurationMs: params?.turnDurationMs
    }));
  }
}

async function handleClientRequest(method, params) {
  switch (method) {
    case "session/request_permission":
      return choosePermission(params);
    case "fs/read_text_file":
      return await readTextFile(params);
    case "fs/write_text_file":
      return await writeTextFileRequest(params);
    case "terminal/create":
      return createTerminal(params);
    case "terminal/output":
      return terminalOutput(params);
    case "terminal/wait_for_exit":
      return await terminalWaitForExit(params);
    case "terminal/kill":
      return terminalKill(params);
    case "terminal/release":
      return terminalRelease(params);
    default:
      throw new Error("unsupported ACP client method " + method);
  }
}

function choosePermission(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const preferredKinds = trustAllTools
    ? ["allow_always", "allow_once"]
    : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const option = options.find((candidate) => candidate?.kind === kind);
    if (option && typeof option.optionId === "string") {
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

async function readTextFile(params) {
  const filePath = workspacePath(params?.path, "path");
  const content = await readFile(filePath, "utf8");
  const line = Number.isInteger(params?.line) ? params.line : undefined;
  const limit = Number.isInteger(params?.limit) ? params.limit : undefined;
  if (line === undefined && limit === undefined) {
    return { content };
  }
  const lines = content.split("\n");
  const start = line === undefined ? 0 : Math.max(0, line - 1);
  const end = limit === undefined ? undefined : start + Math.max(0, limit);
  return { content: lines.slice(start, end).join("\n") };
}

async function writeTextFileRequest(params) {
  if (role === "review") {
    throw new Error("review role may run checks but must not write files");
  }
  const filePath = workspacePath(params?.path, "path");
  if (typeof params?.content !== "string") {
    throw new Error("fs/write_text_file requires string content");
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, params.content, "utf8");
  return null;
}

function createTerminal(params) {
  if (typeof params?.command !== "string" || params.command.length === 0) {
    throw new Error("terminal/create requires command");
  }
  const cwd = params.cwd === undefined ? workspaceRoot : workspacePath(params.cwd, "cwd");
  const args = Array.isArray(params.args)
    ? params.args.map((arg) => {
        if (typeof arg !== "string") throw new Error("terminal/create args must be strings");
        return arg;
      })
    : [];
  const env = { ...process.env };
  if (Array.isArray(params.env)) {
    for (const item of params.env) {
      if (typeof item?.name === "string" && typeof item?.value === "string") {
        env[item.name] = item.value;
      }
    }
  }
  const outputByteLimit = Number.isInteger(params.outputByteLimit)
    ? Math.max(1, params.outputByteLimit)
    : 1_000_000;
  const terminalId = "term_" + nextTerminalId++;
  const childProcess = spawn(params.command, args, {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const terminal = {
    child: childProcess,
    output: "",
    outputByteLimit,
    truncated: false,
    exitStatus: undefined,
    waiters: []
  };
  terminals.set(terminalId, terminal);
  const append = (chunk) => {
    terminal.output += chunk.toString("utf8");
    if (terminal.output.length > terminal.outputByteLimit) {
      terminal.truncated = true;
      terminal.output = terminal.output.slice(-terminal.outputByteLimit);
    }
  };
  childProcess.stdout.on("data", append);
  childProcess.stderr.on("data", append);
  childProcess.on("close", (exitCode, signal) => {
    terminal.exitStatus = { exitCode, signal };
    for (const waiter of terminal.waiters) waiter(terminal.exitStatus);
    terminal.waiters = [];
  });
  childProcess.on("error", (error) => {
    append(Buffer.from(error.message + "\n", "utf8"));
    terminal.exitStatus = { exitCode: null, signal: "error" };
    for (const waiter of terminal.waiters) waiter(terminal.exitStatus);
    terminal.waiters = [];
  });
  return { terminalId };
}

function terminalOutput(params) {
  const terminal = getTerminal(params);
  return {
    output: terminal.output,
    truncated: terminal.truncated,
    ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {})
  };
}

async function terminalWaitForExit(params) {
  const terminal = getTerminal(params);
  if (terminal.exitStatus) {
    return terminal.exitStatus;
  }
  return await new Promise((resolvePromise) => {
    terminal.waiters.push(resolvePromise);
  });
}

function terminalKill(params) {
  const terminal = getTerminal(params);
  if (!terminal.exitStatus) {
    terminal.child.kill("SIGTERM");
  }
  return null;
}

function terminalRelease(params) {
  const terminalId = readTerminalId(params);
  const terminal = terminals.get(terminalId);
  if (!terminal) {
    return null;
  }
  if (!terminal.exitStatus) {
    terminal.child.kill("SIGTERM");
  }
  terminals.delete(terminalId);
  return null;
}

function getTerminal(params) {
  const terminalId = readTerminalId(params);
  const terminal = terminals.get(terminalId);
  if (!terminal) {
    throw new Error("unknown terminalId " + terminalId);
  }
  return terminal;
}

function readTerminalId(params) {
  const terminalId = params?.terminalId;
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    throw new Error("terminal method requires terminalId");
  }
  return terminalId;
}

function workspacePath(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(field + " must be a non-empty path");
  }
  const resolvedPath = isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
  const rel = relative(workspaceRoot, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(field + " is outside the Tychonic worktree: " + value);
  }
  return resolvedPath;
}

async function trackedDiffSnapshot(cwd) {
  const result = await runProcess("git", [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--full-index",
    "--"
  ], cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      "review mutation guard requires a git worktree: " +
      (result.stderr.trim() || "git diff failed")
    );
  }
  return result.stdout;
}

async function assertReviewDidNotModifyTrackedFiles(cwd, before) {
  const after = await trackedDiffSnapshot(cwd);
  if (after !== before) {
    throw new Error("kiro review modified tracked files; review may run checks but must not edit code");
  }
}

function runProcess(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const childProcess = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    childProcess.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    childProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    childProcess.on("close", (exitCode, signal) => {
      resolvePromise({ stdout, stderr, exitCode: exitCode ?? (signal ? 128 : 1) });
    });
    childProcess.on("error", (error) => {
      resolvePromise({ stdout, stderr: error.message, exitCode: 1 });
    });
  });
}

function printSessionUpdate(params) {
  const update = params?.update ?? params;
  const text = textFromUpdate(update);
  if (text) {
    process.stdout.write(text);
    return;
  }
  const sessionUpdate = update?.sessionUpdate ?? update?.type ?? update?.kind;
  if (sessionUpdate === "tool_call" || sessionUpdate === "ToolCall") {
    const title = typeof update?.title === "string" ? update.title : "tool call";
    console.log("\n[kiro] " + title);
    return;
  }
  if (sessionUpdate === "tool_call_update" || sessionUpdate === "ToolCallUpdate") {
    const status = typeof update?.status === "string" ? update.status : "updated";
    console.log("[kiro] tool " + status);
  }
}

function textFromUpdate(update) {
  if (!update || typeof update !== "object") {
    return "";
  }
  return textFromContent(update.content) || textFromContent(update.message) || "";
}

function textFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(textFromContent).join("");
  }
  if (typeof content !== "object") return "";
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (content.type === "content") {
    return textFromContent(content.content);
  }
  if (content.content) {
    return textFromContent(content.content);
  }
  return "";
}

function toRpcError(method, error) {
  const err = new Error("ACP " + method + " failed: " + (error?.message ?? JSON.stringify(error)));
  err.code = error?.code;
  err.data = error?.data;
  return err;
}

function isInvalidParams(error) {
  return error?.code === -32602 || /invalid params|missing.*prompt|missing.*content/i.test(error?.message ?? "");
}

async function waitForChildExitOrTerminate() {
  if (closed) return;
  await new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      terminateChild();
      resolvePromise();
    }, 2_000);
    timeout.unref();
    child.once("close", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

function terminateChild() {
  for (const terminal of terminals.values()) {
    if (!terminal.exitStatus) {
      terminal.child.kill("SIGTERM");
    }
  }
  if (!closed) {
    child.kill("SIGTERM");
  }
}
`;
