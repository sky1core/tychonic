import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ChangedFileFact {
  path: string;
  status: string;
  categories: string[];
}

export interface RunFacts {
  changed_files: ChangedFileFact[];
  has_changes: boolean;
  has_source: boolean;
  only_docs: boolean;
  tests_changed: boolean;
  frontend_changed: boolean;
  docs_changed: boolean;
  test_command?: string;
}

export interface GitFactsResult {
  facts: RunFacts;
  diff_stat: string;
}

export async function collectGitFacts(cwd: string): Promise<GitFactsResult> {
  const changedFiles = await changedFilesForRepo(cwd);
  let diffStat = await runGitBestEffort(cwd, ["diff", "--stat", "HEAD"]);
  if (!diffStat.trim()) {
    diffStat = await runGitBestEffort(cwd, ["diff", "--stat"]);
  }

  const facts: RunFacts = {
    changed_files: changedFiles,
    has_changes: changedFiles.length > 0,
    has_source: changedFiles.some((file) => file.categories.includes("source")),
    only_docs: changedFiles.length > 0 && changedFiles.every((file) => file.categories.includes("docs")),
    tests_changed: changedFiles.some((file) => file.categories.includes("test")),
    frontend_changed: changedFiles.some((file) => file.categories.includes("frontend")),
    docs_changed: changedFiles.some((file) => file.categories.includes("docs"))
  };

  return { facts, diff_stat: diffStat };
}

export function changedFilesJSON(files: ChangedFileFact[]): string {
  return `${JSON.stringify(files, null, 2)}\n`;
}

export function detectTestCommand(cwd: string, fileExists: (path: string) => boolean): string | undefined {
  if (fileExists(`${cwd}/go.mod`)) {
    return "go test ./...";
  }
  if (fileExists(`${cwd}/package.json`)) {
    return "npm test";
  }
  if (fileExists(`${cwd}/pyproject.toml`)) {
    return "pytest";
  }
  return undefined;
}

async function changedFilesForRepo(cwd: string): Promise<ChangedFileFact[]> {
  const status = await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (!status) {
    return [];
  }

  const seen = new Map<string, ChangedFileFact>();
  const parts = status.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) {
      continue;
    }

    const code = entry.slice(0, 2).trim();
    let path = entry.slice(3).replaceAll("\\", "/");
    if ((entry.startsWith("R ") || entry.startsWith("C ")) && index + 1 < parts.length) {
      index += 1;
    }
    if (path.startsWith(".tychonic/")) {
      continue;
    }

    seen.set(path, {
      path,
      status: code,
      categories: classifyChangedPath(path)
    });
  }

  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function classifyChangedPath(path: string): string[] {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  const ext = extname(lower);
  const categories: string[] = [];

  if (
    lower === "readme.md" ||
    lower === "agents.md" ||
    lower === "claude.md" ||
    lower === "spec.md" ||
    lower.startsWith("docs/") ||
    [".md", ".txt", ".adoc", ".rst"].includes(ext)
  ) {
    categories.push("docs");
  }

  if (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.endsWith("_test.go") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".test.tsx") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".spec.tsx") ||
    lower.endsWith(".spec.js")
  ) {
    categories.push("test");
  }

  if ([".html", ".css", ".scss", ".sass", ".less", ".tsx", ".jsx", ".vue", ".svelte"].includes(ext)) {
    categories.push("frontend");
  }
  if (
    lower.startsWith("app/") ||
    lower.startsWith("pages/") ||
    lower.startsWith("components/") ||
    lower.startsWith("src/ui/")
  ) {
    addIfMissing(categories, "frontend");
  }

  if (
    [".go", ".rs", ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".rb", ".php"].includes(
      ext
    ) &&
    !categories.includes("test")
  ) {
    categories.push("source");
  }

  if (categories.length === 0) {
    categories.push("other");
  }
  return categories;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

async function runGitBestEffort(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGit(cwd, args);
  } catch {
    return "";
  }
}

function addIfMissing(items: string[], item: string): void {
  if (!items.includes(item)) {
    items.push(item);
  }
}
