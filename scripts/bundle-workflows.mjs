// Emits one bundle directory per product workflow under
// `dist/workflow-bundles/<name>/`. Each bundle contains:
//   - workflow.mjs — esbuild output of the workflow's compiled TypeScript
//     entry point (including the `requires` export).
//   - config.yaml — copied from `workflows/<name>/config.yaml`.
//   - README.md   — copied from `workflows/<name>/README.md` when present.
//
// `@temporalio/workflow` stays external — the worker's webpack hook
// resolves it from the tychonic package's own node_modules at bundle
// time.
import { build } from "esbuild";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const workflowsRoot = resolve(projectRoot, "workflows");
const compiledRoot = resolve(projectRoot, "dist/workflows");
const bundlesRoot = resolve(projectRoot, "dist/workflow-bundles");

const bundleNames = ["simpleWorkflow", "checkpointWorkflow", "selfRepairWorkflow"];

// Map bundle name → compiled source entry point. `checkpointWorkflow` lives in
// `checkpoint.ts` for historical reasons.
const entryPointFor = (name) => {
  if (name === "checkpointWorkflow") {
    return resolve(compiledRoot, "checkpoint.js");
  }
  return resolve(compiledRoot, `${name}.js`);
};

await mkdir(bundlesRoot, { recursive: true });

for (const name of bundleNames) {
  const entry = entryPointFor(name);
  if (!existsSync(entry)) {
    throw new Error(`bundle-workflows: compiled entry not found for ${name}: ${entry}`);
  }
  const staticDir = resolve(workflowsRoot, name);
  const configPath = resolve(staticDir, "config.yaml");
  const readmePath = resolve(staticDir, "README.md");
  if (!existsSync(configPath)) {
    throw new Error(`bundle-workflows: missing config.yaml for ${name}: ${configPath}`);
  }

  const outDir = resolve(bundlesRoot, name);
  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, "workflow.mjs");

  await build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["@temporalio/workflow"],
    legalComments: "none",
    logLevel: "info"
  });

  await copyFile(configPath, resolve(outDir, "config.yaml"));
  if (existsSync(readmePath)) {
    const info = await stat(readmePath);
    if (info.isFile()) {
      await copyFile(readmePath, resolve(outDir, "README.md"));
    }
  }

  console.log(`bundled workflow ${name} → ${outDir}`);
}
