import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

export const TYCHONIC_AGENT_PATH_ENV = "TYCHONIC_AGENT_PATH";

const execFileAsync = promisify(execFile);

export function buildExecutableSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    ...splitPathEntries(env[TYCHONIC_AGENT_PATH_ENV]),
    ...splitPathEntries(env.PATH)
  ];
  const entries: string[] = [];
  const seen = new Set<string>();
  const home = normalizeHome(env.HOME);

  for (const candidate of candidates) {
    const entry = normalizePathEntry(candidate, home);
    if (!entry || !entry.startsWith("/") || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    entries.push(entry);
  }

  return entries;
}

export function buildExecutablePathValue(env: NodeJS.ProcessEnv = process.env): string {
  return buildExecutableSearchPath(env).join(delimiter);
}

export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (name.includes("/")) {
    return (await isExecutable(name)) ? name : undefined;
  }

  for (const dir of buildExecutableSearchPath(env)) {
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolveGitExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const resolved = await findExecutable("git", env);
  if (!resolved) {
    throw new Error("git executable was not found");
  }
  return await validateGitExecutablePath(resolved, env);
}

export function gitChildEnv(env: NodeJS.ProcessEnv = process.env, gitPath: string): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: buildExecutablePathValue({
      ...env,
      PATH: [dirname(gitPath), "/usr/bin", "/bin"].join(delimiter)
    })
  };
}

export async function validateExecutablePath(path: string, name: string): Promise<string> {
  if (!path.startsWith("/")) {
    throw new Error(`${name} executable path must be absolute: ${path}`);
  }
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`${name} executable path is not a file: ${path}`);
  }
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`${name} executable is not executable: ${path}`);
  }
  return path;
}

async function validateGitExecutablePath(path: string, env: NodeJS.ProcessEnv): Promise<string> {
  const resolved = await validateExecutablePath(path, "git");
  const { stdout } = await execFileAsync(resolved, ["--version"], {
    env: gitChildEnv(env, resolved),
    maxBuffer: 64 * 1024
  });
  if (!stdout.trim().startsWith("git version ")) {
    throw new Error(`git executable did not report a git version: ${resolved}`);
  }
  return resolved;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPathEntries(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  return value.split(delimiter);
}

function normalizeHome(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.startsWith("/") ? trimmed : undefined;
}

function normalizePathEntry(value: unknown, home: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return home;
  }
  if (trimmed.startsWith("~/")) {
    if (!home) {
      return undefined;
    }
    return join(home, trimmed.slice(2));
  }
  return trimmed;
}
