export interface InlineSecretMatch {
  key: string;
  kind: "env_assignment" | "flag";
}

const SECRET_KEY_PATTERN = /(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN)/i;
const ENV_ASSIGNMENT_PATTERN = /(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/g;
const QUOTED_ENV_ASSIGNMENT_PATTERN = /(?:^|[\s;])(["'])([A-Za-z_][A-Za-z0-9_]*)=([^"']*)\1/g;
const SECRET_FLAG_PATTERN =
  /(?:^|\s)(--(?:api-key|access-key|private-key|auth-token|token|secret|password))(?:=|\s+)("[^"]*"|'[^']*'|[^\s]+)/gi;

export function findInlineSecrets(command: string): InlineSecretMatch[] {
  const matches: InlineSecretMatch[] = [];
  for (const match of command.matchAll(ENV_ASSIGNMENT_PATTERN)) {
    const key = match[1] ?? "";
    const value = unquote(match[2] ?? "");
    if (SECRET_KEY_PATTERN.test(key) && isLiteralSecretValue(value)) {
      matches.push({ key, kind: "env_assignment" });
    }
  }
  for (const match of command.matchAll(QUOTED_ENV_ASSIGNMENT_PATTERN)) {
    const key = match[2] ?? "";
    const value = match[3] ?? "";
    if (SECRET_KEY_PATTERN.test(key) && isLiteralSecretValue(value)) {
      matches.push({ key, kind: "env_assignment" });
    }
  }
  for (const match of command.matchAll(SECRET_FLAG_PATTERN)) {
    const key = match[1] ?? "";
    const value = unquote(match[2] ?? "");
    if (isLiteralSecretValue(value)) {
      matches.push({ key, kind: "flag" });
    }
  }
  return matches;
}

export function hasInlineSecrets(command: string): boolean {
  return findInlineSecrets(command).length > 0;
}

export function assertNoInlineSecrets(command: string, label: string): void {
  const matches = findInlineSecrets(command);
  if (matches.length === 0) {
    return;
  }
  const keys = [...new Set(matches.map((match) => match.key))].join(", ");
  throw new Error(
    `${label} must not contain inline secret values (${keys}); use external CLI auth or inherited environment references`
  );
}

function isLiteralSecretValue(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed && !trimmed.startsWith("$") && !trimmed.startsWith("${"));
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
