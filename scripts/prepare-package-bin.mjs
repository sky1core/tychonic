import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const cliPath = join(process.cwd(), "dist", "cli", "main.js");
const fileStat = await stat(cliPath);
if (!fileStat.isFile()) {
  throw new Error(`package bin target is not a file: ${cliPath}`);
}

const prefix = await readFile(cliPath, { encoding: "utf8" }).then((source) => source.slice(0, 32));
if (!prefix.startsWith("#!/usr/bin/env node")) {
  throw new Error(`package bin target must start with a node shebang: ${cliPath}`);
}

await chmod(cliPath, 0o755);
