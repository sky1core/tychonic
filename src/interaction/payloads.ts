import type {
  ArtifactRecord,
  FindingRecord,
  WorkflowStateStatus
} from "../domain/types.js";
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  TERMINAL_WORKFLOW_STATE_STATUSES
} from "../domain/types.js";
import type {
  InteractionApproveStatePayload,
  InteractionModifyStatePayload,
  InteractionRerunStatePayload,
  InteractionRejectStatePayload,
  StateRecordPatch
} from "../temporal/types.js";

export type ParsedPayload<T> = { ok: true; payload: T } | { ok: false; reason: string };

export const INTERACTION_MODIFY_TERMINAL_STATUSES = TERMINAL_WORKFLOW_STATE_STATUSES;

export function parseInteractionApprovePayload(payload: unknown): ParsedPayload<InteractionApproveStatePayload> {
  const payloadObject = parseStrictObject(payload, ["state"], "approve payload");
  if (!payloadObject.ok) return payloadObject;
  const state = payloadObject.value.state;
  if (typeof state !== "string" || state.length === 0) {
    return { ok: false, reason: "approve payload state must be a non-empty string" };
  }
  return { ok: true, payload: { state } };
}

export function parseInteractionRejectPayload(payload: unknown): ParsedPayload<InteractionRejectStatePayload> {
  const payloadObject = parseStrictObject(payload, ["state", "feedback"], "reject payload");
  if (!payloadObject.ok) return payloadObject;
  const state = payloadObject.value.state;
  if (typeof state !== "string" || state.length === 0) {
    return { ok: false, reason: "reject payload state must be a non-empty string" };
  }
  const feedback = payloadObject.value.feedback;
  if (typeof feedback !== "string" || feedback.length === 0) {
    return { ok: false, reason: "reject payload feedback must be a non-empty string" };
  }
  return { ok: true, payload: { state, feedback } };
}

export function parseInteractionModifyPayload(payload: unknown): ParsedPayload<InteractionModifyStatePayload> {
  const payloadObject = parseStrictObject(payload, ["state", "patch"], "modify payload");
  if (!payloadObject.ok) return payloadObject;
  const state = payloadObject.value.state;
  if (typeof state !== "string" || state.length === 0) {
    return { ok: false, reason: "modify payload state must be a non-empty string" };
  }
  const patch = payloadObject.value.patch;
  try {
    validateStateRecordPatch(patch, "modify payload patch");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, payload: { state, patch } };
}

export function parseInteractionRerunPayload(payload: unknown): ParsedPayload<InteractionRerunStatePayload> {
  const payloadObject = parseStrictObject(payload, ["state", "reason"], "rerun payload");
  if (!payloadObject.ok) return payloadObject;
  const state = payloadObject.value.state;
  if (typeof state !== "string" || state.length === 0) {
    return { ok: false, reason: "rerun payload state must be a non-empty string" };
  }
  const reason = payloadObject.value.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    return { ok: false, reason: "rerun payload reason must be a non-empty string when present" };
  }
  return {
    ok: true,
    payload: {
      state,
      ...(reason !== undefined ? { reason } : {})
    }
  };
}

export function validateStateRecordPatch(
  patch: unknown,
  label = "modifyState patch"
): asserts patch is StateRecordPatch {
  if (!isPlainObject(patch)) {
    throw new Error(`${label} must be a StateRecordPatch object`);
  }
  const patchObject = patch;
  rejectUnknownKeys(
    patchObject,
    ["status", "reason", "note", "artifacts", "findings"],
    label
  );
  if (Object.keys(patchObject).length === 0) {
    throw new Error(`${label} must set at least one field`);
  }
  if (
    patchObject.status !== undefined &&
    !(INTERACTION_MODIFY_TERMINAL_STATUSES as readonly WorkflowStateStatus[]).includes(
      patchObject.status as WorkflowStateStatus
    )
  ) {
    throw new Error(
      `${label}.status must be terminal (one of ${INTERACTION_MODIFY_TERMINAL_STATUSES.join(", ")}), got '${String(patchObject.status)}'`
    );
  }
  if (
    patchObject.reason !== undefined &&
    (typeof patchObject.reason !== "string" || patchObject.reason.trim() === "")
  ) {
    throw new Error(`${label}.reason must be a non-empty string`);
  }
  if (
    patchObject.note !== undefined &&
    (typeof patchObject.note !== "string" || patchObject.note.trim() === "")
  ) {
    throw new Error(`${label}.note must be a non-empty string`);
  }
  if (patchObject.artifacts !== undefined) {
    validateArtifactRecords(patchObject.artifacts, `${label}.artifacts`);
  }
  if (patchObject.findings !== undefined) {
    validateFindingRecords(patchObject.findings, `${label}.findings`);
  }
}

function validateArtifactRecords(value: unknown, label: string): asserts value is ArtifactRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must contain at least one artifact`);
  }
  value.forEach((item, index) => {
    const artifact = requirePlainObject(item, `${label}.${index}`);
    rejectUnknownKeys(
      artifact,
      ["id", "kind", "path", "created_at", "state_id", "activity_attempt_id"],
      `${label}.${index}`
    );
    requireStringField(artifact, "id", `${label}.${index}`);
    requireStringField(artifact, "kind", `${label}.${index}`);
    requireStringField(artifact, "path", `${label}.${index}`);
    requireStringField(artifact, "created_at", `${label}.${index}`);
    optionalStringField(artifact, "state_id", `${label}.${index}`);
    optionalStringField(artifact, "activity_attempt_id", `${label}.${index}`);
  });
}

function validateFindingRecords(value: unknown, label: string): asserts value is FindingRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must contain at least one finding`);
  }
  value.forEach((item, index) => {
    const finding = requirePlainObject(item, `${label}.${index}`);
    rejectUnknownKeys(
      finding,
      [
        "id",
        "status",
        "severity",
        "title",
        "detail",
        "target",
        "source_state_id",
        "source_review_session_id",
        "target_work_session_id",
        "created_at"
      ],
      `${label}.${index}`
    );
    requireStringField(finding, "id", `${label}.${index}`);
    requireEnumField(finding, "status", FINDING_STATUSES, `${label}.${index}`);
    requireEnumField(finding, "severity", FINDING_SEVERITIES, `${label}.${index}`);
    requireStringField(finding, "title", `${label}.${index}`);
    requireStringField(finding, "detail", `${label}.${index}`);
    optionalStringField(finding, "target", `${label}.${index}`);
    requireStringField(finding, "source_state_id", `${label}.${index}`);
    optionalStringField(finding, "source_review_session_id", `${label}.${index}`);
    optionalStringField(finding, "target_work_session_id", `${label}.${index}`);
    requireStringField(finding, "created_at", `${label}.${index}`);
  });
}

function parseStrictObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${label} must be an object` };
  }
  const extraKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (extraKey !== undefined) {
    return { ok: false, reason: `${label}.${extraKey} is not allowed` };
  }
  return { ok: true, value };
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const extraKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (extraKey !== undefined) {
    throw new Error(`${label}.${extraKey} is not allowed`);
  }
}

function requireStringField(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
}

function optionalStringField(value: Record<string, unknown>, key: string, label: string): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    throw new Error(`${label}.${key} must be a string`);
  }
}

function requireEnumField<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  label: string
): void {
  if (!allowed.includes(value[key] as T)) {
    throw new Error(`${label}.${key} must be one of ${allowed.join(", ")}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
