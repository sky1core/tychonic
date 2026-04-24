import { describe, expect, it } from "vitest";
import { classifyChangedPath } from "../src/facts/gitFacts.js";
import { parseReviewOutput } from "../src/review/parse.js";

describe("ported git fact classification", () => {
  it("classifies docs, tests, frontend, and source paths", () => {
    expect(classifyChangedPath("docs/RUNTIME_MODES.md")).toContain("docs");
    expect(classifyChangedPath("src/foo.test.ts")).toContain("test");
    expect(classifyChangedPath("components/Button.tsx")).toEqual(
      expect.arrayContaining(["frontend", "source"])
    );
    expect(classifyChangedPath("src/bootstrap/simpleWorkflowRunner.ts")).toContain("source");
  });
});

describe("ported review parsing", () => {
  it("parses structured tychonic review JSON from mixed output", () => {
    const parsed = parseReviewOutput(`
noise
{"schema_version":"tychonic.review.v1","status":"fail","summary":"Found one","findings":[{"severity":"high","title":"Bug","detail":"Fix it","target":"src/index.ts"}]}
`);

    expect(parsed?.status).toBe("fail");
    expect(parsed?.findings[0]?.title).toBe("Bug");
  });

  it("returns undefined for non-JSON review output", () => {
    const parsed = parseReviewOutput("High: Missing verification\nDetail: Tests are not run");

    expect(parsed).toBeUndefined();
  });

  it("returns undefined when structured review JSON omits findings", () => {
    const parsed = parseReviewOutput(
      '{"schema_version":"tychonic.review.v1","status":"pass","summary":"ok"}'
    );

    expect(parsed).toBeUndefined();
  });
});
