import type { AgentSessionRecord, ArtifactRecord } from "../domain/types.js";
import type { ReviewResult } from "./schema.js";

export type ParsedReviewResult = ReviewResult;

/**
 * 4-way outcome of one review-body invocation. Pins the contract in SPEC
 * §Finding and inbox routing. `artifacts` and `agentSessions` carry full
 * records (not ids) because the caller appends them to `run.artifacts` and
 * `run.agent_sessions`; the body never mutates `input.run` itself.
 *
 * `reviewerSessionId`, when present, equals the `id` of one record in
 * `agentSessions` — the session that produced the reviewer output — and is
 * the authoritative source for `Finding.source_review_session_id` when the
 * caller appends findings for a `fail` verdict.
 */
export type ReviewActivityOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "command_failed"; status: "failed" | "timed_out"; exitCode?: number }
  | {
      kind: "unparseable";
      detail: string;
      reviewerSessionId?: string;
      artifacts: ArtifactRecord[];
      agentSessions: AgentSessionRecord[];
    }
  | {
      kind: "parsed";
      result: ParsedReviewResult;
      reviewerSessionId: string;
      artifacts: ArtifactRecord[];
      agentSessions: AgentSessionRecord[];
    };
