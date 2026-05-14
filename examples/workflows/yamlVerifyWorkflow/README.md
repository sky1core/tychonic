# yamlVerifyWorkflow

`yamlVerifyWorkflow` is the minimal declarative workflow example. Its source of
truth is `workflow.yaml`; install validates the YAML and generates the Temporal
`workflow.mjs` wrapper plus `workflow.generated.mmd` graph preview in the
installed bundle.

## States

| State | TYPE | Transition |
| --- | --- | --- |
| `verify` | `verify` | pass -> finish, fail -> finish |

## Install

```sh
tychonic workflows validate ./examples/workflows/yamlVerifyWorkflow
tychonic workflows install ./examples/workflows/yamlVerifyWorkflow
```

## Run

```sh
cat > ./yaml-verify-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo"
}
JSON

tychonic run yamlVerifyWorkflow --input-file ./yaml-verify-input.json --wait
```
