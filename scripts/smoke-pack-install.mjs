import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tmp = await mkdtemp(join(tmpdir(), "tychonic-pack-smoke-"));

try {
  const { stdout: packStdout } = await execFileAsync("npm", ["pack", "--pack-destination", tmp], {
    cwd: root,
    encoding: "utf8"
  });
  const tarball = join(tmp, packStdout.trim().split(/\r?\n/).at(-1));
  const app = join(tmp, "app");
  await execFileAsync("npm", ["install", "--prefix", app, tarball, "--omit=dev"], { encoding: "utf8" });
  const bin = join(app, "node_modules", ".bin", process.platform === "win32" ? "tychonic.cmd" : "tychonic");
  const { stdout: version } = await execFileAsync(bin, ["--version"], { encoding: "utf8" });
  if (!/^\d+\.\d+\.\d+/.test(version.trim())) {
    throw new Error(`unexpected tychonic --version output: ${version}`);
  }
  await execFileAsync(bin, ["--help"], { encoding: "utf8" });
  console.log(JSON.stringify({ ok: true, version: version.trim() }, null, 2));
} finally {
  await rm(tmp, { recursive: true, force: true });
}
