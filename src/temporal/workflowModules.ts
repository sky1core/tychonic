import { constants as fsConstants } from "node:fs";
import { cp, access, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Parser, type Node as AcornNode } from "acorn";
import { tychonicRuntimeDirs } from "./manager.js";
import { parseBundleConfigYaml } from "../catalog/loadProfile.js";
import type { TychonicConfig } from "../catalog/types.js";
import {
  normalizeBundleRequires,
  validateBundleFileShape,
  validateBundleRequires,
  type BundleRequires
} from "./bundleValidator.js";

export interface InstalledWorkflowModule {
  name: string;
  path: string;
  workflowPath: string;
  configPath: string;
}

export interface WorkflowBundleInspection {
  exportNames: string[];
  requires: BundleRequires;
}

const BUNDLE_WORKFLOW_FILE = "workflow.mjs";
const BUNDLE_CONFIG_FILE = "config.yaml";
const BUNDLE_README_FILE = "README.md";

/**
 * Absolute path of the packaged bundle root under the tychonic package's
 * `dist/workflow-bundles/` directory. Each immediate subdirectory under
 * this path is a bundle directory (see SPEC §Workflow Modules → Bundle
 * layout on disk).
 *
 * When `packageRoot` is omitted this resolves relative to the package
 * that owns the currently executing module. Callers that already know a
 * specific packaged CLI root should pass it explicitly so the packaged
 * bundle root follows that CLI, not the source checkout that happens to
 * be running the current process.
 */
export function packagedWorkflowBundleRoot(packageRoot?: string): string {
  return resolve(packageRoot ?? currentTychonicPackageRoot(), "dist", "workflow-bundles");
}

export async function resolveTychonicPackageRootFromCli(cliPath: string): Promise<string> {
  let dir = dirname(resolve(cliPath));
  while (dir !== dirname(dir)) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "tychonic") {
        return dir;
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    dir = dirname(dir);
  }
  throw new Error(`cannot locate tychonic package root for CLI path ${cliPath}`);
}

/**
 * Install a workflow bundle directory under
 * `<state>/workflows/modules/<name>/`. The source must be a directory
 * containing exactly `workflow.mjs` + `config.yaml` and optionally
 * `README.md` (see SPEC §Workflow Modules → Install-time validation).
 *
 * Validation runs fully before any copy: file shape, config schema,
 * workflow exports, requires cross-check, and cross-bundle export
 * conflicts. The copy is done to a sibling `<name>.incoming` directory
 * and then swapped into place so a worker-triggered reload never sees a
 * half-copied bundle.
 */
export async function installRuntimeWorkflowModule(options: {
  sourcePath: string;
}): Promise<InstalledWorkflowModule> {
  const sourcePath = resolve(options.sourcePath);
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`workflow bundle source does not exist: ${sourcePath}`);
    }
    throw error;
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`workflow bundle source is not a directory: ${sourcePath}`);
  }
  const name = safeWorkflowModuleName(basename(sourcePath));

  const entries = await readdir(sourcePath);
  validateBundleFileShape(entries);

  const configSourcePath = join(sourcePath, BUNDLE_CONFIG_FILE);
  const workflowSourcePath = join(sourcePath, BUNDLE_WORKFLOW_FILE);

  const configText = await readFile(configSourcePath, "utf8");
  const config = parseBundleConfigYaml(configText);

  const inspection = await inspectWorkflowModuleExports({ name, workflowPath: workflowSourcePath });
  assertBundleExportsWorkflowFunctionNamed(name, inspection.exportNames);
  validateBundleRequires({ requires: inspection.requires, config });

  const installedBundles = (await listRuntimeWorkflowModules()).filter((bundle) => bundle.name !== name);
  const installedWorkflowNames = new Set(installedBundles.map((bundle) => bundle.name));
  for (const existing of installedBundles) {
    const other = await inspectWorkflowModuleExports({ name: existing.name, workflowPath: existing.workflowPath });
    if (other.exportNames.includes(name)) {
      throw new Error(
        `workflow export name conflict: an installed bundle ${JSON.stringify(existing.name)} already exports ${JSON.stringify(name)}. ` +
          "Remove the conflicting bundle before installing this one."
      );
    }
  }
  for (const exportName of inspection.exportNames) {
    if (installedWorkflowNames.has(exportName) && exportName !== name) {
      throw new Error(
        `workflow export name conflict: bundle ${JSON.stringify(name)} exports ${JSON.stringify(exportName)} but an installed bundle already owns that workflow name. ` +
          "Rename the export in workflow.mjs before installing this bundle."
      );
    }
  }

  const targetRoot = runtimeWorkflowModulesDir();
  await mkdir(targetRoot, { recursive: true });
  const targetDir = join(targetRoot, name);
  const stagingDir = join(targetRoot, `${name}.incoming`);

  // Clear any stale staging directory from a previous failed install, then
  // copy the bundle tree into staging and swap it over the target. This
  // bounds the window where the target might be missing to the rename
  // itself; worker rebundling only happens at explicit restart so a
  // half-copied bundle is never observed during ordinary operation.
  await rm(stagingDir, { recursive: true, force: true });
  await cp(sourcePath, stagingDir, { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await rename(stagingDir, targetDir);

  return {
    name,
    path: targetDir,
    workflowPath: join(targetDir, BUNDLE_WORKFLOW_FILE),
    configPath: join(targetDir, BUNDLE_CONFIG_FILE)
  };
}

export async function listRuntimeWorkflowModules(): Promise<InstalledWorkflowModule[]> {
  const dir = runtimeWorkflowModulesDir();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
  const bundles: InstalledWorkflowModule[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".incoming")) continue;
    let safeName: string;
    try {
      safeName = safeWorkflowModuleName(entry.name);
    } catch {
      continue;
    }
    if (safeName !== entry.name) continue;
    const bundleDir = join(dir, entry.name);
    const workflowPath = join(bundleDir, BUNDLE_WORKFLOW_FILE);
    const configPath = join(bundleDir, BUNDLE_CONFIG_FILE);
    try {
      await access(workflowPath, fsConstants.R_OK);
      await access(configPath, fsConstants.R_OK);
    } catch {
      continue;
    }
    bundles.push({ name: entry.name, path: bundleDir, workflowPath, configPath });
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeRuntimeWorkflowModule(name: string): Promise<InstalledWorkflowModule> {
  const safeName = safeWorkflowModuleName(name);
  const bundleDir = join(runtimeWorkflowModulesDir(), safeName);
  try {
    await stat(bundleDir);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        `no installed workflow bundle named ${JSON.stringify(safeName)}. ` +
          `Run \`tychonic workflows list\` to list installed bundles.`
      );
    }
    throw error;
  }
  await rm(bundleDir, { recursive: true, force: false });
  return {
    name: safeName,
    path: bundleDir,
    workflowPath: join(bundleDir, BUNDLE_WORKFLOW_FILE),
    configPath: join(bundleDir, BUNDLE_CONFIG_FILE)
  };
}

export function runtimeWorkflowModulesDir(): string {
  return join(tychonicRuntimeDirs().stateDir, "workflows", "modules");
}

export function workflowModuleFileUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

export async function loadBundleConfigFromDisk(bundleDir: string): Promise<TychonicConfig> {
  const configText = await readFile(join(bundleDir, BUNDLE_CONFIG_FILE), "utf8");
  return parseBundleConfigYaml(configText);
}

export async function inspectBundle(bundle: { name: string; workflowPath: string }): Promise<WorkflowBundleInspection> {
  return inspectWorkflowModuleExports(bundle);
}

/**
 * Reject the case where two installed bundles would contribute the same
 * exported workflow function name. The invariant "bundle directory name
 * equals the single exported workflow function name" keeps this check to
 * the workflow-function exports only: bundle-private exports like
 * `requires` or helper utilities do not participate.
 *
 * Directory names are unique on the filesystem so two bundles cannot
 * share a name through that axis; the remaining failure mode is a bundle
 * that also exports a workflow function matching another bundle's name.
 * Installs already block that through
 * `assertBundleExportsWorkflowFunctionNamed`, so this check confirms the
 * invariant on the installed set as a defense in depth.
 */
export async function assertNoInstalledWorkflowExportConflicts(
  installedBundles?: InstalledWorkflowModule[]
): Promise<void> {
  const bundles = installedBundles ?? (await listRuntimeWorkflowModules());
  const inspections: Array<{ bundle: InstalledWorkflowModule; exportNames: string[] }> = [];
  for (const bundle of bundles) {
    const inspection = await inspectWorkflowModuleExports({
      name: bundle.name,
      workflowPath: bundle.workflowPath
    });
    inspections.push({ bundle, exportNames: inspection.exportNames });
  }
  const workflowNames = new Set(bundles.map((bundle) => bundle.name));
  const exportOwners = new Map<string, string[]>();
  for (const entry of inspections) {
    for (const exportName of entry.exportNames) {
      if (!workflowNames.has(exportName)) continue;
      const owners = exportOwners.get(exportName) ?? [];
      owners.push(entry.bundle.name);
      exportOwners.set(exportName, owners);
    }
  }
  const conflicts = [...exportOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  if (conflicts.length === 0) return;
  const details = conflicts
    .map(([exportName, owners]) => `${JSON.stringify(exportName)} from ${owners.map((owner) => JSON.stringify(owner)).join(", ")}`)
    .join("; ");
  throw new Error(
    `workflow bundle export conflict: installed bundles must not export the same workflow name. Conflicts: ${details}. ` +
      "Remove the duplicate bundle or rename the exported workflow."
  );
}

function currentTychonicPackageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", "..");
}

function basename(path: string): string {
  const resolved = resolve(path);
  const idx = Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\"));
  return idx < 0 ? resolved : resolved.slice(idx + 1);
}

function assertBundleExportsWorkflowFunctionNamed(bundleName: string, exportNames: string[]): void {
  if (!exportNames.includes(bundleName)) {
    throw new Error(
      `bundle directory name ${JSON.stringify(bundleName)} does not match any exported workflow function in workflow.mjs. ` +
        "The bundle's directory name must equal the exported workflow function name."
    );
  }
}

/**
 * Extract exported names and the `requires` value from `workflow.mjs` by
 * parsing it as an ES module AST — no staging directory, no
 * `node_modules` symlink, no child-process `import()`. This satisfies
 * AGENTS.md §16 by using a standard JavaScript parser instead of
 * imitating a deployed environment just to inspect static metadata.
 *
 * Constraints on what a bundle can declare:
 *  - Exports named via `export function`, `export async function`,
 *    `export class`, `export const|let|var <id>`, or `export { ... }`.
 *  - `export default` is ignored (bundles must export a named function
 *    whose name matches the bundle directory).
 *  - `requires` must be an object literal with JSON-like values
 *    (object / array / string / number / boolean / null /
 *    non-interpolated template literals). Any expression requiring
 *    runtime evaluation is rejected with a clear error.
 */
async function inspectWorkflowModuleExports(bundle: {
  name: string;
  workflowPath: string;
}): Promise<WorkflowBundleInspection> {
  const source = await readFile(bundle.workflowPath, "utf8");
  let ast: AcornNode;
  try {
    ast = Parser.parse(source, {
      sourceType: "module",
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true
    }) as AcornNode;
  } catch (error) {
    throw new Error(
      `failed to parse workflow bundle ${JSON.stringify(bundle.name)} at ${bundle.workflowPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const names = new Set<string>();
  let requiresRaw: unknown;
  let requiresFound = false;

  // acorn ast.body is Node[]. We use `any` locally for the walker —
  // acorn's TS types use generic estree unions that require extra casts
  // everywhere; this function owns the narrowing via shape checks.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const body = ((ast as unknown) as { body: any[] }).body;
  for (const node of body) {
    if (!node || typeof node !== "object") continue;
    if (node.type === "ExportDefaultDeclaration") continue;
    if (node.type !== "ExportNamedDeclaration") continue;
    if (node.declaration && node.declaration.type) {
      const decl = node.declaration;
      if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
        names.add(decl.id.name);
      } else if (decl.type === "VariableDeclaration") {
        for (const v of decl.declarations ?? []) {
          if (v.id && v.id.type === "Identifier") {
            names.add(v.id.name);
            if (v.id.name === "requires" && v.init) {
              requiresRaw = evalBundleStaticExpression(v.init, bundle);
              requiresFound = true;
            }
          }
        }
      }
    }
    if (Array.isArray(node.specifiers)) {
      for (const spec of node.specifiers) {
        if (spec.type === "ExportSpecifier" && spec.exported) {
          const exportedName =
            spec.exported.type === "Identifier"
              ? spec.exported.name
              : spec.exported.type === "Literal"
                ? String(spec.exported.value)
                : "";
          if (exportedName) names.add(exportedName);
        }
      }
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (!requiresFound) {
    throw new Error(
      `bundle ${JSON.stringify(bundle.name)} does not export a 'requires' object. Declare it in workflow.mjs per SPEC §Required state declaration.`
    );
  }
  const requires = normalizeBundleRequires(requiresRaw);
  const exportNames = [...names].sort((left, right) => left.localeCompare(right));
  return { exportNames, requires };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evalBundleStaticExpression(node: any, bundle: { name: string; workflowPath: string }): unknown {
  const fail = (reason: string): never => {
    throw new Error(
      `bundle ${JSON.stringify(bundle.name)} at ${bundle.workflowPath}: requires must be a JSON-literal object; ${reason}`
    );
  };
  if (!node || typeof node !== "object" || !node.type) fail("missing expression node");
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (Array.isArray(node.expressions) && node.expressions.length > 0)
        fail("template literal with interpolation is not supported");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (node.quasis as any[]).map((q) => q.value?.cooked ?? "").join("");
    case "ArrayExpression":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (node.elements as any[]).map((el) =>
        el === null ? null : evalBundleStaticExpression(el, bundle)
      );
    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const prop of node.properties as any[]) {
        if (!prop || prop.type !== "Property")
          fail(`unsupported property node type ${prop?.type ?? "(unknown)"}`);
        if (prop.computed) fail("computed property keys are not supported");
        let key: string;
        if (prop.key.type === "Identifier") key = prop.key.name;
        else if (prop.key.type === "Literal") key = String(prop.key.value);
        else return fail(`unsupported key node type ${prop.key.type}`);
        obj[key] = evalBundleStaticExpression(prop.value, bundle);
      }
      return obj;
    }
    case "UnaryExpression":
      if (node.operator === "-" && node.argument && node.argument.type === "Literal" &&
          typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      return fail(`unsupported unary expression ${node.operator}`);
    default:
      return fail(`unsupported expression node type ${node.type}`);
  }
}

function safeWorkflowModuleName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(
      `workflow bundle name ${JSON.stringify(value)} does not match ^[A-Za-z0-9][A-Za-z0-9_.-]*$`
    );
  }
  return value;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export const BUNDLE_FILE_NAMES = {
  workflow: BUNDLE_WORKFLOW_FILE,
  config: BUNDLE_CONFIG_FILE,
  readme: BUNDLE_README_FILE
} as const;
