import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseDeclarativeWorkflowSpecYaml,
  type DeclarativeWorkflowSpec
} from "../src/declarative/workflowSpec.js";

export const EXAMPLE_WORKFLOW_NAMES = [
  "simpleWorkflow",
  "checkpointWorkflow",
  "pipelineWorkflow",
  "architectBuilderQaWorkflow",
  "architectBuilderFinalQaWorkflow",
  "architectBuilderFirstReviewQaWorkflow",
  "verifyOnlyWorkflow",
  "structuralIssueDiscoveryWorkflow",
  "yamlVerifyWorkflow"
] as const;

export type ExampleWorkflowName = typeof EXAMPLE_WORKFLOW_NAMES[number];

export async function loadExampleWorkflowSpec(name: ExampleWorkflowName): Promise<DeclarativeWorkflowSpec> {
  const source = await readFile(join(process.cwd(), "examples", "workflows", name, "workflow.yaml"), "utf8");
  return parseDeclarativeWorkflowSpecYaml({ bundleName: name, source });
}
