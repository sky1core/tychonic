import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ignoredDirs = new Set([".git", ".tychonic", "dist", "legacy", "node_modules"]);
const textFilePattern = /\.(md|ts|tsx|json|ya?ml)$/;
const excludedTextFiles = new Set(["package-lock.json"]);

type TextFile = {
  path: string;
  text: string;
};

type ProjectFile = {
  absolute: string;
  path: string;
};

export type GuardrailRule = {
  id: string;
  description: string;
};

export type GuardrailViolation = {
  rule_id: string;
  path: string;
  message: string;
  pattern?: string;
};

export type GuardrailCheckResult = {
  ok: boolean;
  root: string;
  checked_files: number;
  rules: GuardrailRule[];
  violations: GuardrailViolation[];
};

type GuardrailCheckContext = {
  root: string;
  files: ProjectFile[];
  textFiles: TextFile[];
};

type GuardrailDefinition = GuardrailRule & {
  check: (context: GuardrailCheckContext) => Promise<GuardrailViolation[]>;
};

const rootDocRequirements: Array<{ path: string; text: string }> = [
  {
    path: "AGENTS.md",
    text: "Tychonic uses **Temporal only** for state management."
  },
  {
    path: "AGENTS.md",
    text:
      "The only source of truth for product state is Temporal workflow history and the Temporal API."
  },
  {
    path: "SPEC.md",
    text:
      "Non-TypeScript Temporal SDK bindings (Go, Python, Java) are not part\nof the current product path."
  },
  {
    path: "SPEC.md",
    text: "A workflow bundle's `config.yaml` is the **only** source of configuration"
  }
];

const rules: GuardrailDefinition[] = [
  {
    id: "active-product-path-typescript-only",
    description: "Active product files must stay on the TypeScript path.",
    check: async ({ files }) => {
      return files
        .filter(({ path }) => /(^|\/)(go\.(mod|sum)|.+\.go)$/.test(path))
        .map(({ path }) => ({
          rule_id: "active-product-path-typescript-only",
          path,
          message: "Non-TypeScript implementation files are not allowed in the active product path."
        }));
    }
  },
  {
    id: "active-docs-no-removed-runtime-alternatives",
    description: "Active docs must not revive removed runtime or language alternatives.",
    check: async ({ textFiles }) => {
      const files = textFiles.filter(({ path }) => {
        return path === "AGENTS.md" || path === "README.md" || path === "SPEC.md" || path.startsWith("docs/");
      });
      const forbidden = [
        new RegExp(`${joinText("fall", "back")}|${joinText("Fall", "back")}|\\uD3F4\\uBC31`),
        new RegExp(joinText("Re", "state")),
        new RegExp(`${joinText("Type", "Script")}/${joinText("Py", "thon")}/${joinText("G", "o")}`),
        new RegExp(`${joinText("G", "o")} also allowed`),
        new RegExp(joinText("TEMPORAL", "_LANGUAGE", "_REVIEW")),
        new RegExp(`${joinText("Sla", "ck")}|${joinText("Tele", "gram")}`),
        new RegExp(`${joinText("Ru", "st")}|${joinText("J", "VM")}|\\.${joinText("N", "ET")}`),
        new RegExp(joinText("workflow", " module", " manifest")),
        /Profiles\/manifests/,
        /Native workflow code/,
        new RegExp(joinText("Tychonic", " DB"))
      ];

      return findPatternViolations({
        ruleId: "active-docs-no-removed-runtime-alternatives",
        files,
        patterns: forbidden,
        message: "Active docs mention a removed runtime or language alternative."
      });
    }
  },
  {
    id: "product-code-no-repo-workflow-state-store",
    description: "Product code must not add repo-backed workflow state stores.",
    check: async ({ textFiles }) => {
      const files = textFiles.filter(({ path }) => path.startsWith("src/"));
      const forbidden = [
        new RegExp(joinText("File", "Run", "Store")),
        /run\.json/,
        new RegExp(`${["local", "run", "DB"].join(" ")}|${["local", "inbox", "DB"].join(" ")}`),
        new RegExp(
          `${["local", "session", "registry"].join(" ")}|${["local", "resume", "registry"].join(" ")}`
        ),
        new RegExp(
          `${["file", "lock"].join(" ")}|${["compare", "and", "swap"].join("-")}|${[
            "stale",
            "lock",
            "recovery"
          ].join(" ")}`
        )
      ];

      return findPatternViolations({
        ruleId: "product-code-no-repo-workflow-state-store",
        files,
        patterns: forbidden,
        message: "Product code mentions a repo-backed workflow state store."
      });
    }
  },
  {
    id: "root-docs-source-of-truth",
    description: "Root docs must keep source-of-truth guardrails explicit.",
    check: async ({ root }) => {
      const violations: GuardrailViolation[] = [];
      const cache = new Map<string, string | undefined>();
      const reportedMissingFiles = new Set<string>();

      for (const requirement of rootDocRequirements) {
        let text = cache.get(requirement.path);
        if (text === undefined && !cache.has(requirement.path)) {
          text = await readRequiredTextFile(root, requirement.path);
          cache.set(requirement.path, text);
        }

        if (text === undefined) {
          if (!reportedMissingFiles.has(requirement.path)) {
            violations.push({
              rule_id: "root-docs-source-of-truth",
              path: requirement.path,
              message: "Required source-of-truth document is missing."
            });
            reportedMissingFiles.add(requirement.path);
          }
          continue;
        }

        if (!text.includes(requirement.text)) {
          violations.push({
            rule_id: "root-docs-source-of-truth",
            path: requirement.path,
            message: `Required source-of-truth text is missing: ${requirement.text}`
          });
        }
      }

      return violations;
    }
  },
  {
    id: "config-schema-strictly-typed",
    description: "Config schemas must remain strict and must not silently accept unknown fields.",
    check: async ({ textFiles }) => {
      const files = textFiles.filter(({ path }) => path.startsWith("src/catalog/"));
      return findPatternViolations({
        ruleId: "config-schema-strictly-typed",
        files,
        patterns: [/\.passthrough\s*\(/],
        message: "Catalog config schemas must not use passthrough parsing."
      });
    }
  },
  {
    id: "config-shape-states-only",
    description: "Catalog schema files must not revive removed top-level config groups.",
    check: async ({ textFiles }) => {
      const files = textFiles.filter(({ path }) => path.startsWith("src/catalog/"));
      return findPatternViolations({
        ruleId: "config-shape-states-only",
        files,
        patterns: [
          /activity_timeouts/,
          /workflows.*slots/,
          /AgentRegistrationSchema/,
          /CommandsSchema/,
          /WorkSchema/,
          /ReviewSchema/
        ],
        message: "Catalog code mentions a removed profile, slot, command, or timeout schema."
      });
    }
  },
  {
    id: "no-profile-file-type",
    description: "The public surface must not revive workflow profile file types or flags.",
    check: async ({ textFiles }) => {
      const files = textFiles.filter(({ path }) =>
        path === "package.json" ||
        path === "README.md" ||
        path.startsWith("skills/") ||
        path.startsWith("examples/") ||
        path.startsWith("src/cli/") ||
        path.startsWith("src/catalog/")
      );
      return findPatternViolations({
        ruleId: "no-profile-file-type",
        files,
        patterns: [/tychonic\.profile\.v1/, /ProfileSchema/, /--profile/, /profiles:validate/],
        message: "Removed workflow profile file type or CLI profile flag is present."
      });
    }
  },
  {
    id: "release-verify-not-weakened",
    description:
      "package.json `verify` script must keep the full release gate; sandbox-safe checks belong in `verify:worker`.",
    check: async ({ textFiles }) => {
      const file = textFiles.find(({ path }) => path === "package.json");
      if (!file) {
        return [];
      }
      const verifyMatch = file.text.match(/"verify"\s*:\s*"([^"]+)"/);
      if (!verifyMatch) {
        return [
          {
            rule_id: "release-verify-not-weakened",
            path: "package.json",
            message: "package.json is missing the required `verify` release script."
          }
        ];
      }
      const body = verifyMatch[1] ?? "";
      const required = [
        "npm audit",
        "npm publish --dry-run",
        "npm run smoke:package"
      ];
      const missing = required.filter((fragment) => !body.includes(fragment));
      if (missing.length === 0) {
        return [];
      }
      return [
        {
          rule_id: "release-verify-not-weakened",
          path: "package.json",
          message: `package.json \`verify\` script is missing required release check(s): ${missing.join(", ")}.`
        }
      ];
    }
  }
];

export async function checkProjectGuardrails(options: { root?: string } = {}): Promise<GuardrailCheckResult> {
  const root = resolve(options.root ?? process.cwd());
  const files = await listProjectFiles(root);
  const textFiles = await readActiveTextFiles(files);
  const context: GuardrailCheckContext = { root, files, textFiles };
  const violations = (await Promise.all(rules.map((rule) => rule.check(context)))).flat();

  return {
    ok: violations.length === 0,
    root,
    checked_files: files.length,
    rules: rules.map(({ id, description }) => ({ id, description })),
    violations
  };
}

async function listProjectFiles(root: string): Promise<ProjectFile[]> {
  const files = await listFiles(root, root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function listFiles(root: string, dir: string): Promise<ProjectFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ProjectFile[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...(await listFiles(root, absolute)));
      }
      continue;
    }

    if (entry.isFile()) {
      files.push({ absolute, path: relative(root, absolute) });
    }
  }

  return files;
}

async function readActiveTextFiles(files: ProjectFile[]): Promise<TextFile[]> {
  const activeTextFiles = files
    .filter(({ path }) => textFilePattern.test(path))
    .filter(({ path }) => !excludedTextFiles.has(path));

  return Promise.all(
    activeTextFiles.map(async ({ absolute, path }) => ({
      path,
      text: await readFile(absolute, "utf8")
    }))
  );
}

function findPatternViolations(options: {
  ruleId: string;
  files: TextFile[];
  patterns: RegExp[];
  message: string;
}): GuardrailViolation[] {
  return options.patterns.flatMap((pattern) => {
    return options.files
      .filter(({ text }) => pattern.test(text))
      .map(({ path }) => ({
        rule_id: options.ruleId,
        path,
        message: options.message,
        pattern: pattern.source
      }));
  });
}

function joinText(...parts: string[]): string {
  return parts.join("");
}

async function readRequiredTextFile(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
