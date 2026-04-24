import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExecutableSearchPath,
  findExecutable,
  TYCHONIC_AGENT_PATH_ENV
} from "../src/system/executables.js";

describe("executable resolver", () => {
  it("finds user-local CLIs without relying on a shell startup PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "tychonic-executable-home-"));
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeExecutable(join(bin, "codex"));

    await expect(findExecutable("codex", { HOME: home, PATH: "" })).resolves.toBe(join(bin, "codex"));
  });

  it("uses explicit Tychonic agent paths before ambient PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-executable-agent-path-"));
    const explicitBin = join(root, "explicit");
    const ambientBin = join(root, "ambient");
    await mkdir(explicitBin);
    await mkdir(ambientBin);
    await writeExecutable(join(explicitBin, "claude"));
    await writeExecutable(join(ambientBin, "claude"));

    const env = {
      HOME: root,
      PATH: ambientBin,
      [TYCHONIC_AGENT_PATH_ENV]: explicitBin
    };

    expect(buildExecutableSearchPath(env)[0]).toBe(explicitBin);
    await expect(findExecutable("claude", env)).resolves.toBe(join(explicitBin, "claude"));
  });
});

async function writeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}
