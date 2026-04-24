import { describe, expect, it } from "vitest";
import type { AgentSessionRecord, WorkflowRunRecord } from "../src/domain/types.js";
import { ReviewResultSchema } from "../src/review/schema.js";
import {
  appendReviewFindingsToRun,
  buildFreshWorkPrompt,
  buildResumePrompt,
  planReviewContinuations
} from "../src/workflows/resumeLoop.js";

describe("ReviewResultSchema", () => {
  it("accepts fail results with actionable findings", () => {
    const result = ReviewResultSchema.parse({
      schema_version: "tychonic.review.v1",
      status: "fail",
      summary: "Goal not met.",
      findings: [
        {
          severity: "high",
          title: "Missing process-group cleanup",
          detail: "Timeout only kills the shell.",
          target: "src/bootstrap/commandRunner.ts",
          target_session_id: "session_worker_1"
        }
      ]
    });

    expect(result.findings[0]?.target_session_id).toBe("session_worker_1");
  });

  it("rejects pass results that contain findings", () => {
    expect(() =>
      ReviewResultSchema.parse({
        schema_version: "tychonic.review.v1",
        status: "pass",
        summary: "Looks good.",
        findings: [
          {
            severity: "low",
            title: "Contradictory finding",
            detail: "A pass result cannot contain findings.",
            target: "src/index.ts"
          }
        ]
      })
    ).toThrow(/pass review results/);
  });

  it("rejects pass results that omit findings", () => {
    expect(() =>
      ReviewResultSchema.parse({
        schema_version: "tychonic.review.v1",
        status: "pass",
        summary: "Looks good."
      })
    ).toThrow();
  });

  it("rejects fail results without findings", () => {
    expect(() =>
      ReviewResultSchema.parse({
        schema_version: "tychonic.review.v1",
        status: "fail",
        summary: "No details.",
        findings: []
      })
    ).toThrow(/fail review results/);
  });

  it("normalizes empty-string target_session_id to absent on a finding", () => {
    // Real-world observation: Codex commonly emits `target_session_id: ""`
    // as a placeholder when the finding is not tied to a resumable worker
    // session. The schema accepts this and surfaces it as absent so the
    // parsed payload matches the "no session" shape everywhere else.
    const result = ReviewResultSchema.parse({
      schema_version: "tychonic.review.v1",
      status: "fail",
      summary: "Missing tests.",
      findings: [
        {
          severity: "medium",
          title: "No test for Div edge case",
          detail: "TestDiv never exercises b==0.",
          target: "math_test.go",
          target_session_id: ""
        }
      ]
    });

    expect(result.findings[0]?.target_session_id).toBeUndefined();
  });
});

describe("resume loop planning", () => {
  const session: AgentSessionRecord = {
    id: "session_worker_1",
    agent: "codex",
    role: "worker",
    external_session_id: "external-session-1",
    resume_command: "codex exec resume external-session-1",
    cwd: "/tmp/worktree",
    status: "succeeded",
    started_at: "2026-04-19T00:00:00.000Z"
  };

  it("plans a resume-work continuation for resumable target sessions", () => {
    const plans = planReviewContinuations(
      [
        {
          severity: "high",
          title: "Missing verification",
          detail: "The implementation does not run deterministic checks.",
          target: "src/bootstrap/checkpointRunner.ts",
          target_session_id: session.id
        }
      ],
      [session],
      ["npm run typecheck", "npm test"]
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.kind).toBe("resume_work");
    expect(plans[0]?.prompt).toContain("Missing verification");
    expect(plans[0]?.prompt).toContain("npm run typecheck");
  });

  it("triages findings that do not identify a target worker session", () => {
    const plans = planReviewContinuations(
      [
        {
          severity: "medium",
          title: "Detached finding",
          detail: "No session can be resumed.",
          target: "SPEC.md"
        }
      ],
      [session],
      []
    );

    expect(plans[0]?.kind).toBe("triage");
    expect(plans[0]?.reason).toMatch(/does not identify/);
  });

  it("builds continuation prompts from review findings", () => {
    const prompt = buildResumePrompt({
      finding: {
        severity: "high",
        title: "Timeout bug",
        detail: "The child process group is not killed.",
        target: "src/bootstrap/commandRunner.ts"
      },
      verificationCommands: ["npm test"]
    });

    expect(prompt).toContain("Continue the previous implementation session.");
    expect(prompt).toContain("Timeout bug");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("Do not broaden the scope");
  });

  it("builds fresh work prompts from non-resumable review findings", () => {
    const prompt = buildFreshWorkPrompt({
      findings: [
        {
          severity: "high",
          title: "Missing generated file",
          detail: "The implementation did not create final.txt.",
          target: "final.txt",
          target_session_id: "session_worker_1"
        }
      ],
      verificationCommands: ["npm test"]
    });

    expect(prompt).toContain("fresh worker session");
    expect(prompt).toContain("Missing generated file");
    expect(prompt).toContain("session_worker_1");
    expect(prompt).toContain("npm test");
  });

  it("appends findings and resume inbox items to a run", async () => {
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_1",
      template: "checkpoint",
      status: "running",
      cwd: "/tmp/project",
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
      states: [],
      activity_attempts: [],
      agent_sessions: [session],
      artifacts: [],
      findings: [],
      inbox: []
    };
    let next = 0;

    await appendReviewFindingsToRun({
      run,
      sourceStateId: "step_review",
      findings: [
        {
          severity: "critical",
          title: "Goal not met",
          detail: "The worker stopped before implementing storage.",
          target: "src/storage/runArtifactStore.ts",
          target_session_id: session.id
        }
      ],
      verificationCommands: ["npm run build"],
      now: "2026-04-19T00:00:00.000Z",
      nextId: (prefix) => `${prefix}_${++next}`,
      writePromptArtifact: async () => "artifact_prompt_1"
    });

    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]?.target_work_session_id).toBe(session.id);
    expect(run.inbox[0]?.action.kind).toBe("resume_work");
  });
});
