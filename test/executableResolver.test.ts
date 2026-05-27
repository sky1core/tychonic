import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExecutableSearchPath,
  findExecutable,
  TYCHONIC_AGENT_PATH_ENV
} from "../src/bootstrap/executables.js";

describe("executable resolver", () => {
  it("does not search user-local CLI directories unless they are explicit", async () => {
    const home = await mkdtemp(join(tmpdir(), "tychonic-executable-home-"));
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeExecutable(join(bin, "codex"));

    await expect(findExecutable("codex", { HOME: home, PATH: "" })).resolves.toBeUndefined();
    await expect(findExecutable("codex", { HOME: home, PATH: bin })).resolves.toBe(join(bin, "codex"));
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

  it("does not treat executable directories as executable files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-executable-directory-"));
    const bin = join(root, "bin");
    await mkdir(join(bin, "openp"), { recursive: true });
    await chmod(join(bin, "openp"), 0o755);

    await expect(findExecutable("openp", { HOME: root, PATH: bin })).resolves.toBeUndefined();
  });

  it("does not treat legacy per-executable env vars as executable configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-executable-legacy-env-"));
    const legacyBin = join(root, "legacy");
    const ambientBin = join(root, "ambient");
    await mkdir(legacyBin);
    await mkdir(ambientBin);
    await writeExecutable(join(legacyBin, "openp"));
    const ambientOpenp = join(ambientBin, "openp");
    await writeExecutable(ambientOpenp);

    const env = {
      HOME: root,
      PATH: ambientBin,
      TYCHONIC_OPENP_PATH: join(legacyBin, "openp")
    };

    expect(buildExecutableSearchPath(env)[0]).toBe(ambientBin);
    await expect(findExecutable("openp", env)).resolves.toBe(ambientOpenp);
  });
});

async function writeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}
