import {
  generateDeclarativeWorkflowModule,
  generateDeclarativeWorkflowMermaid,
  parseDeclarativeWorkflowSpecYaml
} from "../../declarative/workflowSpec.js";
import type { ContractCheck } from "./types.js";
import { expectAccept, expectReject } from "./types.js";

export const declarativeWorkflowContractChecks: readonly ContractCheck[] = [
  {
    area: "declarativeWorkflow",
    name: "accepts a minimal verify workflow.yaml",
    run() {
      expectAccept("minimal declarative verify workflow", () =>
        parseDeclarativeWorkflowSpecYaml({
          bundleName: "yamlVerifyWorkflow",
          source: [
            "version: tychonic.workflow.v1",
            "name: yamlVerifyWorkflow",
            "worktree: false",
            "max_steps: 3",
            "start: verify",
            "states:",
            "  verify:",
            "    type: verify",
            "    command: echo ok",
            "    on_pass:",
            "      finish: true",
            "    on_fail:",
            "      finish: verify failed",
            ""
          ].join("\n")
        })
      );
    }
  },
  {
    area: "declarativeWorkflow",
    name: "rejects review fail transitions that target review states",
    run() {
      expectReject(
        "declarative review fail target is review",
        () =>
          parseDeclarativeWorkflowSpecYaml({
            bundleName: "badYamlWorkflow",
            source: [
              "version: tychonic.workflow.v1",
              "name: badYamlWorkflow",
              "worktree: true",
              "max_steps: 5",
              "start: work",
              "states:",
              "  work:",
              "    type: work",
              "    agent: claude",
              "    prompt: work",
              "    on_pass:",
              "      goto: review",
              "    on_fail:",
              "      finish: work failed",
              "  review:",
              "    type: review",
              "    agent: codex",
              "    on_fail_return_to: review_fix",
              "    prompt: review",
              "    on_pass:",
              "      finish: true",
              "    on_fail:",
              "      goto: review_fix",
              "  review_fix:",
              "    type: review",
              "    agent: claude",
              "    on_fail_return_to: work",
              "    prompt: fix review",
              "    on_pass:",
              "      finish: true",
              "    on_fail:",
              "      goto: work",
              ""
            ].join("\n")
          }),
        /on_fail_return_to must name a non-review state/
      );
    }
  },
  {
    area: "declarativeWorkflow",
    name: "rejects review fail transitions that diverge from on_fail_return_to",
    run() {
      expectReject(
        "declarative review fail transition mismatch",
        () =>
          parseDeclarativeWorkflowSpecYaml({
            bundleName: "mismatchWorkflow",
            source: [
              "version: tychonic.workflow.v1",
              "name: mismatchWorkflow",
              "worktree: true",
              "max_steps: 5",
              "start: work",
              "states:",
              "  work:",
              "    type: work",
              "    agent: claude",
              "    prompt: work",
              "    on_pass:",
              "      goto: review",
              "    on_fail:",
              "      finish: work failed",
              "  verify:",
              "    type: verify",
              "    command: npm test",
              "    on_pass:",
              "      finish: true",
              "    on_fail:",
              "      finish: verify failed",
              "  review:",
              "    type: review",
              "    agent: codex",
              "    on_fail_return_to: work",
              "    prompt: review",
              "    on_pass:",
              "      finish: true",
              "    on_fail:",
              "      goto: verify",
              ""
            ].join("\n")
          }),
        /on_fail\.goto must equal on_fail_return_to/
      );
    }
  },
  {
    area: "declarativeWorkflow",
    name: "rejects prompt on verify states",
    run() {
      expectReject(
        "declarative verify prompt is dead surface",
        () =>
          parseDeclarativeWorkflowSpecYaml({
            bundleName: "verifyPromptWorkflow",
            source: [
              "version: tychonic.workflow.v1",
              "name: verifyPromptWorkflow",
              "worktree: false",
              "max_steps: 3",
              "start: verify",
              "states:",
              "  verify:",
              "    type: verify",
              "    command: echo ok",
              "    prompt: ignored",
              "    on_pass:",
              "      finish: true",
              "    on_fail:",
              "      finish: verify failed",
              ""
            ].join("\n")
          }),
        /prompt is not allowed for type verify/
      );
    }
  },
  {
    area: "declarativeWorkflow",
    name: "generated workflows retry dead workers promptly",
    run() {
      expectAccept("declarative generated activity heartbeat timeout", () => {
        const spec = parseDeclarativeWorkflowSpecYaml({
          bundleName: "heartbeatWorkflow",
          source: [
            "version: tychonic.workflow.v1",
            "name: heartbeatWorkflow",
            "worktree: false",
            "max_steps: 3",
            "start: verify",
            "states:",
            "  verify:",
            "    type: verify",
            "    command: echo ok",
            "    on_pass:",
            "      finish: true",
            "    on_fail:",
            "      finish: verify failed",
            ""
          ].join("\n")
        });
        const source = generateDeclarativeWorkflowModule({
          bundleName: "heartbeatWorkflow",
          spec
        });
        if (!source.includes("heartbeatTimeout: \"30 seconds\"")) {
          throw new Error("generated workflow activity heartbeat timeout is not bounded for runtime restart recovery");
        }
        if (!source.includes("createWorktreeActivity: act.createWorktreeActivity")) {
          throw new Error("generated workflow applies heartbeat timeout to non-heartbeating worktree creation");
        }
        if (!source.includes("runVerifyActivity: heartbeatAct.runVerifyActivity")) {
          throw new Error("generated workflow does not route command activity through heartbeat proxy");
        }
        if (!source.includes("extractWorktreePatchActivity: heartbeatAct.extractWorktreePatchActivity")) {
          throw new Error("generated workflow does not wire extractWorktreePatchActivity for finish-time patch capture");
        }
        if (source.includes("cleanupWorktreeActivity")) {
          throw new Error("generated workflow still references the deprecated cleanupWorktreeActivity");
        }
      });
    }
  },
  {
    area: "declarativeWorkflow",
    name: "generated workflows absorb transient activity failures",
    run() {
      expectAccept("declarative generated activity retry policy", () => {
        const spec = parseDeclarativeWorkflowSpecYaml({
          bundleName: "retryPolicyWorkflow",
          source: [
            "version: tychonic.workflow.v1",
            "name: retryPolicyWorkflow",
            "worktree: false",
            "max_steps: 3",
            "start: verify",
            "states:",
            "  verify:",
            "    type: verify",
            "    command: echo ok",
            "    on_pass:",
            "      finish: true",
            "    on_fail:",
            "      finish: verify failed",
            ""
          ].join("\n")
        });
        const source = generateDeclarativeWorkflowModule({
          bundleName: "retryPolicyWorkflow",
          spec
        });
        if (!source.includes("initialInterval: \"5 seconds\"")) {
          throw new Error("generated workflow activity retry initialInterval is too short to avoid hammering external systems");
        }
        if (!source.includes("maximumInterval: \"10 minutes\"")) {
          throw new Error("generated workflow activity retry does not cap backoff for transient failure absorption");
        }
        if (!source.includes("backoffCoefficient: 2")) {
          throw new Error("generated workflow activity retry backoffCoefficient drift from documented contract");
        }
        if (!source.includes("maximumAttempts: 100")) {
          throw new Error("generated workflow activity retry budget is too narrow for transient failure absorption");
        }
        if (!source.includes("retry: transientRetry")) {
          throw new Error("generated workflow proxies do not share the transient retry policy");
        }
      });
    }
  },
  {
    area: "declarativeWorkflow",
    name: "generated review fail transitions attach feedback to return target prompts",
    run() {
      expectAccept("declarative generated review feedback routing", () => {
        const spec = parseDeclarativeWorkflowSpecYaml({
          bundleName: "reviewFeedbackWorkflow",
          source: [
            "version: tychonic.workflow.v1",
            "name: reviewFeedbackWorkflow",
            "worktree: true",
            "max_steps: 6",
            "start: work",
            "states:",
            "  work:",
            "    type: work",
            "    command: cat >/dev/null",
            "    prompt: do work",
            "    on_pass:",
            "      goto: review",
            "    on_fail:",
            "      finish: work failed",
            "  review:",
            "    type: review",
            "    command: printf '%s\\n' '{\"schema_version\":\"tychonic.review.v1\",\"status\":\"pass\",\"summary\":\"ok\",\"findings\":[]}'",
            "    on_fail_return_to: work",
            "    prompt: review work",
            "    on_pass:",
            "      finish: true",
            "    on_fail:",
            "      goto: work",
            ""
          ].join("\n")
        });
        const source = generateDeclarativeWorkflowModule({
          bundleName: "reviewFeedbackWorkflow",
          spec
        });
        if (!source.includes("const feedbacksByState = new Map();")) {
          throw new Error("generated workflow does not keep review feedback by return target state");
        }
        if (!source.includes("const returnTo = assertReviewFailReturnTo(input.profile, \"review\", \"work\");")) {
          throw new Error("generated review fail transition does not assert the effective on_fail_return_to target");
        }
        if (!source.includes("addDeclarativeReviewFeedback(feedbacksByState, returnTo, declarativeReviewFeedback(\"review\", result));")) {
          throw new Error("generated review fail transition does not attach feedback to asserted on_fail_return_to target");
        }
        if (!source.includes("if (!result.passed && isDeclarativeReviewInfrastructureFailure(result))")) {
          throw new Error("generated review state does not split infrastructure failures from semantic review failures");
        }
        if (!source.includes("declarativeReviewInfrastructureInboxItem(\"review\", result)")) {
          throw new Error("generated review infrastructure failure does not create an operator triage inbox item");
        }
        if (!source.includes("ctx.work(\"work\", appendDeclarativeReviewFeedback(renderDeclarativePrompt(\"do work\", input), feedbacksByState.get(\"work\") ?? []))")) {
          throw new Error("generated work state prompt does not include returned review feedback");
        }
      });
    }
  },
  {
    area: "declarativeWorkflow",
    name: "rejects unsupported prompt variables",
    run() {
      for (const [label, prompt, expected] of [
        ["unknown identifier", "Do {{unknown}}", /unsupported variable "unknown"/],
        ["malformed dotted variable", "Do {{goal.text}}", /unsupported variable "goal\.text"/],
        ["malformed dashed variable", "Do {{goal-name}}", /unsupported variable "goal-name"/],
        ["empty variable", "Do {{ }}", /unsupported variable ""/]
      ] as const) {
        expectReject(
          `declarative prompt ${label}`,
          () =>
            parseDeclarativeWorkflowSpecYaml({
              bundleName: "badPromptVariableWorkflow",
              source: [
                "version: tychonic.workflow.v1",
                "name: badPromptVariableWorkflow",
                "worktree: true",
                "max_steps: 3",
                "start: work",
                "states:",
                "  work:",
                "    type: work",
                "    agent: claude",
                `    prompt: ${JSON.stringify(prompt)}`,
                "    on_pass:",
                "      finish: true",
                "    on_fail:",
                "      finish: work failed",
                ""
              ].join("\n")
            }),
          expected
        );
      }
    }
  },
  {
    area: "declarativeWorkflow",
    name: "generates unique Mermaid ids for punctuation-distinct states",
    run() {
      expectAccept("declarative Mermaid state ids do not collide", () => {
        const spec = parseDeclarativeWorkflowSpecYaml({
          bundleName: "punctuationWorkflow",
          source: [
            "version: tychonic.workflow.v1",
            "name: punctuationWorkflow",
            "worktree: false",
            "max_steps: 5",
            "start: qa-fix",
            "states:",
            "  qa-fix:",
            "    type: verify",
            "    command: echo dash",
            "    on_pass:",
            "      goto: qa.fix",
            "    on_fail:",
            "      finish: dash failed",
            "  qa.fix:",
            "    type: verify",
            "    command: echo dot",
            "    on_pass:",
            "      goto: qa_fix",
            "    on_fail:",
            "      finish: dot failed",
            "  qa_fix:",
            "    type: verify",
            "    command: echo underscore",
            "    on_pass:",
            "      finish: true",
            "    on_fail:",
            "      finish: underscore failed",
            ""
          ].join("\n")
        });
        const mermaid = generateDeclarativeWorkflowMermaid(spec);
        if (!mermaid.includes("s0[\"qa-fix\\\\nverify\"]")) {
          throw new Error("missing dash state id");
        }
        if (!mermaid.includes("s1[\"qa.fix\\\\nverify\"]")) {
          throw new Error("missing dot state id");
        }
        if (!mermaid.includes("s2[\"qa_fix\\\\nverify\"]")) {
          throw new Error("missing underscore state id");
        }
      });
    }
  }
];
