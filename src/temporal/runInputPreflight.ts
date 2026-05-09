import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BUNDLE_RUN_INPUT_FILE = "runInput.mjs";

export async function assertWorkflowRunInputValidator(options: {
  workflowName: string;
  bundleDir: string;
}): Promise<void> {
  await loadWorkflowRunInputValidator(options);
}

export async function validateInstalledWorkflowRunInput(options: {
  workflowName: string;
  bundleDir: string;
  input: unknown;
}): Promise<void> {
  const validateRunInput = await loadWorkflowRunInputValidator(options);
  try {
    await validateRunInput(options.input);
  } catch (error) {
    throw new Error(
      `workflow ${options.workflowName} preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function loadWorkflowRunInputValidator(options: {
  workflowName: string;
  bundleDir: string;
}): Promise<(input: unknown) => unknown> {
  const validatorPath = join(options.bundleDir, BUNDLE_RUN_INPUT_FILE);
  try {
    await stat(validatorPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        `workflow bundle ${JSON.stringify(options.workflowName)} is missing ${BUNDLE_RUN_INPUT_FILE}; ` +
          "reinstall or update the bundle before running it"
      );
    }
    throw error;
  }

  let mod: unknown;
  try {
    mod = await import(pathToFileURL(validatorPath).href);
  } catch (error) {
    throw new Error(
      `failed to load ${BUNDLE_RUN_INPUT_FILE} for workflow ${JSON.stringify(options.workflowName)}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }

  const validateRunInput = (mod as { validateRunInput?: unknown }).validateRunInput;
  if (typeof validateRunInput !== "function") {
    throw new Error(
      `workflow bundle ${JSON.stringify(options.workflowName)} ${BUNDLE_RUN_INPUT_FILE} must export validateRunInput(input)`
    );
  }
  return validateRunInput as (input: unknown) => unknown;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
