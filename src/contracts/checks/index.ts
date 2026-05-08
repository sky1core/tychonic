import { configContractChecks } from "./config.js";
import { interactionContractChecks } from "./interaction.js";
import { reviewContractChecks } from "./review.js";
import type { ContractCheck, ContractCheckResult } from "./types.js";
import { errorMessage } from "./types.js";
import { workflowInputContractChecks } from "./workflowInput.js";

export type { ContractCheck, ContractCheckResult } from "./types.js";

export const contractChecks: readonly ContractCheck[] = [
  ...configContractChecks,
  ...workflowInputContractChecks,
  ...reviewContractChecks,
  ...interactionContractChecks
] as const;

export async function runContractChecks(
  checks: readonly ContractCheck[] = contractChecks
): Promise<ContractCheckResult[]> {
  const results: ContractCheckResult[] = [];
  for (const check of checks) {
    try {
      await check.run();
      results.push({
        area: check.area,
        name: check.name,
        ok: true
      });
    } catch (error) {
      results.push({
        area: check.area,
        name: check.name,
        ok: false,
        error: errorMessage(error)
      });
    }
  }
  return results;
}

export function formatContractCheckResults(results: readonly ContractCheckResult[]): string {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return `contract checks passed (${results.length})`;
  }
  return [
    `contract checks failed (${failed.length}/${results.length})`,
    ...failed.map((result) => `- [${result.area}] ${result.name}: ${result.error ?? "unknown error"}`)
  ].join("\n");
}
