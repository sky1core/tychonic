import { readFile } from "node:fs/promises";
import { parseBundleConfigYaml } from "../catalog/loadProfile.js";
import type { TychonicConfig } from "../catalog/types.js";

/**
 * Result of resolving the input that `tychonic run <workflow>` will hand
 * to Temporal.
 *
 * `hasInput=false` means the caller must omit the `input` field entirely
 * when starting the workflow. `hasInput=true` carries the resolved JSON
 * value (which may itself be `null` if the user explicitly passed `null`).
 */
export interface ResolvedRunWorkflowInput {
  hasInput: boolean;
  input?: unknown;
}

/**
 * Inject the effective profile into the run input. `profile` is reserved for
 * Tychonic's internal config handoff to the workflow:
 *
 *  - User-supplied `input.profile` is rejected. Use `--config <file>` to
 *    replace the bundle default profile for one run.
 *  - Object input receives the bundle's `defaultProfile`.
 *  - No input becomes `{ profile: defaultProfile }`.
 *  - Non-object input is rejected because the effective profile must be
 *    injected into an object input.
 *
 * The `loadDefaultProfile` callback is called at most once and only when
 * the bundle's `defaultProfile` is needed.
 */
export async function applyDefaultProfileToRunInput(options: {
  rawInput: ResolvedRunWorkflowInput;
  loadDefaultProfile: () => Promise<TychonicConfig>;
}): Promise<ResolvedRunWorkflowInput> {
  const { rawInput, loadDefaultProfile } = options;

  if (!rawInput.hasInput) {
    const defaultProfile = await loadDefaultProfile();
    return { hasInput: true, input: { profile: defaultProfile } };
  }

  const value = rawInput.input;
  if (!isPlainObject(value)) {
    throw workflowInputObjectError();
  }
  if (Object.prototype.hasOwnProperty.call(value, "profile")) {
    throw reservedInputProfileError();
  }
  const defaultProfile = await loadDefaultProfile();
  return {
    hasInput: true,
    input: { ...value, profile: defaultProfile }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  return true;
}

function reservedInputProfileError(): Error {
  return new Error(
    "input.profile is reserved for Tychonic config injection; pass --config <file> to replace the bundle defaultProfile"
  );
}

function workflowInputObjectError(): Error {
  return new Error("workflow input must be a JSON object");
}

/**
 * Resolve the run workflow input considering an optional `--config <file>`
 * override and the bundle's `defaultProfile`.
 *
 *  - With `configPath`, the parsed YAML/JSON file becomes the internal
 *    `input.profile` value passed to the workflow.
 *  - If the user input carried a top-level `profile` field, fail with a clear
 *    user-error message. Raw input never owns the config carrier.
 *  - Without `configPath`, fall back to the bundle's `defaultProfile`
 *    auto-load through `applyDefaultProfileToRunInput`.
 *
 * The `loadDefaultProfile` callback is invoked only on the no-config branch
 * and only when the bundle profile is actually needed — passing `--config`
 * never triggers a bundle lookup.
 */
export async function applyConfigOrDefaultProfileToRunInput(options: {
  rawInput: ResolvedRunWorkflowInput;
  configPath?: string;
  loadDefaultProfile: () => Promise<TychonicConfig>;
}): Promise<ResolvedRunWorkflowInput> {
  const { rawInput, configPath, loadDefaultProfile } = options;

  if (configPath !== undefined) {
    if (
      rawInput.hasInput &&
      isPlainObject(rawInput.input) &&
      Object.prototype.hasOwnProperty.call(rawInput.input, "profile")
    ) {
      throw reservedInputProfileError();
    }
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      throw new Error(
        `failed to read --config ${configPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    let profile: TychonicConfig;
    try {
      profile = parseBundleConfigYaml(raw);
    } catch (error) {
      throw new Error(
        `--config ${configPath} is not a valid tychonic.config.v1 file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!rawInput.hasInput) {
      return { hasInput: true, input: { profile } };
    }
    if (!isPlainObject(rawInput.input)) {
      throw workflowInputObjectError();
    }
    return {
      hasInput: true,
      input: { ...rawInput.input, profile }
    };
  }

  return applyDefaultProfileToRunInput({ rawInput, loadDefaultProfile });
}
