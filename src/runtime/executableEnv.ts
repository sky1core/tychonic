import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { BUILTIN_AGENT_NAMES, getAgentAdapter } from "../adapters/index.js";
import { assertAgentExecutablesAvailable } from "../adapters/executablePreflight.js";
import type { TychonicConfig } from "../catalog/types.js";
import {
  buildExecutablePathValue,
  buildExecutableSearchPath,
  findExecutable,
  resolveGitExecutable,
  TYCHONIC_AGENT_PATH_ENV,
  validateExecutablePath
} from "../bootstrap/executables.js";
import { inspectBundle, listRuntimeWorkflowModules, type InstalledWorkflowModule } from "../temporal/workflowModules.js";
import { tychonicRuntimeDirs } from "../temporal/manager.js";

export const RUNTIME_EXECUTABLE_ENV_SCHEMA_VERSION = "tychonic.runtimeExecutables.v1";
const LEGACY_EXECUTABLE_PATH_ENV_NAMES = [
  "TYCHONIC_OPENP_PATH",
  "TYCHONIC_KIRO_CLI_PATH",
  "TYCHONIC_GIT_PATH"
] as const;

export interface RuntimeExecutableEnvRecord {
  schema_version: typeof RUNTIME_EXECUTABLE_ENV_SCHEMA_VERSION;
  generated_at: string;
  env: Record<string, string>;
}

export interface RequiredRuntimeProfile {
  name: string;
  profile: TychonicConfig;
}

export async function prepareRuntimeExecutableEnv(options: {
  env?: NodeJS.ProcessEnv;
  requiredProfiles?: readonly RequiredRuntimeProfile[];
  persist?: boolean;
} = {}): Promise<Record<string, string>> {
  const resolveOptions: {
    env?: NodeJS.ProcessEnv;
    requiredProfiles?: readonly RequiredRuntimeProfile[];
  } = {
    requiredProfiles: options.requiredProfiles ?? (await loadInstalledWorkflowRequiredProfiles())
  };
  if (options.env !== undefined) {
    resolveOptions.env = options.env;
  }
  const runtimeEnv = await resolveRuntimeExecutableEnv(resolveOptions);
  if (options.persist ?? true) {
    await writeRuntimeExecutableEnv(runtimeEnv);
  }
  return runtimeEnv;
}

export async function resolveRuntimeExecutableEnv(options: {
  env?: NodeJS.ProcessEnv;
  requiredProfiles?: readonly RequiredRuntimeProfile[];
} = {}): Promise<Record<string, string>> {
  const baseEnv = withoutLegacyExecutablePathEnv(options.env ?? process.env);
  const runtimeEnv: Record<string, string> = {};
  const gitPath = await resolveGitExecutable(baseEnv);
  const executablePaths: Record<string, string> = {};

  for (const executable of allBuiltInExecutableNames()) {
    const resolved = await findOptionalExecutable(executable, baseEnv);
    if (!resolved) continue;
    executablePaths[executable] = await validateExecutablePath(resolved, executable);
  }

  runtimeEnv.PATH = runtimePathValue(baseEnv, executablePaths, gitPath);
  const validationEnv = mergeRuntimeExecutableEnv(baseEnv, runtimeEnv);
  for (const entry of options.requiredProfiles ?? []) {
    await assertAgentExecutablesAvailable(entry.profile, {
      env: validationEnv,
      context: `runtime workflow ${entry.name}`
    });
  }
  return runtimeEnv;
}

export function mergeRuntimeExecutableEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  runtimeEnv: Record<string, string>
): NodeJS.ProcessEnv {
  return { ...withoutLegacyExecutablePathEnv(baseEnv), ...sanitizedRuntimeEnv(runtimeEnv) };
}

export function applyRuntimeExecutableEnv(runtimeEnv: Record<string, string>): void {
  for (const key of LEGACY_EXECUTABLE_PATH_ENV_NAMES) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(sanitizedRuntimeEnv(runtimeEnv))) {
    process.env[key] = value;
  }
}

export async function loadRuntimeExecutableEnv(): Promise<Record<string, string> | undefined> {
  let raw;
  try {
    raw = await readFile(runtimeExecutableEnvPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as RuntimeExecutableEnvRecord;
  if (parsed.schema_version !== RUNTIME_EXECUTABLE_ENV_SCHEMA_VERSION) {
    throw new Error(`unsupported runtime executable env schema: ${String(parsed.schema_version)}`);
  }
  return parsed.env;
}

export async function applyPersistedRuntimeExecutableEnv(): Promise<boolean> {
  const runtimeEnv = await loadRuntimeExecutableEnv();
  if (!runtimeEnv) return false;
  const resolvedRuntimeEnv = await resolveRuntimeExecutableEnv({
    env: mergeRuntimeExecutableEnv(process.env, runtimeEnv),
    requiredProfiles: await loadInstalledWorkflowRequiredProfiles()
  });
  await writeRuntimeExecutableEnv(resolvedRuntimeEnv);
  applyRuntimeExecutableEnv(resolvedRuntimeEnv);
  return true;
}

export async function writeRuntimeExecutableEnv(env: Record<string, string>): Promise<string> {
  const path = runtimeExecutableEnvPath();
  await mkdir(dirname(path), { recursive: true });
  const record: RuntimeExecutableEnvRecord = {
    schema_version: RUNTIME_EXECUTABLE_ENV_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    env: sanitizedRuntimeEnv(env)
  };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

export function runtimeExecutableEnvPath(): string {
  return join(tychonicRuntimeDirs().stateDir, "runtime-executables.json");
}

export async function requiredProfilesFromBundles(
  bundles: readonly InstalledWorkflowModule[]
): Promise<RequiredRuntimeProfile[]> {
  const profiles: RequiredRuntimeProfile[] = [];
  for (const bundle of bundles) {
    const inspection = await inspectBundle(bundle);
    profiles.push({ name: bundle.name, profile: inspection.defaultProfile });
  }
  return profiles;
}

async function loadInstalledWorkflowRequiredProfiles(): Promise<RequiredRuntimeProfile[]> {
  return await requiredProfilesFromBundles(await listRuntimeWorkflowModules());
}

function allBuiltInExecutableNames(): string[] {
  const names = new Set<string>();
  for (const agent of BUILTIN_AGENT_NAMES) {
    for (const executable of getAgentAdapter(agent).executables) {
      names.add(executable);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

async function findOptionalExecutable(
  executable: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  try {
    return await findExecutable(executable, env);
  } catch {
    return undefined;
  }
}

function runtimePathValue(
  baseEnv: NodeJS.ProcessEnv,
  executablePaths: Record<string, string>,
  gitPath: string
): string {
  const executableDirs = [
    ...discoveredExecutableDirsInSearchOrder(baseEnv, executablePaths),
    dirname(gitPath),
    "/usr/bin",
    "/bin"
  ];
  return buildExecutablePathValue({
    ...(baseEnv.HOME ? { HOME: baseEnv.HOME } : {}),
    ...(baseEnv[TYCHONIC_AGENT_PATH_ENV] ? { [TYCHONIC_AGENT_PATH_ENV]: baseEnv[TYCHONIC_AGENT_PATH_ENV] } : {}),
    PATH: executableDirs.join(delimiter)
  });
}

function discoveredExecutableDirsInSearchOrder(
  baseEnv: NodeJS.ProcessEnv,
  executablePaths: Record<string, string>
): string[] {
  const requiredDirs = new Set(Object.values(executablePaths).map((value) => dirname(value)));
  const orderedDirs: string[] = [];
  for (const entry of buildExecutableSearchPath(baseEnv)) {
    if (requiredDirs.delete(entry)) {
      orderedDirs.push(entry);
    }
  }
  return [...orderedDirs, ...requiredDirs];
}

function withoutLegacyExecutablePathEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const key of LEGACY_EXECUTABLE_PATH_ENV_NAMES) {
    delete cleaned[key];
  }
  return cleaned;
}

function sanitizedRuntimeEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const legacy = new Set<string>(LEGACY_EXECUTABLE_PATH_ENV_NAMES);
  for (const [key, value] of Object.entries(env)) {
    if (!legacy.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
