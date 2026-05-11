# Tychonic

[English README](README.md)

Tychonic은 macOS 로컬에서 위임형 AI 작업을 workflow로 실행하는 도구입니다.
기존 agent CLI와 결정적 검증 명령을 Temporal 위에서 실행하고, 나중에 추적할 수
있도록 실행 이력과 evidence를 남깁니다.

Tychonic은 coding agent, chat wrapper, dashboard, team service가 아닙니다.
Codex, Claude Code, Gemini CLI, Kiro CLI, shell check, review gate를 묶는
로컬 orchestration layer입니다.

## 왜 쓰는가

- 작업을 `work`, `verify`, `review` state로 명확하게 실행합니다.
- run 상태를 Temporal에 남겨 CLI 종료와 runtime 재시작 후에도 이어갈 수 있습니다.
- agent 작업은 격리된 worktree에서 실행하고, operator가 결과 적용 여부를 결정합니다.
- prompt, output, session, artifact, finding, inbox item을 evidence로 남깁니다.
- state마다 agent, model, reasoning effort를 다르게 지정할 수 있습니다.
- 품질, 비용, token 사용량에 맞춰 agent CLI와 model 계정을 나눠 쓸 수 있습니다.

Tychonic core에는 workflow module이 없습니다. workflow는 설치형 bundle입니다.
참고용 예제는 `examples/workflows/` 아래에 있으며, package에 포함돼 있어도
명시적으로 설치하기 전에는 실행 registry에 들어가지 않는 파일입니다.
참고용 예제는 workflow author가 자기 환경에 맞춰 조정하는 출발점입니다.
target 계정, model availability, plan/tier, 쿼터, 가격, region/country access,
organization policy가 operator마다 다르므로 Tychonic은 그대로 재사용할 하나의
기본 workflow profile을 제공하지 않습니다.

## 요구사항

- macOS
- Node.js 22+
- `PATH`에서 실행 가능한 Temporal CLI
- workflow가 사용할 agent CLI 설치 및 인증

Tychonic은 현재 public web UI/API surface를 제공하지 않습니다. CLI를 사용하십시오.

## 설치

source checkout에서 설치:

```sh
git clone https://github.com/sky1core/tychonic.git
cd tychonic
npm install
npm run build
npm run install:local
tychonic temporal doctor
```

npm으로 설치:

```sh
npm install -g tychonic
tychonic temporal doctor
```

## 빠른 시작

가장 작은 예제 workflow bundle부터 설치합니다. 이 workflow는 결정적 shell check만
실행하므로 agent CLI를 부르기 전에 runtime 경로부터 확인할 수 있습니다.
npm으로 설치했다면 `EXAMPLES_DIR="$(npm root -g)/tychonic/examples/workflows"`를
사용합니다. source checkout에서는 `EXAMPLES_DIR="./examples/workflows"`를
사용합니다.

```sh
# source checkout:
EXAMPLES_DIR="./examples/workflows"
# npm global install:
# EXAMPLES_DIR="$(npm root -g)/tychonic/examples/workflows"
tychonic workflows install "$EXAMPLES_DIR/verifyOnlyWorkflow"
tychonic workflows list
```

한 terminal에서 local runtime을 시작합니다. 이 명령은 필요하면 Temporal을 시작하고
worker를 실행합니다.

```sh
tychonic runtime up
```

foreground runtime은 `Ctrl-C`로 종료합니다. detached isolated runtime은 출력에
`stopCommand`가 들어 있으므로 그 명령으로 종료합니다.

다른 terminal에서 run을 시작합니다.

```sh
cat > ./verify-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo"
}
JSON

tychonic run verifyOnlyWorkflow --input-file ./verify-input.json --wait
```

input `cwd`는 검사할 git repository입니다. Tychonic source checkout일 필요는
없습니다.

`--wait`는 caller가 행동하거나 결과를 보고할 수 있는 다음 지점까지
기다립니다. 먼저 `message` field를 읽습니다. 이 문장은 사람이나 LLM
operator가 바로 이해할 수 있는 결과 설명입니다.

caller가 다른 일을 하기 전에 결과를 보고해야 하면 `--wait`를 사용합니다.
workflow를 시작해 두고 다른 일을 계속해야 하면 wait flag를 생략합니다.
no-wait 응답에는 나중에 `tychonic wait`에 넘길 `workflowId`가 들어 있습니다.

첫 smoke는 보통 이렇게 끝납니다.

```json
{ "ok": true, "message": "Workflow finished with status 'succeeded'. Inspect evidence with `tychonic status --workflow-id wf_123`.", "workflowId": "wf_123", "status": "succeeded" }
```

interactive workflow는 waiting state를 반환할 수도 있습니다.

```json
{ "ok": true, "message": "Workflow is waiting for input at state 'qa'. Inspect evidence with `tychonic status --workflow-id wf_123`; it lists inbox, artifacts, logs, and sessions. Then run `tychonic approve wf_123 --state qa`, `tychonic reject wf_123 --state qa --feedback \"<feedback>\"`, `tychonic modify wf_123 --state qa --note \"<note>\"`, or `tychonic rerun wf_123 --state qa --reason \"<reason>\"`.", "workflowId": "wf_123", "state": "qa" }
```

workflow를 시작만 하고 기다리지 않으려면 wait flag를 생략합니다.

```sh
tychonic run verifyOnlyWorkflow --input-file ./verify-input.json
```

no-wait 응답에는 나중에 사용할 handle이 들어 있습니다.

```json
{ "ok": true, "message": "Workflow started. To wait until it needs caller action or returns a result, run `tychonic wait wf_123`.", "workflowId": "wf_123", "runId": "run_456" }
```

이미 시작한 workflow를 나중에 기다리려면 반환된 `workflowId`를 넘깁니다.
응답에 `runId`도 들어 있을 수 있지만, 보통 후속 명령에는 `workflowId`를
사용합니다.

```sh
tychonic wait <workflow-id>
```

run 조회는 `status --workflow-id`부터 시작합니다. 이 출력에는 workflow
metadata, evidence summary, timing summary, artifact/log를 읽는 명령이 같이
들어 있습니다. 기본 출력은 full raw run record를 덤프하지 않습니다.

```sh
tychonic status --workflow-id <id>
```

특정 목록이나 raw content가 필요할 때만 focused command를 사용합니다.

```sh
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

`--workflow-id` 없이 `status`를 실행하면 최근 workflow 목록을 보여줍니다.
`--workflow-id`를 붙이면 다음 operator action을 판단하는 데 필요한 evidence를
반환합니다.

no-agent smoke가 통과한 뒤에는 `simpleWorkflow` 같은 agent workflow를 설치합니다.
그 workflow의 `defaultProfile`은 외부 agent CLI를 사용하고 `npm run typecheck`,
`npm run build`, `npm test`로 검증하므로, target repository에 해당 CLI와
script가 준비되어 있어야 합니다.
실행 전에 설치된 profile을 확인하십시오. `model` 또는 `reasoning_effort` 선택이
target 계정, model availability, plan/tier, 쿼터, 가격, region/country access,
organization policy와 맞지 않으면 whole-profile `--config <file>` replacement를
넘기십시오.

```sh
tychonic workflows install "$EXAMPLES_DIR/simpleWorkflow"
tychonic config show --workflow-name simpleWorkflow --format yaml
```

그 다음 task input으로 실행합니다.

```sh
cat > ./simple-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

tychonic run simpleWorkflow --input-file ./simple-input.json --wait
```

## Workflow Config

workflow bundle은 `workflow.mjs`와 `defaultProfile`을 가집니다. 이 profile은
workflow author가 정한 기본 설정입니다. run마다 `--config <file>`로 대체할 수
있지만 merge가 아니라 whole-object replacement입니다.

workflow JSON input은 task data입니다. config를 `profile`에 넣지 마십시오.
`profile`은 Tychonic이 effective profile을 workflow code에 넘기기 위해 예약한
field입니다.

workflow run input은 하나의 안정적인 task-shaped public contract를 씁니다:
필수 `cwd`, 선택 `goal`, 그리고 workflow가 state별 추가 지시를 명시적으로 지원할
때만 쓰는 선택 `promptAdditions`입니다. prompt 본문은 workflow code가
정의합니다. `promptAdditions` key는 effective profile에 존재하는 promptable
state NAME과 일치해야 합니다. top-level prompt field나 agent 이름을 input key로
쓰지 마십시오.

변경된 checkout에서 workflow를 실행하기 전에는 contract gate를 먼저 실행하십시오:

```sh
npm run check:contracts
```

`tychonic run`은 Temporal workflow를 만들기 전에 표준 workflow input 계약
(필수 `cwd`, 선택 `goal`, 선택 `promptAdditions`)을 검증합니다. workflow input이나
`--config` profile이 config schema와 맞지 않으면 Temporal 시작 전 실패합니다.

이 gate는 production config, workflow input, review, interaction validator를
호출합니다. 특정 workflow 실행이 성공했다는 증거를 대체하지는 않습니다.

environment-specific agent setting을 생략한 config shape:

```yaml
version: tychonic.config.v1
states:
  architect:
    type: work
    agent: claude
    permission_mode: plan
  builder:
    type: work
    agent: kiro
    trust_all_tools: true
    sandbox: workspace-write
    approval: never
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  qa:
    type: review
    agent: codex
    approval: never
```

workflow author는 target 계정, model availability, plan/tier, 쿼터, 가격,
region/country access, organization policy를 확인한 뒤에만 state별 `model`과
지원되는 `reasoning_effort`를 명시적으로 선택할 수 있습니다. 생략하면 선택된
CLI의 default 또는 auto-selection 동작에 맡깁니다. Claude exact versioned model
이름은 CLI가 보고한 model과 설정 문자열이 다르면 activity를 실패 처리합니다.
`opus` 같은 alias는 CLI가 내부에서 concrete model로 해석하므로 exact-match 검사
대상이 아닙니다.
Kiro model id는 Kiro CLI의 id이며 account, tier, region에 따라 availability가
달라질 수 있습니다. `kiro-cli chat --list-models` 결과는 현재 계정에서 실행
가능한 목록이지, 문서화된 모든 Kiro model id의 전역 존재 여부를 판단하는
목록이 아닙니다.
`resume`, permission, sandbox, timeout, trust, policy 같은
orchestration knob는 workflow 동작에 실제로 필요할 때만 사용합니다.

built-in adapter는 `agent: "<name>"`으로 선택합니다. `command`는 custom CLI,
특수 flag 조합, test stub 같은 escape hatch입니다. 하나의 state는 `agent`와
`command` 중 하나만 설정합니다.

## Built-In Agents

| Agent | Work | Review | Same-session resume |
|---|---:|---:|---:|
| `claude` | yes | yes | yes |
| `codex` | yes | yes | yes |
| `kiro` | yes | with normalizer | yes |
| `gemini` | yes | with normalizer | no |

`gemini`와 `kiro`를 review state의 primary agent로 쓰려면
`normalizer: claude` 또는 `normalizer: codex`가 필요합니다. primary agent가
review 판단을 하고, normalizer는 그 출력을 Tychonic review result로 구조화만
합니다.

Kiro는 ACP session API로 session capture와 resume을 처리합니다. Kiro review
state는 파일을 읽고 check를 실행할 수 있지만 code를 수정하면 안 됩니다.
adapter는 direct file write를 거부하고, review turn 동안 tracked file이 바뀌면
실패시킵니다.

## Example Workflows

- `verifyOnlyWorkflow`: agent 없이 runtime만 확인하는 smoke workflow
- `simpleWorkflow`: work, verify, review를 한 번씩 실행하는 단순 reference workflow
- `pipelineWorkflow`: 여러 stage와 반복된 `review` state를 보여주는 one-pass pipeline
- `checkpointWorkflow`: 고정 deterministic gate와 두 structured review를 실행하는 workflow
- `architectBuilderQaWorkflow`: Claude가 설계하고 Kiro가 build, Codex가 final QA 수행
- `architectBuilderFinalQaWorkflow`: Kiro-assisted build 뒤 Codex final QA 수행
- `architectBuilderFirstReviewQaWorkflow`: Claude가 설계하고 Kiro가 build와 1차 normalized review를 수행한 뒤 Codex final QA 수행
- `structuralIssueDiscoveryWorkflow`: deterministic contract check와 scoped Claude structural review, finding-audit gate를 실행하는 workflow

config shape나 `promptAdditions` state key를 바꾸기 전에 각 workflow
`README.md`를 읽으십시오.

## Agent Skill

CLI와 README가 기본 interface입니다. 포함된 skill은 Tychonic을 자주 다루는
agent를 위한 선택 보조수단입니다.

```sh
npx skills add ./skills -a claude-code -a codex --yes --global
```

`-a`를 의도적으로 지정하십시오. 생략하면 installer가 감지한 모든 agent에
설치할 수 있습니다. CLI 출력이 명확히 설명해야 할 동작을 skill에 의존시키지
마십시오.

## 보안

Tychonic은 단일 로컬 operator를 전제로 합니다. 현재 public control surface는
CLI입니다. 인증 없는 network service로 감싸서 노출하지 마십시오.

workflow command에 token, password, private key를 직접 넣지 마십시오. agent CLI의
auth store 또는 inherited environment reference를 사용하십시오.

macOS notification은 OS의 일반 notification permission을 사용합니다. 알림이
보이지 않으면 System Settings -> Notifications에서 `TychonicNotify`를 허용하십시오.
자세한 내용은
[notifications-troubleshooting.md](skills/tychonic-cli/notifications-troubleshooting.md)를
참조하십시오.

## 추가 문서

- [SPEC.md](SPEC.md): 제품 contract index와 module SPEC map
- [docs/plugin-workflows.md](docs/plugin-workflows.md): workflow authoring guide
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): agent-facing CLI operating guide
- [SECURITY.md](SECURITY.md): security boundary와 reporting
- [AGENTS.md](AGENTS.md): contributor/agent repository rules
- [GUARDRAILS.md](GUARDRAILS.md): 반복된 project-specific failure pattern
