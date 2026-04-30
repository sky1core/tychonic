# tychonicSelfCheckWorkflow

Developer-only bootstrap workflow for this repository.

This bundle is not a Tychonic core workflow and is not packaged for npm. Install
it explicitly from the source checkout when validating Tychonic changes.

## Purpose

Run the verification path that should not rely on an operator remembering every
manual step:

- repo verification (`npm run verify`)
- local package install and package smoke
- secret scan and whitespace diff check
- packaged example install/runtime smoke without per-example npm install
- live packaged example workflow smoke runs, including Claude/Codex/Kiro paths
- per-step and per-workflow timing evidence so model time and Tychonic
  orchestration time can be separated during diagnosis
- final documentation consistency checks for README/SPEC/CLI message drift

## Run

Run it from a source checkout that already has the normal project dependencies
installed.

```sh
tychonic workflows install ./tools/workflows/tychonicSelfCheckWorkflow
tychonic runtime up
tychonic run tychonicSelfCheckWorkflow --input-file ./self-check-input.json --wait
```

Input:

```json
{
  "cwd": "/absolute/path/to/tychonic"
}
```

Live scope is controlled on the runtime process:

- default: `TYCHONIC_BOOTSTRAP_LIVE_SCOPE=smoke`, which runs the smallest
  Claude/Codex/Kiro example set
- `TYCHONIC_BOOTSTRAP_LIVE_SCOPE=examples`: run every packaged example workflow
- `TYCHONIC_BOOTSTRAP_LIVE_SCOPE=none` or `TYCHONIC_BOOTSTRAP_LIVE_AGENTS=0`:
  skip external agent calls and run deterministic/package/runtime checks only

By default the bootstrap script prints one final JSON summary. Set
`TYCHONIC_BOOTSTRAP_VERBOSE=1` only when raw child process output is needed
during diagnosis.
