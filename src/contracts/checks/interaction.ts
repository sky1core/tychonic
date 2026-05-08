import {
  parseInteractionApprovePayload,
  parseInteractionModifyPayload,
  parseInteractionRejectPayload,
  validateStateRecordPatch
} from "../../interaction/payloads.js";
import type { ContractCheck } from "./types.js";
import { expectAccept, expectReject } from "./types.js";

export const interactionContractChecks: readonly ContractCheck[] = [
  {
    area: "interaction",
    name: "accepts standard approve and reject payloads",
    run() {
      const approve = parseInteractionApprovePayload({ state: "work" });
      if (!approve.ok || approve.payload.state !== "work") {
        throw new Error("approve payload was rejected");
      }
      const reject = parseInteractionRejectPayload({ state: "work", feedback: "retry with tests" });
      if (!reject.ok || reject.payload.feedback !== "retry with tests") {
        throw new Error("reject payload was rejected");
      }
    }
  },
  {
    area: "interaction",
    name: "rejects extra interaction payload keys",
    run() {
      const parsed = parseInteractionApprovePayload({ state: "work", note: "typo" });
      if (parsed.ok || !/note is not allowed/.test(parsed.reason)) {
        throw new Error("approve payload with extra key was not rejected");
      }
    }
  },
  {
    area: "interaction",
    name: "accepts a non-empty modify patch",
    run() {
      const parsed = parseInteractionModifyPayload({
        state: "work",
        patch: { status: "failed", reason: "operator decision" }
      });
      if (!parsed.ok || parsed.payload.patch.status !== "failed") {
        throw new Error("modify payload was rejected");
      }
    }
  },
  {
    area: "interaction",
    name: "rejects empty modify patches",
    run() {
      expectReject(
        "empty modify patch",
        () => validateStateRecordPatch({}, "modifyState patch"),
        /must set at least one field/
      );
    }
  },
  {
    area: "interaction",
    name: "rejects unknown StateRecordPatch keys",
    run() {
      expectReject(
        "unknown patch key",
        () => validateStateRecordPatch({ status: "failed", summary: "typo" }, "modifyState patch"),
        /summary is not allowed/
      );
    }
  },
  {
    area: "interaction",
    name: "rejects no-op StateRecordPatch values",
    run() {
      expectReject(
        "empty note patch",
        () => validateStateRecordPatch({ note: "" }, "modifyState patch"),
        /note must be a non-empty string/
      );
      expectReject(
        "empty artifacts patch",
        () => validateStateRecordPatch({ artifacts: [] }, "modifyState patch"),
        /artifacts must contain at least one artifact/
      );
      expectReject(
        "empty findings patch",
        () => validateStateRecordPatch({ findings: [] }, "modifyState patch"),
        /findings must contain at least one finding/
      );
    }
  },
  {
    area: "interaction",
    name: "rejects malformed artifact records",
    run() {
      expectReject(
        "malformed artifact",
        () =>
          validateStateRecordPatch(
            {
              artifacts: [
                {
                  id: "artifact_1",
                  kind: "note",
                  path: ".tychonic/a.txt"
                }
              ]
            },
            "modifyState patch"
          ),
        /created_at must be a non-empty string/
      );
    }
  },
  {
    area: "interaction",
    name: "rejects malformed finding records",
    run() {
      expectReject(
        "malformed finding",
        () =>
          validateStateRecordPatch(
            {
              findings: [
                {
                  id: "finding_1",
                  status: "new",
                  severity: "major",
                  title: "x",
                  detail: "d",
                  source_state_id: "review",
                  created_at: "2026-01-01T00:00:00Z"
                }
              ]
            },
            "modifyState patch"
          ),
        /severity must be one of/
      );
    }
  },
  {
    area: "interaction",
    name: "accepts well-formed artifact and finding patches",
    run() {
      expectAccept("artifact and finding patch", () =>
        validateStateRecordPatch(
          {
            artifacts: [
              {
                id: "artifact_1",
                kind: "note",
                path: ".tychonic/runs/run_1/artifacts/note.txt",
                created_at: "2026-01-01T00:00:00Z"
              }
            ],
            findings: [
              {
                id: "finding_1",
                status: "new",
                severity: "high",
                title: "Missing test",
                detail: "The changed path has no regression test.",
                source_state_id: "review",
                created_at: "2026-01-01T00:00:00Z"
              }
            ]
          },
          "modifyState patch"
        )
      );
    }
  }
] as const;
