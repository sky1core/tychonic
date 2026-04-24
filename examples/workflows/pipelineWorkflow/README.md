# pipelineWorkflow

A 7-stage operator-supplied workflow bundle that demonstrates installing a
custom workflow through `tychonic workflows install`. The workflow uses two
states of the `review` TYPE (`review_1` and `review_2`) so it doubles as a
reference for the NAME/TYPE contract in SPEC §State Identity And Activity
TYPE.

## States declared

- `work` — `work`
- `static` — `lint`
- `unit` — `unit_test`
- `review_1` — `review`
- `integration` — `integration`
- `review_2` — `review`
- `security` — `verify`

## Install

```sh
tychonic workflows install ./examples/workflows/pipelineWorkflow
```

The install command also replaces the local LaunchAgent worker when the
service is installed.

## Run

Start through `tychonic run pipelineWorkflow --input-file ./input.json`
(see `docs/plugin-workflows.md` for the input shape) or through
`@temporalio/client` for fully custom input.

## Remove

```sh
tychonic workflows remove pipelineWorkflow
```
