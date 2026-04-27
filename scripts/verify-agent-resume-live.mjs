import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_AGENT_NAMES,
  getAgentAdapter,
  AdapterUnsupported
} from "../dist/adapters/index.js";

const DEFAULT_RESUME_AGENT_NAMES = ["claude", "codex", "kiro"];

const requestedAgents = (process.env.TYCHONIC_LIVE_AGENTS ?? DEFAULT_RESUME_AGENT_NAMES.join(","))
  .split(",")
  .map((agent) => agent.trim())
  .filter(Boolean);
const supportedAgents = new Set(BUILTIN_AGENT_NAMES);
const rootTmp = await mkdtemp(join(tmpdir(), "tychonic-agent-live-"));
const results = [];

try {
  if (requestedAgents.length === 0) {
    throw new Error("no live agents selected");
  }
  for (const agent of requestedAgents) {
    if (!supportedAgents.has(agent)) {
      throw new Error(`unsupported live agent: ${agent}`);
    }
    results.push(await probeAgent(agent));
  }
  const ok = results.every((result) =>
    result.status === "resumed" || result.status === "resume_unsupported"
  );
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  if (process.env.TYCHONIC_KEEP_LIVE_AGENT_TMP !== "1") {
    await rm(rootTmp, { recursive: true, force: true });
  }
}

async function probeAgent(agentName) {
  const adapter = getAgentAdapter(agentName);
  const resumeSupport = probeResumeSupport(adapter, agentName);
  if (resumeSupport.status === "resume_unsupported") {
    return resumeSupport;
  }

  const cwd = await makeRepo(agentName);
  const prompt = `Do not modify files. Reply briefly with TYCHONIC-${agentName.toUpperCase()}-ONE.`;
  const baseInput = {
    prompt,
    worktreeCwd: cwd,
    role: "work",
    sandbox: "read-only",
    approval: "never",
    permissionMode: "plan",
    trustAllTools: false
  };

  const fresh = adapter.runNew(baseInput);
  const freshResult = await runShell(fresh.command, cwd, prompt);
  const parsed = adapter.parseResult(freshResult.stdout, freshResult.stderr, freshResult.exitCode);
  const sessionId = parsed.sessionId;

  if (!sessionId) {
    return {
      agent: agentName,
      status: "non_resumable",
      reason: "adapter did not produce a session id usable for built-in resume"
    };
  }

  let resumeCommand;
  try {
    resumeCommand = adapter.runResume({
      ...baseInput,
      prompt: `Do not modify files. Reply briefly with TYCHONIC-${agentName.toUpperCase()}-TWO.`,
      sessionId
    });
  } catch (error) {
    if (error instanceof AdapterUnsupported) {
      return {
        agent: agentName,
        status: "resume_unsupported",
        sessionId,
        reason: error.message
      };
    }
    throw error;
  }

  const resumeResult = await runShell(
    resumeCommand.command,
    cwd,
    `Do not modify files. Reply briefly with TYCHONIC-${agentName.toUpperCase()}-TWO.`
  );

  return {
    agent: agentName,
    status: "resumed",
    sessionId,
    freshExitCode: freshResult.exitCode,
    resumeExitCode: resumeResult.exitCode
  };
}

function probeResumeSupport(adapter, agentName) {
  try {
    adapter.runResume({
      prompt: "",
      worktreeCwd: rootTmp,
      role: "work",
      sandbox: "read-only",
      approval: "never",
      permissionMode: "plan",
      trustAllTools: false,
      sessionId: "tychonic-live-resume-support-probe"
    });
    return { status: "resume_supported" };
  } catch (error) {
    if (error instanceof AdapterUnsupported) {
      return {
        agent: agentName,
        status: "resume_unsupported",
        reason: error.message
      };
    }
    throw error;
  }
}

async function runShell(command, cwd, stdin) {
  return await new Promise((resolve, reject) => {
    const timeoutMs = Number(process.env.TYCHONIC_LIVE_AGENT_TIMEOUT_MS ?? 180_000);
    const maxBuffer = 10 * 1024 * 1024;
    const child = spawn("sh", ["-lc", command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `live agent command timed out: ${JSON.stringify({ command, timeoutMs, stdoutTail: tail(stdout), stderrTail: tail(stderr) })}`
        )
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        child.kill("SIGTERM");
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : 1;
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      reject(
        new Error(
          `live agent command failed: ${JSON.stringify({ command, exitCode, stdoutTail: tail(stdout), stderrTail: tail(stderr) })}`
        )
      );
    });
    child.stdin.end(stdin);
  });
}

async function makeRepo(agent) {
  const cwd = await mkdtemp(join(rootTmp, `${agent}-`));
  await runFile("git", ["init"], cwd);
  await runFile("git", ["config", "user.name", "Tychonic Live Probe"], cwd);
  await runFile("git", ["config", "user.email", "tychonic-live@example.invalid"], cwd);
  await writeFile(join(cwd, "README.md"), `Tychonic live ${agent} probe\n`, "utf8");
  await runFile("git", ["add", "README.md"], cwd);
  await runFile("git", ["commit", "-m", "initial"], cwd);
  return cwd;
}

async function runFile(file, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      reject(
        new Error(
          `command failed: ${JSON.stringify({ file, args, exitCode: code, stdoutTail: tail(stdout), stderrTail: tail(stderr) })}`
        )
      );
    });
  });
}

function tail(value) {
  return value.slice(Math.max(0, value.length - 2000));
}
