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

Tychonic core에는 built-in workflow가 없습니다. workflow는 설치형 bundle입니다.
참고용 예제는 `examples/workflows/` 아래에 있으며 명시적으로 설치해서 사용합니다.

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

예제 workflow bundle을 설치합니다.

```sh
(cd examples/workflows/simpleWorkflow && npm install)
tychonic workflows install ./examples/workflows/simpleWorkflow
```

한 terminal에서 local runtime을 시작합니다. 이 명령은 필요하면 Temporal을 시작하고
worker를 실행합니다.

```sh
tychonic runtime up --project-dir "$PWD"
```

다른 terminal에서 run을 시작합니다.

```sh
cat > ./simple-workflow-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

tychonic run simpleWorkflow --input-file ./simple-workflow-input.json --wait
```

`tychonic run --wait`는 JSON을 출력합니다. 제품 관점의 결과는
`result.status`입니다. CLI 명령 성공은 workflow가 결과를 반환했다는 뜻이지,
workflow 목표가 성공했다는 뜻은 아닙니다.

run 조회:

```sh
tychonic status --workflow-id <id> --include-result
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

## Workflow Config

workflow bundle은 `workflow.mjs`와 `defaultProfile`을 가집니다. 이 profile은
workflow author가 정한 기본 설정입니다. run마다 `--config <file>`로 대체할 수
있지만 merge가 아니라 whole-object replacement입니다.

workflow JSON input은 task data입니다. config를 `profile`에 넣지 마십시오.
`profile`은 Tychonic이 effective profile을 workflow code에 넘기기 위해 예약한
field입니다.

권장 profile pattern:

```yaml
version: tychonic.config.v1
states:
  work:
    type: work
    agent: codex
    model: gpt-5.5
    reasoning_effort: xhigh
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  review:
    type: review
    agent: claude
    model: opus
    reasoning_effort: max
```

재현 가능한 agent state에는 `model`을 지정하는 것을 권장합니다.
Claude/Codex state에서 품질이 reasoning 깊이에 좌우된다면 `reasoning_effort`도
권장 설정입니다. `resume`, permission, sandbox, timeout, trust, policy 같은
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
- `simpleWorkflow`: work, verify, review를 한 번씩 실행하는 기본 workflow
- `architectBuilderQaWorkflow`: architect / build / QA 표준 pattern
- `architectBuilderKiroQaWorkflow`: Kiro가 QA review를 수행하고 normalizer가 verdict를 구조화
- `architectBuilderKiroRepairQaWorkflow`: Kiro가 pre-review repair를 수행한 뒤 최종 QA로 넘기는 pattern

input이나 config shape를 바꾸기 전에 각 bundle의 `README.md`를 읽으십시오.

## Agent Skill

agent CLI가 Tychonic을 직접 다뤄야 하면 포함된 skill을 설치합니다.

```sh
npx skills add ./skills -a claude-code codex
```

`-a`를 의도적으로 지정하십시오. 생략하면 installer가 감지한 모든 agent에
설치할 수 있습니다.

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

- [SPEC.md](SPEC.md): 제품 contract
- [docs/plugin-workflows.md](docs/plugin-workflows.md): workflow authoring guide
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): agent-facing CLI operating guide
- [SECURITY.md](SECURITY.md): security boundary와 reporting
- [AGENTS.md](AGENTS.md): contributor/agent repository rules
- [GUARDRAILS.md](GUARDRAILS.md): 반복된 project-specific failure pattern
