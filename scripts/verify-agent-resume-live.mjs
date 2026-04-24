import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runDelegate, runDelegateSessionResume } from "../dist/bootstrap/delegateRunner.js";

const execFileAsync = promisify(execFile);
const requestedAgents = (process.env.TYCHONIC_LIVE_AGENTS ?? "codex,claude,gemini,kiro")
  .split(",")
  .map((agent) => agent.trim())
  .filter(Boolean);
const supportedAgents = new Set(["codex", "claude", "gemini", "kiro"]);
const rootTmp = await mkdtemp(join(tmpdir(), "tychonic-agent-live-"));
const results = [];

try {
  for (const agent of requestedAgents) {
    if (!supportedAgents.has(agent)) {
      throw new Error(`unsupported live agent: ${agent}`);
    }
    results.push(await probeAgent(agent));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  if (process.env.TYCHONIC_KEEP_LIVE_AGENT_TMP !== "1") {
    await rm(rootTmp, { recursive: true, force: true });
  }
}

async function probeAgent(agent) {
  await requireExecutable(agent === "kiro" ? "kiro-cli" : agent);
  const cwd = await makeRepo(agent);
  const input = liveInput(agent);
  const result = await runDelegate({
    cwd,
    runId: `live_${agent}_${Date.now()}`,
    goal: `Do not modify files. Reply briefly with TYCHONIC-${agent.toUpperCase()}-ONE.`,
    verifyCommand: "test -f README.md",
    commandTimeoutMs: 180_000,
    now: () => new Date(),
    env: process.env,
    ...input
  });
  const session = result.run.agent_sessions.find((candidate) => candidate.role === "worker");
  if (!session?.external_session_id || !session.resume_command) {
    throw new Error(`${agent}: worker session was not resumable: ${JSON.stringify(session)}`);
  }

  const resumed = await runDelegateSessionResume({
    cwd,
    run: result.run,
    worktreePath: result.worktreePath,
    sessionId: session.id,
    prompt: `Do not modify files. Reply briefly with TYCHONIC-${agent.toUpperCase()}-TWO.`,
    verifyCommand: "test -f README.md",
    commandTimeoutMs: 180_000,
    now: () => new Date(),
    env: process.env
  });
  const resumeAttempts = resumed.run.activity_attempts.filter((attempt) => attempt.type === "resume_work");
  if (resumed.run.status !== "succeeded" || resumeAttempts.length < 1) {
    throw new Error(`${agent}: resume did not complete: ${JSON.stringify({ status: resumed.run.status, resumeAttempts })}`);
  }

  return {
    agent,
    status: resumed.run.status,
    externalSessionId: session.external_session_id,
    resumeAttempts: resumeAttempts.length
  };
}

function liveInput(agent) {
  if (agent === "codex") {
    return {
      codex: true,
      codexSettings: {
        model: process.env.TYCHONIC_CODEX_LIVE_MODEL ?? "gpt-5.4",
        reasoningEffort: process.env.TYCHONIC_CODEX_LIVE_EFFORT ?? "low",
        sandbox: "read-only",
        approval: "never"
      }
    };
  }
  if (agent === "claude") {
    const model = process.env.TYCHONIC_CLAUDE_LIVE_MODEL ?? "sonnet";
    const effort = process.env.TYCHONIC_CLAUDE_LIVE_EFFORT ?? "low";
    return {
      command: `claude --print --output-format stream-json --verbose --model ${shellQuote(model)} --effort ${shellQuote(effort)} --permission-mode plan`,
      agent: "claude"
    };
  }
  if (agent === "gemini") {
    return {
      command: 'prompt=$(cat); gemini --prompt "$prompt" --output-format json --approval-mode plan',
      agent: "gemini"
    };
  }
  return {
    command: 'prompt=$(cat); kiro-cli chat --no-interactive "$prompt"',
    agent: "kiro"
  };
}

async function makeRepo(agent) {
  const cwd = await mkdtemp(join(rootTmp, `${agent}-`));
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Tychonic Live Probe"], { cwd });
  await execFileAsync("git", ["config", "user.email", "tychonic-live@example.invalid"], { cwd });
  await writeFile(join(cwd, "README.md"), `Tychonic live ${agent} probe\n`, "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}

async function requireExecutable(name) {
  try {
    await execFileAsync(name, ["--version"], { encoding: "utf8", timeout: 30_000 });
  } catch (error) {
    throw new Error(`${name} executable is required for live agent resume verification`, { cause: error });
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
