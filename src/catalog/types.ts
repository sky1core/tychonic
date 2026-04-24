import { z } from "zod";
import { hasInlineSecrets } from "../security/inlineSecrets.js";

const ActivityNameSchema = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const AgentLabelSchema = z.string().min(1);
const EmitsContractListSchema = z.array(z.string().min(1)).min(1);
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
  "lint",
  "unit_test",
  "integration",
  "work",
  "verify",
  "review",
  "auto_continue"
]);

export type ActivityType = z.infer<typeof ActivityTypeSchema>;

const ORCHESTRATION_FIELDS = [
  "sandbox",
  "approval",
  "permission_mode",
  "trust_all_tools"
] as const satisfies readonly ActivityBlockField[];

export const activityTypeContracts = {
  lint: {
    required: ["command"],
    allowed: ["command", "resume", "timeout", ...ORCHESTRATION_FIELDS]
  },
  unit_test: {
    required: ["command"],
    allowed: ["command", "resume", "timeout", ...ORCHESTRATION_FIELDS]
  },
  integration: {
    required: ["command"],
    allowed: ["command", "resume", "timeout", ...ORCHESTRATION_FIELDS]
  },
  verify: {
    required: ["command"],
    allowed: ["command", "resume", "timeout", ...ORCHESTRATION_FIELDS]
  },
  work: {
    required: ["command"],
    allowed: ["agent", "command", "resume", "resume_command", "timeout", ...ORCHESTRATION_FIELDS]
  },
  auto_continue: {
    required: ["command"],
    allowed: ["agent", "command", "resume", "resume_command", "timeout", ...ORCHESTRATION_FIELDS]
  },
  review: {
    required: ["command"],
    allowed: ["resume", "agent", "command", "emits", "timeout", ...ORCHESTRATION_FIELDS]
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
  | "command"
  | "resume"
  | "resume_command"
  | "emits"
  | "timeout"
  | "sandbox"
  | "approval"
  | "permission_mode"
  | "trust_all_tools";

/**
 * Activity block contract:
 * - every block has a required product-controlled `type`
 * - deterministic command activities (`lint`, `unit_test`, `integration`, `verify`) require `command`
 * - `work`, `review`, and `auto_continue` require explicit `command`
 * - `agent` is optional metadata for logs, UI labels, and session records
 * - `resume` is a node-level continuity option. Absent means `true` for `work`,
 *   `false` for all other activity types
 * - review activities (`review`) must declare `emits: ["tychonic.review.v1"]`
 */
const SandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const ApprovalSchema = z.enum(["never", "on-request", "on-failure", "untrusted"]);
const PermissionModeSchema = z.enum(["plan", "default", "acceptEdits", "bypassPermissions"]);

export const StateConfigBlockSchema = z
  .object({
    type: ActivityTypeSchema,
    agent: AgentLabelSchema.optional(),
    command: CommandStringSchema.optional(),
    resume: z.boolean().optional(),
    resume_command: CommandStringSchema.optional(),
    emits: EmitsContractListSchema.optional(),
    timeout: TimeoutValueSchema.optional(),
    sandbox: SandboxSchema.optional(),
    approval: ApprovalSchema.optional(),
    permission_mode: PermissionModeSchema.optional(),
    trust_all_tools: z.boolean().optional()
  })
  .strict()
  .superRefine(validateActivityBlock);

export const PolicyLoopSchema = z
  .object({
    auto_continue: z.boolean().optional(),
    max_review_iterations: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.max_review_iterations !== undefined && !policy.auto_continue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policies.loop.max_review_iterations requires policies.loop.auto_continue",
        path: ["max_review_iterations"]
      });
    }
  });

export const PolicyIntegrationSchema = z
  .object({
    mode: z.enum(["disabled", "manual", "auto_on_relevant_changes", "required"]),
    position: z.enum(["before_ai_review", "after_ai_review", "final_gate"])
  })
  .strict();

export const PolicySelfRepairWorkflowSchema = z
  .object({
    max_iterations: z.number().int().positive().optional()
  })
  .strict();

export { INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS } from "../workflows/interactionDefaults.js";

export const PolicyInteractionSchema = z
  .object({
    mode: z.enum(["auto", "interactive"]),
    max_reject_iterations: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.mode === "auto" && policy.max_reject_iterations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policies.interaction.max_reject_iterations is only allowed when mode is 'interactive'",
        path: ["max_reject_iterations"]
      });
    }
  });

export const PoliciesSchema = z
  .object({
    loop: PolicyLoopSchema.optional(),
    integration: PolicyIntegrationSchema.optional(),
    self_repair_workflow: PolicySelfRepairWorkflowSchema.optional(),
    interaction: PolicyInteractionSchema.optional()
  })
  .strict();

export const TychonicConfigSchema = z
  .object({
    version: z.literal("tychonic.config.v1"),
    states: z.record(ActivityNameSchema, StateConfigBlockSchema).optional(),
    policies: PoliciesSchema.optional()
  })
  .strict();

export type ActivityBlock = z.infer<typeof StateConfigBlockSchema>;
export type PolicyLoop = z.infer<typeof PolicyLoopSchema>;
export type PolicyIntegration = z.infer<typeof PolicyIntegrationSchema>;
export type PolicySelfRepairWorkflow = z.infer<typeof PolicySelfRepairWorkflowSchema>;
export type PolicyInteraction = z.infer<typeof PolicyInteractionSchema>;
export type TychonicConfig = z.infer<typeof TychonicConfigSchema>;

export type ActivityTimeoutName = string;
export type ActivityTimeoutOverrides = Partial<Record<ActivityTimeoutName, number>>;

export const DEFAULT_ACTIVITY_TIMEOUT_BY_TYPE = {
  lint: 10 * 60 * 1000,
  unit_test: 30 * 60 * 1000,
  integration: 60 * 60 * 1000,
  verify: 30 * 60 * 1000,
  work: 120 * 60 * 1000,
  review: 45 * 60 * 1000,
  auto_continue: 90 * 60 * 1000
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
  const activity = profile?.states?.[name];
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
  const activity = profile?.states?.[name];
  if (!activity) {
    return undefined;
  }
  if (activity.type !== expectedType) {
    throw new Error(`activity '${name}' must have type '${expectedType}', got '${activity.type}'`);
  }
  return activity;
}

export function resolveActivityCommand(activity: ActivityBlock | undefined): ActivityBlock | undefined {
  return activity?.command ? { ...activity } : undefined;
}

export function stateResumeEnabled(activity: ActivityBlock | undefined): boolean {
  if (!activity) {
    return false;
  }
  return activity.resume ?? (activity.type === "work");
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

  validateReviewContract(block, ctx);
}

function validateReviewContract(block: ActivityBlock, ctx: z.RefinementCtx): void {
  if (block.type !== "review") {
    return;
  }
  if (!block.emits?.includes("tychonic.review.v1")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'custom reviewer command must declare emits: ["tychonic.review.v1"]',
      path: ["emits"]
    });
  }
}

function activityBlockFieldNames(): ActivityBlockField[] {
  return [
    "agent",
    "command",
    "resume",
    "resume_command",
    "emits",
    "timeout",
    "sandbox",
    "approval",
    "permission_mode",
    "trust_all_tools"
  ];
}
