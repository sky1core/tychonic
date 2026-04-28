import { z } from "zod";

export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  target: z.string().min(1).optional(),
  // Agents (notably Codex) commonly emit `target_session_id: ""` as a
  // placeholder when the finding is not tied to a resumable session.
  // Normalize empty string to `undefined` on input so callers reading
  // `.target_session_id` see "absent" uniformly, and the `.min(1)`
  // guarantee still holds for any present value.
  target_session_id: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  )
});

export const ReviewResultSchema = z
  .object({
    schema_version: z.literal("tychonic.review.v1"),
    status: z.enum(["pass", "fail"]),
    summary: z.string().min(1),
    findings: z.array(ReviewFindingSchema)
  })
  .superRefine((value, context) => {
    if (value.status === "pass" && value.findings.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "pass review results must not contain findings",
        path: ["findings"]
      });
    }

    if (value.status === "fail" && value.findings.length === 0) {
      context.addIssue({
        code: "custom",
        message: "fail review results must contain at least one finding",
        path: ["findings"]
      });
    }
  });

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export function parseReviewResult(raw: unknown): ReviewResult {
  return ReviewResultSchema.parse(raw);
}
