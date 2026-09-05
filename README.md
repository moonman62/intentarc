# IntentArc

IntentArc keeps your project's decisions, tasks, and documentation in one local
archive, so you can carry useful context between AI tools without starting over.
Review proposed changes, explore your project's structure, and choose exactly
what context to share. You can also use it without an AI connection.

This is an early source release under the [MIT license](LICENSE). Windows is
the locally tested platform; macOS and Linux runtime behavior has not been
verified. A signed Windows installer is not available yet.

## Try it from source

Install Git, Node.js 24, and pnpm 11.0.8. In PowerShell:

```powershell
git clone https://github.com/moonman62/intentarc.git
cd intentarc
pnpm install --frozen-lockfile
pnpm build
node dist/web/bin.js --db "$env:LOCALAPPDATA/IntentArc-source/project.intentarc.sqlite"
```

Open the local URL printed in the terminal. It contains your session credential,
so keep it private. Your project data stays in the local SQLite archive at the
path above. Stop the server with `Ctrl+C`.

Dependency build scripts are permitted only for `better-sqlite3` (SQLite) and
`esbuild` (build tooling), as configured in `pnpm-workspace.yaml`.

The browser interface supports project work and context export. Desktop AI
connection setup requires the desktop application. No signing certificate is
needed to build and run the browser interface from source.

## What you can do

- Keep project knowledge, decisions, tasks, and evidence in one local archive.
- Review proposed changes before they become authoritative project knowledge.
- Import an existing repository through a local scan and editable proposal.
- Explore the Project Map and repository documentation.
- Prepare, inspect, and release task context for an AI client, or export it as
  Markdown for a browser chat.
- Back up, verify, and restore your project archive.

IntentArc does not execute AI-provider requests, automatically launch agents,
or sync your archive to a hosted team service. Repository scanning does not
execute the scanned code. Outbound review helps detect sensitive content but
cannot guarantee that every sensitive value will be found.

## CLI and MCP

After building, inspect the CLI without opening a database:

```powershell
node dist/cli/bin.js --help
```

The standalone MCP server uses stdio and requires an absolute archive path:

```powershell
$env:INTENTARC_DB_PATH = "$env:LOCALAPPDATA/IntentArc-source/project.intentarc.sqlite"
node dist/mcp/bin.js
```

Read [client setup](docs/client-setup.md) before connecting a client. Anonymous
MCP access exposes project metadata only; authenticated context access follows
the review and release workflow.

## Windows desktop development

```powershell
pnpm desktop:dev
```

Local unsigned package and installer commands are documented in the
[desktop guide](docs/desktop-application.md). They are development tooling;
public signed installer delivery remains unfinished. The historical one-shot
release controllers use fixed synthetic operator paths in this public snapshot
and are not a ready-to-run release configuration.

## Documentation and contributions

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and focused test commands,
or open a [GitHub issue](https://github.com/moonman62/intentarc/issues).

- [Local web interface](docs/web-interface.md)
- [Existing-project onboarding](docs/existing-project-onboarding.md)
- [Structured knowledge and repository refresh](docs/structured-knowledge.md)
- [Authoritative change governance](docs/change-governance.md)
- [Task coordination](docs/task-coordination.md)
- [Context selection](docs/context-selection.md)
- [Outbound context safety](docs/outbound-context-safety.md)
- [Data durability and recovery](docs/data-durability.md)
- [Release status](docs/release-readiness.md)

The public repository begins with a fresh source snapshot. Private development
history, internal operator reports, local archives, and signing material are
not distributed with it.
