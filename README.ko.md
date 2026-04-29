# Tychonic

[English README](README.md)

Tychonic은 macOS 로컬에서 위임형 AI 작업을 운영하기 위한 work-ops
manager입니다. 기존 agent CLI와 결정적 검증 명령을 Temporal workflow로
실행하고, prompt, output, session, artifact, finding, inbox evidence를 남깁니다.

Tychonic은 coding agent, chat wrapper, dashboard, team service가 아닙니다.
Codex, Claude Code, Gemini CLI, Kiro CLI, shell check, review command 같은
도구를 workflow 상태 머신으로 묶는 로컬 실행 계층입니다.

## 하는 일

- Temporal을 통해 workflow run 상태가 CLI 종료와 runtime 재시작 후에도 남습니다.
- agent 작업은 workflow가 만든 격리 worktree 안에서 수행됩니다.
- 각 workflow state가 필요한 built-in agent 또는 command를 선택합니다.
- prompt, output, session, artifact, finding, inbox item을 evidence로 기록합니다.
- 안정적인 resume surface를 제공하는 built-in adapter에 한해 같은 session resume을 지원합니다.

Tychonic core는 host-owned workflow를 포함하지 않습니다. 예제 bundle은
`examples/workflows/` 아래에 있으며, 필요할 때 명시적으로 설치해서 사용합니다.

## 요구사항

- macOS
- Node.js 22+
- `PATH`에서 실행 가능한 Temporal CLI
- 사용할 agent CLI 설치 및 인증

local Web API에는 login이 없습니다. 신뢰할 수 없는 네트워크에 노출하지 마십시오.

## 설치

소스에서 실행:

```sh
git clone https://github.com/sky1core/tychonic.git
cd tychonic
npm install
npm run build
node dist/cli/main.js --help
node dist/cli/main.js temporal doctor
```

로컬 package-style 설치:

```sh
npm run install:local
tychonic --help
tychonic temporal doctor
```

전역 package 설치:

```sh
npm install -g tychonic
tychonic --help
tychonic temporal doctor
```

소스에서 실행할 때는 예시의 `tychonic`을 `node dist/cli/main.js`로 바꿔 사용합니다.

## 빠른 시작

예제 workflow bundle을 설치하고 runtime을 시작합니다.

```sh
npm install
npm run build
(cd examples/workflows/simpleWorkflow && npm install)
node dist/cli/main.js workflows install ./examples/workflows/simpleWorkflow
node dist/cli/main.js runtime up --project-dir "$PWD"
```

다른 terminal에서 run을 시작합니다.

```sh
cat > ./simple-workflow-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

node dist/cli/main.js run simpleWorkflow --input-file ./simple-workflow-input.json --wait
```

각 workflow는 자신의 input shape, policy key, artifact, recovery flow를
직접 정의합니다. non-trivial input 또는 config를 작성하기 전에 해당 bundle의
`README.md`를 읽으십시오.

agent 없이 runtime smoke만 하려면 `examples/workflows/verifyOnlyWorkflow`를
설치합니다. architect / builder / QA 패턴은 `architectBuilderQaWorkflow`에서
시작하고, Kiro가 review 또는 pre-review repair를 맡아야 할 때 Kiro variant를
사용합니다.

자주 쓰는 조회 명령:

```sh
tychonic status --workflow-id <id> --include-result
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

## Agent Skill

agent CLI가 Tychonic을 안정적으로 사용할 수 있도록 포함된 skill을 설치합니다.

```sh
npx skills add ./skills -a claude-code codex
```

`-a`를 의도적으로 지정하십시오. 생략하면 installer가 감지한 모든 agent에
설치할 수 있습니다.

## Workflow와 Config

workflow bundle은 `workflow.mjs`와 `defaultProfile`을 가진 directory입니다.
`defaultProfile`은 workflow author가 정한 기본 config입니다. run마다
`--config <file>`로 전체 대체할 수 있지만 merge는 없습니다.

workflow JSON input은 task data입니다. `profile`을 넣지 마십시오. `profile`은
Tychonic이 effective config를 workflow code에 전달하기 위해 예약한 내부 field입니다.

최소 profile shape:

```yaml
version: tychonic.config.v1
states:
  work:
    type: work
    agent: codex
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  review:
    type: review
    agent: claude
```

재현 가능한 agent workflow라면 agent state에 `model`을 지정하는 것을 권장합니다.
Claude/Codex state에서 품질이 reasoning 깊이에 좌우된다면 `reasoning_effort`도
권장 설정입니다. 반대로 `resume`, permission, sandbox, timeout, trust, policy
같은 orchestration knob는 workflow 동작에 실제로 필요할 때만 추가합니다.

bundle 검증과 설치:

```sh
tychonic workflows validate ./examples/workflows/simpleWorkflow
tychonic workflows install ./examples/workflows/simpleWorkflow
tychonic workflows list
```

## Agents

Built-in adapter:

| Agent | Worker | Review | Same-session resume |
|---|---:|---:|---:|
| `claude` | yes | yes | yes |
| `codex` | yes | yes | yes |
| `kiro` | yes | with normalizer | yes |
| `gemini` | yes | with normalizer | no |

일반 경로는 `agent: "<name>"`입니다. `command`는 custom CLI, 특수 flag 조합,
test stub 같은 non-default scenario를 위한 escape hatch입니다. executable state는
`agent`와 `command` 중 하나만 설정합니다.

`gemini`와 `kiro` review state는 `normalizer: claude` 또는 `normalizer: codex`가
필요합니다. primary agent가 review 판단을 수행하고, normalizer는 그 출력을
semantic review payload로 구조화합니다. workflow config는 normalizer model을
따로 설정하지 않습니다.

`kiro`는 ACP session API를 사용합니다. worker session capture와 resume은
`session/new` / `session/load`를 통해 처리합니다. Kiro review state는 파일을
읽고 check를 실행할 수 있지만 code를 수정하면 안 됩니다. adapter는 direct file
write를 거부하고, review turn 동안 tracked file이 바뀌면 실패시킵니다.

CLI가 지원하는 built-in agent state에는 `model`을 지정할 수 있고, 재현성이나
품질 목표가 있으면 지정하는 것을 권장합니다. `reasoning_effort`는 `claude`와
`codex`에만 지원되며, Claude/Codex state의 품질이 reasoning 깊이에 좌우되면
설정하는 것을 권장합니다. Kiro는 현재 `--model`은 지원하지만 안정적인
reasoning/effort/thinking CLI option을 제공하지 않으므로 `reasoning_effort`를
설정하지 마십시오.

## 보안

Tychonic은 단일 로컬 operator를 전제로 합니다. local Web API는 loopback에 묶어
두십시오. 별도 보안 조치 없이 `0.0.0.0`, public IP, shared network에 bind하지
마십시오.

workflow command에 token, password, private key를 직접 넣지 마십시오. agent CLI의
auth store 또는 inherited environment reference를 사용하십시오.

macOS notification은 OS의 일반 notification permission을 사용합니다. 알림이
보이지 않으면 System Settings → Notifications에서 `TychonicNotify`를 허용하십시오.
자세한 내용은
[notifications-troubleshooting.md](skills/tychonic-cli/notifications-troubleshooting.md)를
참조하십시오.

## 추가 문서

- [SPEC.md](SPEC.md): 제품 contract
- [docs/plugin-workflows.md](docs/plugin-workflows.md): workflow authoring guide
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): agent-facing CLI guide
- [skills/tychonic-cli/notifications-troubleshooting.md](skills/tychonic-cli/notifications-troubleshooting.md): macOS notification troubleshooting
- [SECURITY.md](SECURITY.md): security boundary와 reporting
- [AGENTS.md](AGENTS.md): contributor/agent repository rules
- [GUARDRAILS.md](GUARDRAILS.md): 반복된 project-specific failure pattern
