import { buildExecutableSearchPath, findExecutable } from "../bootstrap/executables.js";
import type { ActivityBlock, TychonicConfig } from "../catalog/types.js";
import { getAgentAdapter, isBuiltInAgentName, type BuiltInAgentName } from "./index.js";
export { AGENT_EXECUTABLE_MISSING_FAILURE_TYPE } from "./failureTypes.js";

export interface AgentExecutableRequirement {
  stateName: string;
  agent: BuiltInAgentName;
  executable: string;
  role: "primary" | "normalizer";
}

export interface MissingAgentExecutable extends AgentExecutableRequirement {
  searchPath: string[];
  lookupError?: string;
}

export interface AgentExecutableCheckResult {
  requirements: AgentExecutableRequirement[];
  resolved: Array<AgentExecutableRequirement & { path: string }>;
  missing: MissingAgentExecutable[];
}

export interface AgentExecutableCheckOptions {
  env?: NodeJS.ProcessEnv;
  lookup?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

export async function checkAgentExecutables(
  profile: TychonicConfig | undefined,
  options: AgentExecutableCheckOptions = {}
): Promise<AgentExecutableCheckResult> {
  const env = options.env ?? process.env;
  const lookup = options.lookup ?? findExecutable;
  const requirements = requiredAgentExecutables(profile);
  const resolved: AgentExecutableCheckResult["resolved"] = [];
  const missing: MissingAgentExecutable[] = [];
  const cache = new Map<string, { path: string | undefined; lookupError: string | undefined }>();
  const searchPath = buildExecutableSearchPath(env);

  for (const requirement of requirements) {
    let lookupResult = cache.get(requirement.executable);
    if (!cache.has(requirement.executable)) {
      lookupResult = await executableLookupResult(requirement.executable, env, lookup);
      cache.set(requirement.executable, lookupResult);
    }
    const path = lookupResult?.path;
    if (path) {
      resolved.push({ ...requirement, path });
    } else {
      missing.push({
        ...requirement,
        searchPath,
        ...(lookupResult?.lookupError ? { lookupError: lookupResult.lookupError } : {})
      });
    }
  }

  return { requirements, resolved, missing };
}

export async function assertAgentExecutablesAvailable(
  profile: TychonicConfig | undefined,
  options: AgentExecutableCheckOptions & { context: string }
): Promise<AgentExecutableCheckResult> {
  const result = await checkAgentExecutables(profile, options);
  if (result.missing.length > 0) {
    throw new Error(formatMissingAgentExecutables(options.context, result.missing));
  }
  return result;
}

export function resolvedExecutablePathMap(result: AgentExecutableCheckResult): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const entry of result.resolved) {
    paths[entry.executable] = entry.path;
  }
  return paths;
}

export function formatMissingAgentExecutables(
  context: string,
  missing: readonly MissingAgentExecutable[]
): string {
  const unique = new Map<string, MissingAgentExecutable[]>();
  for (const entry of missing) {
    const entries = unique.get(entry.executable) ?? [];
    entries.push(entry);
    unique.set(entry.executable, entries);
  }
  const details = [...unique.entries()]
    .map(([executable, entries]) => {
      const states = entries
        .map((entry) => `states.${entry.stateName}.${entry.role === "normalizer" ? "normalizer" : "agent"}=${entry.agent}`)
        .join(", ");
      const searchPath = entries[0]?.searchPath.join(":") ?? "";
      const lookupError = entries.find((entry) => entry.lookupError)?.lookupError;
      return `${executable} required by ${states}; searched PATH=${searchPath}${lookupError ? `; reason=${lookupError}` : ""}`;
    })
    .join("; ");
  return `${context}: required agent executable not found. ${details}`;
}

export function requiredAgentExecutables(profile: TychonicConfig | undefined): AgentExecutableRequirement[] {
  const requirements: AgentExecutableRequirement[] = [];
  const seen = new Set<string>();

  for (const [stateName, block] of Object.entries(profile?.states ?? {})) {
    addPrimaryAgentRequirements(requirements, seen, stateName, block);
    addNormalizerRequirements(requirements, seen, stateName, block);
  }

  return requirements;
}

function addPrimaryAgentRequirements(
  requirements: AgentExecutableRequirement[],
  seen: Set<string>,
  stateName: string,
  block: ActivityBlock
): void {
  if (!isBuiltInAgentName(block.agent)) return;
  addAdapterRequirements(requirements, seen, stateName, block.agent, "primary");
}

function addNormalizerRequirements(
  requirements: AgentExecutableRequirement[],
  seen: Set<string>,
  stateName: string,
  block: ActivityBlock
): void {
  if (!isBuiltInAgentName(block.normalizer)) return;
  addAdapterRequirements(requirements, seen, stateName, block.normalizer, "normalizer");
}

function addAdapterRequirements(
  requirements: AgentExecutableRequirement[],
  seen: Set<string>,
  stateName: string,
  agent: BuiltInAgentName,
  role: "primary" | "normalizer"
): void {
  for (const executable of getAgentAdapter(agent).executables) {
    const key = `${stateName}\0${role}\0${agent}\0${executable}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({ stateName, agent, executable, role });
  }
}

async function executableLookupResult(
  executable: string,
  env: NodeJS.ProcessEnv,
  lookup: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>
): Promise<{ path: string | undefined; lookupError: string | undefined }> {
  try {
    return { path: await lookup(executable, env), lookupError: undefined };
  } catch (error) {
    return { path: undefined, lookupError: error instanceof Error ? error.message : String(error) };
  }
}
