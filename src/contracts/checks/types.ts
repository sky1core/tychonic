export interface ContractCheck {
  area: string;
  name: string;
  run(): void | Promise<void>;
}

export interface ContractCheckResult {
  area: string;
  name: string;
  ok: boolean;
  error?: string;
}

export function expectAccept(name: string, fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    throw new Error(`${name} should accept input: ${errorMessage(error)}`);
  }
}

export function expectReject(name: string, fn: () => unknown, expected?: RegExp): void {
  try {
    fn();
  } catch (error) {
    const message = errorMessage(error);
    if (expected && !expected.test(message)) {
      throw new Error(`${name} rejected with unexpected error: ${message}`);
    }
    return;
  }
  throw new Error(`${name} should reject input`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
