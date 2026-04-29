/**
 * Activity-side adapter selector dispatch.
 *
 * Every activity that spawns an agent CLI resolves execution from the
 * validated state config block. `command` means verbatim shell command;
 * `agent` means built-in adapter dispatch. The schema rejects blocks that
 * set both selectors or neither selector for executable activity types.
 *
 * Workflow call sites do not get per-call command or agent selectors.
 * Execution selection belongs to `profile.states.<name>`.
 *
 * The verbatim `command` path does not expose a separate
 * `resume_command` slot in the host schema. Same-session resume only
 * applies to the adapter dispatch path, where `parseResult` captures the
 * session id and `runResume` regenerates the resume invocation.
 */

import { getAgentAdapter, isBuiltInAgentName } from "./index.js";
import type {
  AdapterCommand,
  AdapterPermissionMode,
  AdapterResumeInput,
  AdapterRole,
  AdapterRunInput,
  AgentAdapter,
  BuiltInAgentName
} from "./types.js";
import type { ActivityBlock } from "../catalog/types.js";

/**
 * Resolved invocation for one adapter call. Mirrors `AdapterCommand` plus
 * the adapter that produced it (so the caller can later run
 * `adapter.parseResult(...)` on the captured stdout).
 */
export interface AdapterDispatch {
  kind: "adapter";
  adapter: AgentAdapter;
  agentName: BuiltInAgentName;
  command: string;
}

export interface VerbatimDispatch {
  kind: "verbatim";
  command: string;
  /** Best-effort label for `AgentSessionRecord.agent` and logs. */
  agentLabel: string;
}

export type ResolvedCommand = AdapterDispatch | VerbatimDispatch;

export interface ResolveCommandInput {
  block: ActivityBlock;
  worktreeCwd: string;
  prompt: string;
  role: AdapterRole;
}

/**
 * Resolve a fresh (non-resume) invocation. Returns `undefined` when no
 * command can be derived; the caller throws a type-specific `CommandMissing`
 * error.
 */
export function resolveCommand(input: ResolveCommandInput): ResolvedCommand | undefined {
  const { block, worktreeCwd, prompt, role } = input;

  if (block.command) {
    return {
      kind: "verbatim",
      command: block.command,
      agentLabel: "custom"
    };
  }

  const builtIn = pickBuiltIn(block.agent);
  if (builtIn) {
    const adapter = getAgentAdapter(builtIn);
    const adapterInput: AdapterRunInput = buildAdapterRunInput({
      worktreeCwd,
      prompt,
      role,
      block
    });
    const out: AdapterCommand = adapter.runNew(adapterInput);
    return {
      kind: "adapter",
      adapter,
      agentName: builtIn,
      command: out.command
    };
  }

  return undefined;
}

export interface ResolveResumeInput {
  block: ActivityBlock;
  sessionId: string;
  worktreeCwd: string;
  prompt: string;
  role: AdapterRole;
}

/**
 * Build the resume command for a built-in adapter when the host is
 * (re-)entering an existing resumable session by id.
 * Only the adapter dispatch path supports same-session resume; the
 * verbatim `command` escape hatch never produces a resume invocation
 * and never reaches this function.
 */
export function resolveResumeCommand(input: ResolveResumeInput): AdapterDispatch | undefined {
  const { block, sessionId, worktreeCwd, prompt, role } = input;
  const builtIn = pickBuiltIn(block.agent);
  if (!builtIn) {
    return undefined;
  }
  const adapter = getAgentAdapter(builtIn);
  const adapterInput: AdapterResumeInput = {
    ...buildAdapterRunInput({ worktreeCwd, prompt, role, block }),
    sessionId
  };
  const out: AdapterCommand = adapter.runResume(adapterInput);
  return {
    kind: "adapter",
    adapter,
    agentName: builtIn,
    command: out.command
  };
}

function pickBuiltIn(blockAgent: string | undefined): BuiltInAgentName | undefined {
  if (isBuiltInAgentName(blockAgent)) {
    return blockAgent;
  }
  return undefined;
}

function buildAdapterRunInput(args: {
  worktreeCwd: string;
  prompt: string;
  role: AdapterRole;
  block: ActivityBlock;
}): AdapterRunInput {
  const { worktreeCwd, prompt, role, block } = args;
  const out: AdapterRunInput = { prompt, worktreeCwd, role };
  if (block.model !== undefined) {
    out.model = block.model;
  }
  if (block.reasoning_effort !== undefined) {
    out.reasoningEffort = block.reasoning_effort;
  }
  if (block.sandbox !== undefined) {
    out.sandbox = block.sandbox;
  }
  if (block.approval !== undefined) {
    out.approval = block.approval;
  }
  if (block.permission_mode !== undefined) {
    out.permissionMode = block.permission_mode as AdapterPermissionMode;
  }
  if (block.trust_all_tools !== undefined) {
    out.trustAllTools = block.trust_all_tools;
  }
  return out;
}
