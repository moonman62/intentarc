# Contributing to IntentArc

IntentArc is an early project. Bug reports, clearer documentation, and focused
pull requests are welcome. For a larger feature, open an issue first so we can
agree on the intended behavior.

## Development

Use Node.js 24 and pnpm 11.0.8. From your clone:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Follow the [README](README.md#try-it-from-source) to run the application, or the
[web interface guide](docs/web-interface.md#development-in-two-terminals) for
development with live reload.

Run tests relevant to your change:

```powershell
pnpm exec vitest run path/to/file.test.ts --maxWorkers=1
```

The full `pnpm test` suite is substantial and may take more than
30 minutes on Windows. Ordinary tests are separate from the explicitly gated
installed-client, signing, installer, and release acceptance commands; those
commands require their documented operator setup and affect the local machine.

Windows is the locally verified development platform. Reports from other
platforms are welcome, but current documentation does not claim verified macOS
or Linux runtime support.

## Issues and pull requests

Include what you expected, what happened, reproduction steps, and your OS,
Node.js version, and IntentArc commit. Use synthetic project data in examples.
For pull requests, explain the behavior changed and the checks you ran.

Do not attach your SQLite archive, backups, launch URL, profile tokens,
provider credentials, signing keys, or raw AI-client configuration to a public
issue or pull request. Redact private project content from logs and screenshots.

Keep changes focused and preserve the project's local authentication, review,
and outbound-context boundaries. See the linked guides in the README for these
contracts.
