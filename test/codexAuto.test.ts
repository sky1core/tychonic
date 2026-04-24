import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCheckpoint } from "../src/bootstrap/checkpointRunner.js";

const execFileAsync = promisify(execFile);

describe("Codex auto review adapter", () => {
  it.skip("uses codex exec JSONL events and records a resumable session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-codex-auto-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "app.ts"), "export const value = 1;\n", "utf8");

    const fakeBin = join(cwd, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outIndex = args.indexOf('--output-last-message');",
        "const review = {schema_version:'tychonic.review.v1', status:'pass', summary:'fake codex pass', findings:[]};",
        "if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], JSON.stringify(review));",
        "console.log(JSON.stringify({session:{id:'019da0d1-2a9e-7183-9e1a-459daf6765ea'}}));",
        "console.log(JSON.stringify({assistant:{text:JSON.stringify(review)}}));",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(fakeBin, "codex"), 0o755);

    const profilePath = join(cwd, "profile.tychonic.yaml");
    await writeFile(
      profilePath,
      [
        "version: tychonic.config.v1",
        "states:",
        "  semantic_review:",
        "    type: review",
        "    agent: codex",
        "    command: codex --sandbox read-only --ask-for-approval never exec --skip-git-repo-check --json -",
        "    emits:",
        "      - tychonic.review.v1",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runCheckpoint({
      cwd,
      profilePath,
      runId: "run_codex_auto",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`
      },
      commandTimeoutMs: 10_000
    });

    const session = result.run.agent_sessions[0];

    expect(result.run.states.find((step) => step.name === "semantic_review")?.status).toBe("succeeded");
    expect(session?.external_session_id).toBe("019da0d1-2a9e-7183-9e1a-459daf6765ea");
    expect(session?.resume_command).toContain("exec resume --skip-git-repo-check --json");
  });
});
