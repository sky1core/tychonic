import type {
  AgentSessionRecord,
  DecisionInboxItemRecord,
  FindingRecord,
  WorkflowRunRecord
} from "../domain/types.js";
import type { ReviewFinding } from "../review/schema.js";

export interface ResumePromptInput {
  finding: ReviewFinding;
  verificationCommands: string[];
}

export interface FreshWorkPromptInput {
  findings: ReviewFinding[];
  verificationCommands: string[];
}

export interface ContinuationPlan {
  kind: "resume_work" | "triage";
  finding: ReviewFinding;
  targetSession?: AgentSessionRecord;
  reason: string;
  prompt?: string;
}

export function buildResumePrompt(input: ResumePromptInput): string {
  const commands =
    input.verificationCommands.length > 0
      ? input.verificationCommands.map((command) => `- ${command}`).join("\n")
      : "- run the configured deterministic verification commands";

  return [
    "Continue the previous implementation session.",
    "",
    "The review found this actionable issue:",
    "",
    `Severity: ${input.finding.severity}`,
    `Title: ${input.finding.title}`,
    `Detail: ${input.finding.detail}`,
    `Target: ${input.finding.target}`,
    "",
    "Fix this issue in the same worktree and preserve the existing design decisions.",
    "",
    "After the fix, ensure these verification commands pass:",
    commands,
    "",
    "Do not broaden the scope beyond this finding."
  ].join("\n");
}

export function buildFreshWorkPrompt(input: FreshWorkPromptInput): string {
  const commands =
    input.verificationCommands.length > 0
      ? input.verificationCommands.map((command) => `- ${command}`).join("\n")
      : "- run the configured deterministic verification commands";
  const findings = input.findings
    .map((finding, index) =>
      [
        `${index + 1}. ${finding.title}`,
        `   Severity: ${finding.severity}`,
        `   Detail: ${finding.detail}`,
        `   Target: ${finding.target}`,
        finding.target_session_id ? `   Target session: ${finding.target_session_id}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  return [
    "Continue the isolated implementation in a fresh worker session.",
    "",
    "The previous review found actionable issues, but the target worker session could not be resumed.",
    "",
    "Review findings:",
    findings,
    "",
    "Fix these issues in the same isolated worktree and preserve the existing design decisions.",
    "",
    "After the fix, ensure these verification commands pass:",
    commands,
    "",
    "Do not broaden the scope beyond these findings."
  ].join("\n");
}

export function planReviewContinuations(
  findings: ReviewFinding[],
  sessions: AgentSessionRecord[],
  verificationCommands: string[]
): ContinuationPlan[] {
  return findings.map((finding) => {
    if (!finding.target_session_id) {
      return {
        kind: "triage",
        finding,
        reason: "review finding does not identify a target worker session"
      };
    }

    const targetSession = sessions.find((session) => session.id === finding.target_session_id);
    if (!targetSession) {
      return {
        kind: "triage",
        finding,
        reason: `target worker session not found: ${finding.target_session_id}`
      };
    }

    if (!targetSession.resume_command) {
      return {
        kind: "triage",
        finding,
        targetSession,
        reason: `target worker session is not known to be resumable: ${finding.target_session_id}`
      };
    }

    return {
      kind: "resume_work",
      finding,
      targetSession,
      reason: `resume prior worker session ${finding.target_session_id}`,
      prompt: buildResumePrompt({ finding, verificationCommands })
    };
  });
}

export function createFindingRecord(input: {
  id: string;
  finding: ReviewFinding;
  sourceStateId: string;
  sourceReviewSessionId?: string;
  createdAt: string;
}): FindingRecord {
  return {
    id: input.id,
    status: "new",
    severity: input.finding.severity,
    title: input.finding.title,
    detail: input.finding.detail,
    target: input.finding.target,
    source_state_id: input.sourceStateId,
    ...(input.sourceReviewSessionId ? { source_review_session_id: input.sourceReviewSessionId } : {}),
    ...(input.finding.target_session_id
      ? { target_work_session_id: input.finding.target_session_id }
      : {}),
    created_at: input.createdAt
  };
}

export function createContinuationInboxItem(input: {
  id: string;
  findingId: string;
  plan: ContinuationPlan;
  promptArtifactId?: string;
  createdAt: string;
}): DecisionInboxItemRecord {
  if (input.plan.kind === "resume_work" && input.plan.targetSession?.resume_command) {
    return {
      id: input.id,
      status: "open",
      title: `Resume work: ${input.plan.finding.title}`,
      detail: input.plan.reason,
      finding_id: input.findingId,
      target_session_id: input.plan.targetSession.id,
      action: {
        kind: "resume_work",
        command: input.plan.targetSession.resume_command,
        prompt_artifact_id: input.promptArtifactId ?? ""
      },
      created_at: input.createdAt
    };
  }

  return {
    id: input.id,
    status: "open",
    title: `Triage finding: ${input.plan.finding.title}`,
    detail: input.plan.reason,
    finding_id: input.findingId,
    ...(input.plan.finding.target_session_id ? { target_session_id: input.plan.finding.target_session_id } : {}),
    action: {
      kind: "triage",
      reason: input.plan.reason
    },
    created_at: input.createdAt
  };
}

export async function appendReviewFindingsToRun(input: {
  run: WorkflowRunRecord;
  sourceStateId: string;
  sourceReviewSessionId?: string;
  findings: ReviewFinding[];
  verificationCommands: string[];
  now: string;
  nextId: (prefix: string) => string;
  writePromptArtifact: (content: string) => Promise<string>;
}): Promise<void> {
  const plans = planReviewContinuations(
    input.findings,
    input.run.agent_sessions,
    input.verificationCommands
  );

  for (const plan of plans) {
    const findingId = input.nextId("finding");
    const findingInput = {
      id: findingId,
      finding: plan.finding,
      sourceStateId: input.sourceStateId,
      createdAt: input.now
    };
    const finding = createFindingRecord(
      input.sourceReviewSessionId
        ? { ...findingInput, sourceReviewSessionId: input.sourceReviewSessionId }
        : findingInput
    );
    input.run.findings.push(finding);

    const inboxInput = {
      id: input.nextId("inbox"),
      findingId,
      plan,
      createdAt: input.now
    };

    if (plan.kind === "resume_work" && plan.prompt) {
      input.run.inbox.push(
        createContinuationInboxItem({
          ...inboxInput,
          promptArtifactId: await input.writePromptArtifact(plan.prompt)
        })
      );
    } else {
      input.run.inbox.push(createContinuationInboxItem(inboxInput));
    }
  }
}
