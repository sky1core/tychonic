# verifyOnlyWorkflow

`verifyOnlyWorkflow` runs one deterministic `verify` state. It is the smallest
example for checking that bundle install, Temporal runtime execution, command
capture, artifacts, and final status work without calling an external AI agent.

## Purpose

Use this as the first runtime smoke reference. It has no external AI dependency
and proves the non-agent command path before adding agent or review states.
Inspect and adjust its YAML `verify.command` for the target repository.

## States

- `verify` — `verify`

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used for facts and command execution. |

Unknown fields are rejected. `cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/verifyOnlyWorkflow
tychonic runtime up
```

Then start a run:

```sh
cat > ./verify-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project"
}
JSON

tychonic run verifyOnlyWorkflow --input-file ./verify-input.json --wait
```

## Config

This example's YAML-derived profile runs a multi-line command:

```yaml
states:
  verify:
    type: verify
    command: |
      git status --short
      git diff --check
```

`--config <file>` replaces the bundle YAML-derived profile as one whole object. It
does not merge with the bundle default.
