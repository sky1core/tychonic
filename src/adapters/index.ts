/**
 * Built-in agent adapter registry.
 *
 * Centralises the four shipped adapters behind a typed lookup. The
 * `agent` field on a state config block is matched against
 * `BUILTIN_AGENT_NAMES` — non-built-in names remain free-form labels and
 * follow the explicit-`command` path unchanged.
 *
 * Step 1 (this file) only exports the registry. Step 2 will plumb it
 * into `runWorkerActivity` / `runReviewActivity` / `runAutoContinueActivity`
 * per architect §5.
 */

import type { AgentAdapter, BuiltInAgentName } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import { kiroAdapter } from "./kiro.js";

export const BUILTIN_AGENT_NAMES: readonly BuiltInAgentName[] = [
  "claude",
  "codex",
  "gemini",
  "kiro"
] as const;

const REGISTRY: Record<BuiltInAgentName, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  kiro: kiroAdapter
};

/**
 * Returns `true` when `name` matches one of the built-in adapters.
 * Useful for narrowing before calling `getAgentAdapter`.
 */
export function isBuiltInAgentName(name: string | undefined): name is BuiltInAgentName {
  return typeof name === "string" && (BUILTIN_AGENT_NAMES as readonly string[]).includes(name);
}

/**
 * Returns the adapter for a built-in name. Throws when the name is not
 * built-in; callers should narrow with `isBuiltInAgentName` before choosing
 * the built-in adapter selector path.
 */
export function getAgentAdapter(name: BuiltInAgentName): AgentAdapter {
  return REGISTRY[name];
}

export type {
  AdapterCommand,
  AdapterPermissionMode,
  AdapterResumeInput,
  AdapterRole,
  AdapterRunInput,
  AdapterRunResult,
  AdapterSandbox,
  AdapterApproval,
  AgentAdapter,
  BuiltInAgentName
} from "./types.js";
export { AdapterUnsupported } from "./types.js";
