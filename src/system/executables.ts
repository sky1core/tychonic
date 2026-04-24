import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const TYCHONIC_AGENT_PATH_ENV = "TYCHONIC_AGENT_PATH";

export function buildExecutableSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const userHome = normalizePathEntry(env.HOME) ?? homedir();
  const candidates = [
    ...splitPathEntries(env[TYCHONIC_AGENT_PATH_ENV]),
    ...splitPathEntries(env.PATH),
    `${userHome}/.local/bin`,
    `${userHome}/.npm-global/bin`,
    `${userHome}/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ];
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const entry = normalizePathEntry(candidate, userHome);
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

async function isExecutable(path: string): Promise<boolean> {
  try {
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

function normalizePathEntry(value: unknown, home = homedir()): string | undefined {
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
    return join(home, trimmed.slice(2));
  }
  return trimmed;
}
