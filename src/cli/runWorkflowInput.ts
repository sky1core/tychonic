import { readFile } from "node:fs/promises";
import { parseBundleConfigYaml } from "../catalog/loadProfile.js";
import { TychonicConfigSchema, type TychonicConfig } from "../catalog/types.js";

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
 * Inject the workflow bundle's `defaultProfile` into the run input when
 * the user did not provide one of their own. Resolution order:
 *
 *  - User-supplied `input.profile` wins after schema validation (no merge).
 *  - When the user-supplied input is an object without a `profile` key,
 *    we attach the bundle's `defaultProfile` so the workflow runs with
 *    the author-default policies / states.
 *  - When the user passed no `--input` / `--input-file` at all, we
 *    synthesize `{ profile: defaultProfile }` so the workflow still
 *    starts with the author defaults instead of an empty input.
 *  - When the user-supplied input is a non-object value (e.g. a JSON
 *    array, primitive, or `null`), we leave it verbatim — `profile`
 *    is an object-valued field and a non-object input cannot accept
 *    one without changing shape.
 *
 * The `loadDefaultProfile` callback is called at most once and only when
 * the bundle's `defaultProfile` is needed, so callers that pass a valid
 * explicit `profile` never trigger a bundle lookup.
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
    return rawInput;
  }
  if (Object.prototype.hasOwnProperty.call(value, "profile")) {
    return {
      hasInput: true,
      input: { ...value, profile: validateExplicitInputProfile(value.profile) }
    };
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

function validateExplicitInputProfile(value: unknown): TychonicConfig {
  const parsed = TychonicConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`input.profile is not a valid tychonic.config.v1 profile: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Resolve the run workflow input considering an optional `--config <file>`
 * override and the bundle's `defaultProfile`.
 *
 *  - With `configPath`, the parsed YAML/JSON file becomes `input.profile`.
 *    If the user input also carried a top-level `profile` field, fail with a
 *    clear user-error message; we never silently merge the two sources.
 *  - Without `configPath`, fall back to the bundle's `defaultProfile`
 *    auto-load through `applyDefaultProfileToRunInput` (user-supplied
 *    `input.profile` still wins there after schema validation).
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
      throw new Error(
        "--config conflicts with input.profile from --input/--input-file; remove one"
      );
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
      throw new Error(
        "--config requires the workflow input to be a JSON object so the parsed profile can be attached to input.profile"
      );
    }
    return {
      hasInput: true,
      input: { ...rawInput.input, profile }
    };
  }

  return applyDefaultProfileToRunInput({ rawInput, loadDefaultProfile });
}
