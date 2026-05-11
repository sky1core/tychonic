import { validateTaskWorkflowInput } from "../inputValidation.js";

export function validateWorkflowRunInput(input: unknown): void {
  validateTaskWorkflowInput(input);
}
