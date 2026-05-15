import { parse } from "yaml";
import { z } from "zod";
import {
  ActivityNameSchema,
  ActivityTypeSchema,
  StateConfigBlockSchema,
  TychonicConfigSchema,
  type TychonicConfig
} from "../catalog/types.js";

const TransitionSchema = z.union([
  z.object({ goto: ActivityNameSchema }).strict(),
  z.object({ finish: z.union([z.literal(true), z.string().min(1)]) }).strict()
]);

const DeclarativeStateSchema = z
  .object({
    type: ActivityTypeSchema,
    on_fail_return_to: ActivityNameSchema.optional(),
    agent: z.string().min(1).optional(),
    normalizer: z.enum(["claude", "codex"]).optional(),
    command: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoning_effort: z.string().min(1).optional(),
    resume: z.number().int().min(0).optional(),
    timeout: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    approval: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional(),
    permission_mode: z.enum(["plan", "default", "acceptEdits", "bypassPermissions"]).optional(),
    trust_all_tools: z.boolean().optional(),
    prompt: z.string().min(1).optional(),
    on_pass: TransitionSchema,
    on_fail: TransitionSchema
  })
  .strict()
  .superRefine((state, ctx) => {
    const parsed = StateConfigBlockSchema.safeParse(stateConfigBlock(state));
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: parsed.error.message
      });
    }
    if ((state.type === "work" || state.type === "review") && state.prompt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `states.<name>.prompt is required for type ${state.type}`,
        path: ["prompt"]
      });
    }
    if (state.type === "verify" && state.prompt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "states.<name>.prompt is not allowed for type verify",
        path: ["prompt"]
      });
    }
  });

const DeclarativeWorkflowSpecSchema = z
  .object({
    version: z.literal("tychonic.workflow.v1"),
    name: ActivityNameSchema,
    worktree: z.boolean(),
    max_steps: z.number().int().positive(),
    start: ActivityNameSchema,
    policies: z.record(z.string(), z.unknown()).optional(),
    states: z.record(ActivityNameSchema, DeclarativeStateSchema)
  })
  .strict();

const ALLOWED_PROMPT_VARIABLES = new Set(["goal"]);
const PROMPT_VARIABLE_PATTERN = /\{\{([\s\S]*?)\}\}/g;

export type DeclarativeTransition = z.infer<typeof TransitionSchema>;
export type DeclarativeWorkflowSpec = z.infer<typeof DeclarativeWorkflowSpecSchema> & {
  profile: TychonicConfig;
};

export function parseDeclarativeWorkflowSpecYaml(input: {
  source: string;
  bundleName: string;
  sourcePath?: string;
}): DeclarativeWorkflowSpec {
  const parsedYaml = parse(input.source);
  const parsed = DeclarativeWorkflowSpecSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    throw new Error(
      `workflow.yaml failed schema validation${input.sourcePath ? ` at ${input.sourcePath}` : ""}: ${parsed.error.message}`
    );
  }
  return validateDeclarativeWorkflowSpec(parsed.data, input.bundleName, input.sourcePath);
}

export function validateDeclarativeWorkflowSpec(
  raw: z.infer<typeof DeclarativeWorkflowSpecSchema>,
  bundleName: string,
  sourcePath?: string
): DeclarativeWorkflowSpec {
  if (raw.name !== bundleName) {
    throw new Error(
      `workflow.yaml name ${JSON.stringify(raw.name)} must match bundle directory name ${JSON.stringify(bundleName)}`
    );
  }
  const states = raw.states;
  if (states[raw.start] === undefined) {
    throw new Error(`workflow.yaml start state ${JSON.stringify(raw.start)} is not declared`);
  }

  const profile = TychonicConfigSchema.parse({
    version: "tychonic.config.v1",
    states: Object.fromEntries(
      Object.entries(states).map(([name, state]) => [name, stateConfigBlock(state)])
    ),
    ...(raw.policies ? { policies: raw.policies } : {})
  });

  let hasFinish = false;
  let hasWorkState = false;
  for (const [name, state] of Object.entries(states)) {
    if (state.type === "work") hasWorkState = true;
    for (const [label, transition] of [
      ["on_pass", state.on_pass],
      ["on_fail", state.on_fail]
    ] as const) {
      if ("finish" in transition) {
        hasFinish = true;
        continue;
      }
      if (states[transition.goto] === undefined) {
        throw new Error(
          `workflow.yaml states.${name}.${label}.goto must name an existing state, got ${JSON.stringify(transition.goto)}`
        );
      }
    }
    if (state.type === "review") {
      if (!("goto" in state.on_fail)) {
        throw new Error(`workflow.yaml review state ${JSON.stringify(name)} must route on_fail to on_fail_return_to`);
      }
      if (state.on_fail.goto !== state.on_fail_return_to) {
        throw new Error(
          `workflow.yaml review state ${JSON.stringify(name)} on_fail.goto must equal on_fail_return_to ${JSON.stringify(state.on_fail_return_to)}`
        );
      }
    }
    if (state.prompt !== undefined) {
      validatePromptVariables(name, state.prompt);
    }
  }
  if (!hasFinish) {
    throw new Error("workflow.yaml must declare at least one finish transition");
  }
  if (hasWorkState && !raw.worktree) {
    throw new Error("workflow.yaml worktree must be true when any state has type work");
  }

  return {
    ...raw,
    profile
  };
}

export function generateDeclarativeWorkflowModule(input: {
  bundleName: string;
  spec: DeclarativeWorkflowSpec;
}): string {
  return [
    "import { proxyActivities } from \"@temporalio/workflow\";",
    "import { assertReviewFailReturnTo, createTychonicWorkflowContext } from \"tychonic/workflow\";",
    "",
    "const act = proxyActivities({",
    "  startToCloseTimeout: \"24 hours\",",
    "  retry: { maximumAttempts: 3 }",
    "});",
    "const heartbeatAct = proxyActivities({",
    "  startToCloseTimeout: \"24 hours\",",
    "  heartbeatTimeout: \"30 seconds\",",
    "  retry: { maximumAttempts: 3 }",
    "});",
    "",
    `export const defaultProfile = ${JSON.stringify(input.spec.profile, null, 2)};`,
    `export const workflowDefinition = ${JSON.stringify(input.spec, null, 2)};`,
    "",
    "async function generatedWorkflow(input) {",
    "  const ctx = createTychonicWorkflowContext({",
    "    input,",
    `    template: ${JSON.stringify(input.spec.name)},`,
    "    activities: {",
    "      startRunActivity: act.startRunActivity,",
    "      createWorktreeActivity: act.createWorktreeActivity,",
    "      finalizeRunActivity: act.finalizeRunActivity,",
    "      runWorkerActivity: heartbeatAct.runWorkerActivity,",
    "      runVerifyActivity: heartbeatAct.runVerifyActivity,",
    "      runReviewActivity: heartbeatAct.runReviewActivity,",
    "      cleanupWorktreeActivity: heartbeatAct.cleanupWorktreeActivity",
    "    }",
    "  });",
    "  await ctx.start();",
    ...(input.spec.worktree ? ["  await ctx.createWorktree();"] : []),
    "  const feedbacksByState = new Map();",
    `  let current = ${JSON.stringify(input.spec.start)};`,
    `  for (let step = 0; step < ${JSON.stringify(input.spec.max_steps)}; step += 1) {`,
    "    switch (current) {",
    ...Object.entries(input.spec.states).flatMap(([name, state]) => generatedStateCase(name, state)),
    "      default:",
    "        throw new Error(`declarative workflow state ${JSON.stringify(current)} is not declared`);",
    "    }",
    "  }",
    "  return ctx.finishWaitingUser(",
    `    ${JSON.stringify(`declarative workflow ${input.spec.name} exceeded max_steps (${input.spec.max_steps})`)},`,
    "    {",
    "      id: \"inbox_declarative_step_cap\",",
    "      status: \"open\",",
    "      title: \"Declarative workflow step cap reached\",",
    `      detail: ${JSON.stringify(`Workflow ${input.spec.name} exceeded max_steps (${input.spec.max_steps}) before reaching a finish transition.`)},`,
    "      action: {",
    "        kind: \"triage\",",
    `        reason: ${JSON.stringify(`declarative workflow ${input.spec.name} max_steps reached`)}`,
    "      },",
    "      created_at: new Date().toISOString()",
    "    }",
    "  );",
    "}",
    "",
    "function appendDeclarativeReviewFeedback(basePrompt, feedbacks) {",
    "  if (feedbacks.length === 0) return basePrompt;",
    "  return `${basePrompt}\\n\\n[review feedback from previous failed review state(s)]\\n${feedbacks",
    "    .map((feedback, index) => `${index + 1}. ${feedback}`)",
    "    .join(\"\\n\")}\\n[/review feedback]`;",
    "}",
    "",
    "function renderDeclarativePrompt(template, input) {",
    "  const values = {",
    "    goal: typeof input.goal === \"string\" && input.goal.trim().length > 0",
    "      ? input.goal",
    "      : \"(no explicit goal supplied)\"",
    "  };",
    "  return template.replace(/\\{\\{([\\s\\S]*?)\\}\\}/g, (_match, rawName) => {",
    "    const name = String(rawName).trim();",
    "    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];",
    "    throw new Error(`unsupported declarative prompt variable ${name}`);",
    "  });",
    "}",
    "",
    "function addDeclarativeReviewFeedback(feedbacksByState, stateName, feedback) {",
    "  const existing = feedbacksByState.get(stateName) ?? [];",
    "  feedbacksByState.set(stateName, [...existing, feedback]);",
    "}",
    "",
    "function declarativeReviewFeedback(stateName, result) {",
    "  const lines = [`${stateName} review did not pass.`];",
    "  if (result.summary) {",
    "    lines.push(`Summary: ${result.summary}`);",
    "  } else if (result.reason) {",
    "    lines.push(`Reason: ${result.reason}`);",
    "  }",
    "  const outcome = result.activityResult?.reviewOutcome;",
    "  if (outcome?.kind === \"parsed\") {",
    "    const findings = Array.isArray(outcome.result?.findings) ? outcome.result.findings : [];",
    "    if (findings.length > 0) {",
    "      lines.push(\"Findings:\");",
    "      for (const finding of findings) {",
    "        const severity = finding?.severity ?? \"unknown\";",
    "        const title = finding?.title ?? \"Untitled finding\";",
    "        const detail = finding?.detail ?? \"\";",
    "        const target = finding?.target ? ` (${finding.target})` : \"\";",
    "        lines.push(`- [${severity}] ${title}${target}: ${detail}`);",
    "      }",
    "    }",
    "  } else if (outcome?.kind === \"unparseable\") {",
    "    lines.push(`Reviewer output was unparseable: ${outcome.detail}`);",
    "  } else if (outcome?.kind === \"command_failed\") {",
    "    lines.push(`Reviewer command failed with status ${outcome.status}.`);",
    "  } else if (outcome?.kind === \"skipped\") {",
    "    lines.push(`Reviewer was skipped: ${outcome.reason}`);",
    "  }",
    "  return lines.join(\"\\n\");",
    "}",
    "",
    `export { generatedWorkflow as ${JSON.stringify(input.bundleName)} };`,
    ""
  ].join("\n");
}

export function generateDeclarativeWorkflowMermaid(spec: DeclarativeWorkflowSpec): string {
  const stateIds = new Map(Object.keys(spec.states).map((name, index) => [name, `s${index}`]));
  const lines = ["flowchart TD"];
  lines.push("  __start((start))");
  lines.push(`  __start --> ${mermaidId(spec.start, stateIds)}`);
  lines.push("  __finish((finish))");
  for (const [name, state] of Object.entries(spec.states)) {
    lines.push(`  ${mermaidId(name, stateIds)}[\"${escapeMermaidLabel(`${name}\\n${state.type}`)}\"]`);
  }
  for (const [name, state] of Object.entries(spec.states)) {
    lines.push(mermaidEdge(name, "pass", state.on_pass, stateIds));
    lines.push(mermaidEdge(name, "fail", state.on_fail, stateIds));
  }
  return `${lines.join("\n")}\n`;
}

function generatedStateCase(
  name: string,
  state: z.infer<typeof DeclarativeStateSchema>
): string[] {
  return [
    `      case ${JSON.stringify(name)}: {`,
    `        const result = await ${stateCallExpression(name, state)};`,
    `        if (result.halted) return ctx.finish(result.summary ?? ${JSON.stringify(`${name} halted`)});`,
    ...generatedTransitionLines(state.on_pass, true),
    ...generatedTransitionLines(state.on_fail, false, state.type === "review" ? name : undefined),
    "      }"
  ];
}

function stateCallExpression(name: string, state: z.infer<typeof DeclarativeStateSchema>): string {
  if (state.type === "verify") {
    return `ctx.verify(${JSON.stringify(name)})`;
  }
  if (state.prompt === undefined) {
    throw new Error(`workflow.yaml state ${JSON.stringify(name)} requires prompt for type ${state.type}`);
  }
  const method = state.type === "work" ? "work" : "review";
  return `ctx.${method}(${JSON.stringify(name)}, appendDeclarativeReviewFeedback(renderDeclarativePrompt(${JSON.stringify(state.prompt)}, input), feedbacksByState.get(${JSON.stringify(name)}) ?? []))`;
}

function generatedTransitionLines(
  transition: DeclarativeTransition,
  passed: boolean,
  reviewStateName?: string
): string[] {
  const condition = passed ? "result.passed" : "!result.passed";
  return [
    `        if (${condition}) {`,
    ...generatedTransitionBody(transition, reviewStateName),
    "        }"
  ];
}

function generatedTransitionBody(
  transition: DeclarativeTransition,
  reviewStateName?: string
): string[] {
  if ("finish" in transition) {
    if (transition.finish === true) {
      return ["          return ctx.finish();"];
    }
    return [`          return ctx.finish(${JSON.stringify(transition.finish)});`];
  }
  const lines: string[] = [];
  if (reviewStateName !== undefined) {
    lines.push(
      `          const returnTo = assertReviewFailReturnTo(input.profile, ${JSON.stringify(reviewStateName)}, ${JSON.stringify(transition.goto)});`
    );
    lines.push(
      `          addDeclarativeReviewFeedback(feedbacksByState, returnTo, declarativeReviewFeedback(${JSON.stringify(reviewStateName)}, result));`
    );
    lines.push("          current = returnTo;", "          continue;");
    return lines;
  }
  lines.push(`          current = ${JSON.stringify(transition.goto)};`, "          continue;");
  return lines;
}

function mermaidEdge(
  from: string,
  label: string,
  transition: DeclarativeTransition,
  stateIds: ReadonlyMap<string, string>
): string {
  const target = "goto" in transition ? mermaidId(transition.goto, stateIds) : "__finish";
  return `  ${mermaidId(from, stateIds)} -->|${label}| ${target}`;
}

function mermaidId(name: string, stateIds: ReadonlyMap<string, string>): string {
  const id = stateIds.get(name);
  if (id === undefined) {
    throw new Error(`workflow.yaml Mermaid generation saw undeclared state ${JSON.stringify(name)}`);
  }
  return id;
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function stateConfigBlock(state: z.infer<typeof DeclarativeStateSchema>): Record<string, unknown> {
  const { prompt: _prompt, on_pass: _onPass, on_fail: _onFail, ...block } = state;
  return block;
}

function validatePromptVariables(stateName: string, prompt: string): void {
  const matches = prompt.matchAll(PROMPT_VARIABLE_PATTERN);
  for (const match of matches) {
    const rawVariableName = match[1];
    if (rawVariableName === undefined) {
      continue;
    }
    const variableName = rawVariableName.trim();
    if (!ALLOWED_PROMPT_VARIABLES.has(variableName)) {
      throw new Error(
        `workflow.yaml states.${stateName}.prompt uses unsupported variable ${JSON.stringify(variableName)}`
      );
    }
  }
}
