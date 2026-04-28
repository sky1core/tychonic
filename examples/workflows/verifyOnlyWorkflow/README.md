# verifyOnlyWorkflow

`verifyOnlyWorkflow` runs one deterministic `verify` state. It is the smallest
example for checking that bundle install, Temporal runtime execution, command
capture, artifacts, and final status work without calling an external AI agent.

## Purpose

Use this as the first runtime smoke example. It can run as-is in any git
repository and proves the non-agent command path before adding agent or review
states.

## States

- `verify` — `verify`

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used for facts and command execution. |

Unknown fields are rejected. `cwd` must be a git repository.

## Config

The default profile runs a multi-line command:

```yaml
states:
  verify:
    type: verify
    command: |
      git status --short
      git diff --check
```

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
