# Security Policy

Tychonic is a macOS single-user local alpha.

Tychonic currently exposes the CLI as its public control surface. Do not wrap
the CLI or runtime in an unauthenticated network service.

Do not place tokens, passwords, or private keys in workflow or activity
commands. Commands may be recorded in Temporal history and artifacts. Keep
credentials in each external agent CLI's auth store or inherited environment.

Unsupported in public alpha:

- public or shared-network unauthenticated control surfaces
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
