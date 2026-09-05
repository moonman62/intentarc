# Local MCP client setup

IntentArc Desktop provides the maintained setup flow for local AI clients.
Open **Settings → AI Connections** to see which supported connectors are ready,
which need additional setup, and which have not been detected. Detection is
credential-free: IntentArc does not ask for a provider API key or expose local
diagnostics and configuration content in the page.

Source-build users can instead configure the standalone stdio MCP server
directly. Desktop-managed connection details and standalone source-build
configuration are separate workflows; do not substitute raw Desktop settings
for the synthetic standalone examples below.

Using an AI client is optional. **Continue without AI** is always available,
and the archive, manual project setup, review, and governance workflows remain
usable without a connection.

## Desktop applications and supported connectors

An installed desktop application is not necessarily a connector. IntentArc can
connect automatically only through a supported local command-line client that
can start its MCP bridge. A browser chat, an API subscription, or the presence
of a desktop shell alone does not provide that local capability.

The catalog distinguishes these cases:

- **Ready to connect** means the maintained local connector is available.
- **Additional setup needed** means IntentArc found related product evidence,
  but the supported connector is not ready.
- **Not detected** means the maintained connector was not found.
- **Connection needs attention** means an existing setup needs review.

Choose **Check again** after installing, updating, signing in to, or repairing a
connector. A failure while checking one client stays on that client's card and
does not hide the rest of the catalog.

## Codex setup

IntentArc connects through the supported Codex CLI, not a protected executable
inside the Codex desktop application. If only Codex desktop is present, its card
shows **Additional setup needed**.

1. Install or update the CLI with `npm install -g @openai/codex`.
2. Run `codex login` and complete ChatGPT sign-in if needed. Confirm it with
   `codex login status`. IntentArc detects the local CLI and MCP setup; it does
   not inspect or connect your ChatGPT account.
3. Return to **Settings → AI Connections** and choose **Check again**.
4. When the card is ready, choose **Connect** and review the requested local
   scope.

Codex may require its own trust confirmation or restart before the connection
appears. The Codex repository and terminal permissions remain separate from
the IntentArc Safe, Trusted, or Custom profile selected for IntentArc tools.

## Another MCP-capable AI tool

When no automatic connector is ready, the recovery panel keeps three routes in
view: **Check again**, **Use another AI tool**, and **Continue without AI**.
The generic route works for a local AI client that can start an MCP server as a
command.

1. Choose **Use another AI tool** and enter a recognizable client name.
2. Choose **Set up an MCP client**. IntentArc creates a revocable Safe profile
   and displays the command and arguments to add using that client's own MCP
   instructions.
3. Add those displayed values in the external client.

IntentArc labels this state **Setup details created**, not **Connected**,
because it cannot inspect or edit an unknown client's settings. Removing the
manual setup disables its Safe profile and invalidates the saved connection
reference. Remove the MCP server from the external tool separately.

The setup page does not display provider credentials or profile credentials.
Outbound context still follows the inspection, approval, redaction, and audit
rules in [outbound context safety](outbound-context-safety.md). Authoritative
changes still follow [authoritative change governance](change-governance.md).

## Supported-client switches

Switching from Codex to Claude Code does not migrate or copy IntentArc
knowledge. Give each maintained connector its own enabled profile and
destination, and point both bridge connections at the same local archive.
Outbound requests and releases remain profile-owned: Claude Code cannot read a
Codex profile's release. Instead, Codex retrieves its immutable release at
revision N, a local human accepts Codex's governed evidence, and Claude Code
then creates and retrieves its own distinct release at N+1 from the same
project, task, stable intent, constraint, and evidence history. Codex can still
retrieve its earlier release byte-for-byte afterward.

Two levels of acceptance evidence are deliberately separate:

- The hermetic scenario proves two independently authenticated MCP sessions,
  profile-owned releases, exact record snapshots, governed `evidenced_by`
  lineage, immutable history, and one shared archive without changing a user's
  client configuration.
- The Windows installed-client run also exercised the maintained production
  Codex and Claude Code adapters, their supported MCP configuration commands,
  and two production bridge sessions. The complete-oracle run used Codex CLI
  `0.146.0` and Claude Code `2.1.207`. The private run identifier is omitted
  from this public snapshot. It proved revision `5 -> 6`, two
  distinct releases, and zero configuration, journey, teardown, and cleanup
  failures. This is Windows evidence only; no macOS or Linux runtime claim
  follows from it.

The installed-client command is intentionally skipped unless an operator sets
both its explicit gate and a fresh UUID for that process:

```powershell
$env:INTENTARC_RUN_CLIENT_PORTABILITY_E2E = "1"
$env:INTENTARC_CLIENT_PORTABILITY_RUN_ID = [guid]::NewGuid().ToString()
try {
  pnpm desktop:test:client-portability
} finally {
  Remove-Item Env:INTENTARC_RUN_CLIENT_PORTABILITY_E2E -ErrorAction SilentlyContinue
  Remove-Item Env:INTENTARC_CLIENT_PORTABILITY_RUN_ID -ErrorAction SilentlyContinue
}
```

For UUID `<uuid>`, the controller owns only
`intentarc-acceptance-codex-<uuid>` and
`intentarc-acceptance-claude-<uuid>`. It requires exact-name absence before
mutation, removes Claude's exact entry and then Codex's exact entry, and
independently requires both exact names to be absent afterward. The accepted
run's two exact names were absent before and after. The command does not launch
either client, invoke a model, contact a provider, or change the default
`intentarc` entry. A BLOCKED result includes bounded exact-name recovery
commands and must not be treated as acceptance.

## Standalone source-build MCP server

Build IntentArc with `pnpm build`, then configure a local MCP client to start
the compiled server as a stdio process. Use absolute paths for both the
compiled entry point and the SQLite archive. Client configuration locations
and the outer property containing an MCP server entry vary; place only the
applicable object below where that client's maintained MCP documentation
requires it.

Every path, ID, label, and token value in this section is a deliberately
non-working synthetic placeholder. Replace placeholders only in private local
configuration. Never paste a production profile token, raw Desktop settings,
Desktop connection reference, provider API key, or installation-specific
Desktop command into documentation, source control, or support messages.

### Anonymous read-only connection

Both profile credential variables must be absent from the child process's
effective environment. Omitting them from the server-specific `env` object is
not enough when the MCP host also inherits user, system, or shell variables.
Never define `INTENTARC_PROFILE_ID` or `INTENTARC_PROFILE_TOKEN` globally;
unset both for the MCP host and its child before using anonymous mode. The
example below assumes neither variable exists in any inherited environment:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/intentarc/dist/mcp/bin.js"],
  "env": {
    "INTENTARC_DB_PATH": "C:/absolute/path/to/project.intentarc.sqlite"
  }
}
```

An anonymous server exposes only two read-only metadata tools:

- `list_projects`
- `get_project_summary`

Anonymous clients cannot prepare or retrieve task context. Project list and
summary metadata, including active-task titles, is outside the outbound
task-context release gate. These tools do not change authoritative records,
relationships, or the project revision.

### Authenticated governed connection

Create a profile through the local-human CLI. From the built source tree, the
following command creates Proposal-only project authority and prints the new
profile ID plus its one-time token:

```powershell
node dist/cli/bin.js --db C:/absolute/path/to/project.intentarc.sqlite profile create --name "Synthetic MCP client" --project PROJECT_ID
```

Keep the returned token only in the MCP client's private local secret
configuration. Before the client requests task context, declare its current
outbound destination locally. This example uses synthetic values; replace
`profile-example-123` with the locally returned profile ID and describe the
actual connection conservatively:

```powershell
node dist/cli/bin.js --db C:/absolute/path/to/project.intentarc.sqlite profile destination set --profile profile-example-123 --client-label "Synthetic MCP client" --type ide_managed --provider "Synthetic provider" --model "Synthetic model" --account-boundary "Synthetic account" --data-boundary remote
```

Destination fields are human declarations. IntentArc does not contact or
verify the named client, provider, model, account, or data boundary. See
[outbound context safety](outbound-context-safety.md) for destination types and
choose the description that matches the real local connection.

Configure the authenticated stdio server with the profile ID and one-time
token stored by the client:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/intentarc/dist/mcp/bin.js"],
  "env": {
    "INTENTARC_DB_PATH": "C:/absolute/path/to/project.intentarc.sqlite",
    "INTENTARC_PROFILE_ID": "profile-example-123",
    "INTENTARC_PROFILE_TOKEN": "synthetic-token-value-do-not-use"
  }
}
```

The environment contract is:

| Variable | Rule |
| --- | --- |
| `INTENTARC_DB_PATH` | Always required; use an absolute SQLite archive path. |
| `INTENTARC_PROFILE_ID` | Must be absent from the effective child environment for anonymous startup; provide with the token for authenticated startup. |
| `INTENTARC_PROFILE_TOKEN` | Must be absent from the effective child environment for anonymous startup; provide with the profile ID for authenticated startup. |

When both credentials are absent from the effective child environment,
startup is anonymous. When both are present, they must identify an enabled
profile. A partial pair, invalid credentials, or a disabled profile fails
startup closed; IntentArc never falls back to anonymous or local-human
authority.

### Authenticated coordination CLI

The standalone CLI uses the same two profile credential variables for task
coordination. Set `INTENTARC_PROFILE_ID` and `INTENTARC_PROFILE_TOKEN` only in
the private environment of the CLI process. Both must be present and non-empty,
or both must be absent; a partial pair is invalid. There are no credential
flags, and credentials are never included in command JSON or command output.

Every coordination command also requires `--db` and returns one public JSON
document on success. Ready-task and task-state reads use bounded flags:

```powershell
node dist/cli/bin.js --db C:/absolute/path/to/project.intentarc.sqlite coordination ready --project PROJECT_ID --expected-project-revision 3 --limit 20
node dist/cli/bin.js --db C:/absolute/path/to/project.intentarc.sqlite coordination state --project PROJECT_ID --task TASK_ID --expected-project-revision 3
```

Mutations read one strict Task Coordination input document from an absolute
path. Use `--input C:/absolute/private/path/input.json` with one of these
commands: `claim`, `renew`, `checkpoint`, `transition`, `switch`, `delegate`,
`accept-delegation`, `revoke-delegation`, or `submit`. The file is read as
bounded UTF-8 and validated against the closed operation schema before any
mutation. Keep it outside source control because checkpoint, delegation, and
submission documents may contain private work evidence.

In a TTY, releasing a claim, switching tasks, revoking a delegation, and
submitting a final result require confirmation. Non-interactive invocation
preserves the CLI's existing confirmation convention. Malformed command or
document input exits with code 2; authentication and coordination rejections
exit with code 1 and only a fixed public message.

An authenticated server adds:

- `submit_change_set`, the only authoritative project-mutation entry point;
- `list_my_changes`, a read-only view of that profile's submissions;
- `get_my_change`, a read-only detail view of that profile's submission;
- `request_task_context`, which stores an idempotent request and returns only
  review metadata and finding counts; and
- `get_released_context`, which returns the exact immutable artifact only
  after release and audits every successful disclosure.

Task content remains behind the inspect/review/release gate. A first clean
request pauses for local review; a narrowly remembered clean-release policy
may release only a later matching zero-finding request. Any finding pauses,
confirmed credentials remain forcibly redacted, and an eligible
possible-sensitive finding requires an explicit request-specific decision.
Outbound inspection scans generated packs and destination snapshots, not
repositories, and IntentArc never executes a provider request.

Profile credentials identify client authority but do not grant local-human
administration. Destination administration, sensitive-value reveal, approval,
denial, release-policy administration, and raw `context get` access remain
local CLI operations rather than MCP tools. See
[authoritative change governance](change-governance.md) for proposal,
revision, idempotency, audit, and trust-boundary behavior.

## API-only accounts and browser chats

An API-only account is not a local AI client: it does not install a process
that can start IntentArc's MCP server. IntentArc therefore makes no local-
connector claim and does not request or store an API key. Browser-only chats
have the same limitation.

Use a supported local connector, configure another MCP-capable local tool, or
choose **Continue without AI**. Provider-hosted API execution requires a
separate future design for credentials, model choice, usage, and cost controls.
