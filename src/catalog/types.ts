import { z } from "zod";
import { hasInlineSecrets } from "../security/inlineSecrets.js";
import { BUILTIN_AGENT_NAMES, isBuiltInAgentName } from "../adapters/index.js";

const ActivityNameSchema = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const AgentLabelSchema = z.string().min(1);
const ReviewNormalizerSchema = z.enum(["claude", "codex"]);
const CommandStringSchema = z.string().min(1).refine((value) => !hasInlineSecrets(value), {
  message: "command must not contain inline secret values; use external CLI auth or inherited environment references"
});
const TimeoutValueSchema = z.union([z.number().int().positive(), z.string().min(1)]).refine(
  (value) => {
    try {
      parseActivityTimeoutMs(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "timeout must be a positive duration such as 30000, 30s, 30m, or 2h" }
);

export const ActivityTypeSchema = z.enum([
  "work",
  "verify",
  "review"
]);

export type ActivityType = z.infer<typeof ActivityTypeSchema>;

const ORCHESTRATION_FIELDS = [
  "resume",
  "sandbox",
  "approval",
  "permission_mode",
  "trust_all_tools"
] as const satisfies readonly ActivityBlockField[];

export const activityTypeContracts = {
  verify: {
    required: ["command"],
    allowed: ["command", "timeout", ...ORCHESTRATION_FIELDS]
  },
  work: {
    requiredOneOf: [["command", "agent"]],
    allowed: ["agent", "command", "timeout", ...ORCHESTRATION_FIELDS]
  },
  review: {
    requiredOneOf: [["command", "agent"]],
    allowed: ["agent", "normalizer", "command", "timeout", ...ORCHESTRATION_FIELDS]
  }
} as const satisfies Record<
  ActivityType,
  {
    required?: readonly ActivityBlockField[];
    requiredOneOf?: readonly (readonly ActivityBlockField[])[];
    allowed: readonly ActivityBlockField[];
  }
>;

type ActivityBlockField =
  | "agent"
  | "normalizer"
  | "command"
  | "resume"
  | "timeout"
  | "sandbox"
  | "approval"
  | "permission_mode"
  | "trust_all_tools";

/**
 * Activity block contract:
 * - every block has a required product-controlled `type`
 * - deterministic `verify` activities require `command`
 * - `work` and `review` require either `agent` or `command`
 * - when `agent` is set on a `work` / `review` block it
 *   must name one of the built-in adapters (`claude`, `codex`,
 *   `gemini`, `kiro`, `kiro-acp`); the host dispatches the CLI argv, resume invocation,
 *   and session-id capture for those names
 * - `normalizer` is review-only. It is required when a review state selects
 *   `gemini`, `kiro`, or `kiro-acp`, and must be `claude` or `codex`.
 * - `agent` and `command` are mutually exclusive execution selectors
 * - `resume` is a non-negative integer workflow-readable budget. `0` or
 *   an absent value disables in-session resume by convention. The schema
 *   does not infer behavior from TYPE, NAME, `agent`, or `command`; workflow
 *   code decides whether that number matters for its own loop.
 */
const SandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const ApprovalSchema = z.enum(["never", "on-request", "on-failure", "untrusted"]);
const PermissionModeSchema = z.enum(["plan", "default", "acceptEdits", "bypassPermissions"]);

export const StateConfigBlockSchema = z
  .object({
    type: ActivityTypeSchema,
    agent: AgentLabelSchema.optional(),
    normalizer: ReviewNormalizerSchema.optional(),
    command: CommandStringSchema.optional(),
    resume: z.number().int().min(0).optional(),
    timeout: TimeoutValueSchema.optional(),
    sandbox: SandboxSchema.optional(),
    approval: ApprovalSchema.optional(),
    permission_mode: PermissionModeSchema.optional(),
    trust_all_tools: z.boolean().optional()
  })
  .strict()
  .superRefine(validateActivityBlock);

/**
 * `policies` is an opaque map of workflow-author-defined policy blocks.
 * The host schema validates only the outer shape (object with string
 * keys); each workflow bundle validates the keys it consumes at workflow
 * start. Cross-field rules and unknown-key checks live in the bundle
 * that owns the policy.
 */
export const PoliciesSchema = z.record(z.string(), z.unknown());

export const TychonicConfigSchema = z
  .object({
    version: z.literal("tychonic.config.v1"),
    states: z.record(ActivityNameSchema, StateConfigBlockSchema).optional(),
    policies: PoliciesSchema.optional()
  })
  .strict();

export type ActivityBlock = z.infer<typeof StateConfigBlockSchema>;
export type TychonicConfig = z.infer<typeof TychonicConfigSchema>;

export type ActivityTimeoutName = string;
export type ActivityTimeoutOverrides = Partial<Record<ActivityTimeoutName, number>>;

export const DEFAULT_ACTIVITY_TIMEOUT_BY_TYPE = {
  verify: 30 * 60 * 1000,
  work: 120 * 60 * 1000,
  review: 45 * 60 * 1000
} as const satisfies Record<ActivityType, number>;

export function defaultActivityTimeoutMs(type: ActivityType): number {
  return DEFAULT_ACTIVITY_TIMEOUT_BY_TYPE[type];
}

export function parseActivityTimeoutMs(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("activity timeout must be a positive integer");
    }
    return value;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^([1-9][0-9]*)\s*(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(`invalid activity timeout ${value}`);
  }
  const amt = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return amt * multiplier;
}

export function activityTimeoutMs(
  profile: TychonicConfig | undefined,
  name: ActivityTimeoutName,
  defaultTimeoutMs: number
): number {
  const configured = profile?.states?.[name]?.timeout;
  return configured === undefined ? defaultTimeoutMs : parseActivityTimeoutMs(configured);
}

export function activityTimeoutOverrides(
  profile: TychonicConfig | undefined,
  defaultTimeoutMs?: number
): ActivityTimeoutOverrides | undefined {
  const entries = Object.entries(profile?.states ?? {}).filter(([, block]) => block.timeout !== undefined);
  if (entries.length === 0 && defaultTimeoutMs === undefined) {
    return undefined;
  }
  const result: ActivityTimeoutOverrides = { default: defaultTimeoutMs };
  for (const [name, block] of entries) {
    if (block.timeout !== undefined) {
      result[name] = parseActivityTimeoutMs(block.timeout);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function requiredActivity(
  profile: TychonicConfig | undefined,
  name: string,
  expectedType: ActivityType
): ActivityBlock {
  const activity = validatedStateBlock(profile, name);
  if (!activity) {
    throw new Error(`missing required activity '${name}' of type '${expectedType}'`);
  }
  if (activity.type !== expectedType) {
    throw new Error(`activity '${name}' must have type '${expectedType}', got '${activity.type}'`);
  }
  return activity;
}

export function optionalStateConfig(
  profile: TychonicConfig | undefined,
  name: string,
  expectedType: ActivityType
): ActivityBlock | undefined {
  const activity = validatedStateBlock(profile, name);
  if (!activity) {
    return undefined;
  }
  if (activity.type !== expectedType) {
    throw new Error(`activity '${name}' must have type '${expectedType}', got '${activity.type}'`);
  }
  return activity;
}

function validatedStateBlock(profile: TychonicConfig | undefined, name: string): ActivityBlock | undefined {
  const block = profile?.states?.[name];
  if (!block) {
    return undefined;
  }
  const parsed = StateConfigBlockSchema.safeParse(block);
  if (!parsed.success) {
    throw new Error(`profile.states.${name} failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function validateActivityBlock(block: ActivityBlock, ctx: z.RefinementCtx): void {
  const contract = activityTypeContracts[block.type] as {
    required?: readonly ActivityBlockField[];
    requiredOneOf?: readonly (readonly ActivityBlockField[])[];
    allowed: readonly ActivityBlockField[];
  };
  const allowed = new Set<ActivityBlockField>(contract.allowed);
  for (const key of activityBlockFieldNames()) {
    if (block[key] !== undefined && !allowed.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `states.<name>.${key} is not allowed for type ${block.type}`,
        path: [key]
      });
    }
  }
  for (const key of contract.required ?? []) {
    if (block[key] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `states.<name>.${key} is required for type ${block.type}`,
        path: [key]
      });
    }
  }
  for (const group of contract.requiredOneOf ?? []) {
    const satisfied = group.some((key) => block[key] !== undefined);
    if (!satisfied) {
      const issuePath = group[0] !== undefined ? [group[0] as string] : [];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `states.<name> for type ${block.type} requires one of: ${group.join(", ")}`,
        path: issuePath
      });
    }
  }

  validateAgentName(block, ctx);
  validateSingleExecutionSelector(block, ctx);
  validateReviewerCapableAgent(block, ctx);
}

/**
 * Built-in adapters that need a review normalizer. They can produce prose
 * review output, but not the structured payload the host accepts directly.
 */
const NON_REVIEWER_BUILTIN_AGENTS = new Set<string>(["gemini", "kiro", "kiro-acp"]);

/**
 * When `agent` is set on an adapter-capable activity type, restrict it
 * to the built-in adapter names. Misspelt names (`claud`,
 * `geminii`, ...) are caught at config validation time so they never
 * reach the runtime command-resolution chain — which would otherwise
 * fall through and surface as a `CommandMissing` failure mid-run.
 */
function validateAgentName(block: ActivityBlock, ctx: z.RefinementCtx): void {
  if (block.agent === undefined) return;
  // `agent` is only a meaningful adapter selector on adapter-backed
  // types. On deterministic types the field is rejected by the
  // allowed-list check above; we never reach here for those.
  if (block.type !== "work" && block.type !== "review") {
    return;
  }
  if (!isBuiltInAgentName(block.agent)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `states.<name>.agent '${block.agent}' is not a built-in adapter; ` +
        `must be one of: ${(BUILTIN_AGENT_NAMES as readonly string[]).join(", ")}. ` +
        "For a custom CLI use the `command` field directly (escape hatch).",
      path: ["agent"]
    });
  }
}

function validateSingleExecutionSelector(block: ActivityBlock, ctx: z.RefinementCtx): void {
  if (block.agent !== undefined && block.command !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "states.<name> must set only one execution selector: agent or command",
      path: ["command"]
    });
  }
}

/**
 * `gemini`, `kiro`, and `kiro-acp` review states must name a built-in
 * normalizer (`claude` or `codex`). Direct structured reviewers (`claude`,
 * `codex`) must not set a normalizer because they already emit the semantic
 * review payload the host normalizes.
 */
function validateReviewerCapableAgent(block: ActivityBlock, ctx: z.RefinementCtx): void {
  if (block.type !== "review") return;
  if (block.command !== undefined && block.normalizer !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "states.<name>.normalizer is only valid with a review agent, not command",
      path: ["normalizer"]
    });
    return;
  }
  if (block.agent === undefined) return;
  if (NON_REVIEWER_BUILTIN_AGENTS.has(block.agent)) {
    if (block.normalizer === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `agent ${block.agent} requires states.<name>.normalizer on a review state; ` +
          "normalizer must be claude or codex",
        path: ["normalizer"]
      });
    }
    return;
  }
  if (block.normalizer !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "states.<name>.normalizer is only valid when the review agent is gemini, kiro, or kiro-acp",
      path: ["normalizer"]
    });
  }
}

function activityBlockFieldNames(): ActivityBlockField[] {
  return [
    "agent",
    "normalizer",
    "command",
    "resume",
    "timeout",
    "sandbox",
    "approval",
    "permission_mode",
    "trust_all_tools"
  ];
}
