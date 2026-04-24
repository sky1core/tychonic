# Security Policy

Tychonic `0.1.x` is a macOS single-user local alpha.

The local Web API is unauthenticated and includes mutation endpoints for inbox
execution, session registration, and session resume. It is loopback-only by
default. `--allow-network-bind` permits trusted private-network experiments, but
it does not add authentication. Do not expose the Web API to untrusted networks.

Do not place tokens, passwords, or private keys in workflow profile commands,
resume commands, or activity commands. Commands may be recorded in Temporal
history and artifacts. Keep credentials in each external agent CLI's auth store
or inherited environment.

Unsupported in public alpha:

- public or shared-network Web API exposure
- multi-user or multi-tenant deployment
- shared remote/team Temporal deployments
- organization worker pools
- secrets proxying or credential brokering
- browser or API access by untrusted users

Report vulnerabilities through GitHub private vulnerability reporting:

```text
https://github.com/sky1core/tychonic/security/advisories/new
```

Do not file public issues for vulnerabilities. If private vulnerability
reporting is disabled, the repository is not ready for public release.
