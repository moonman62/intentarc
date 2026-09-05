# Local web interface

IntentArc Slice 1 provides an authenticated local web interface for continuing
project work, reviewing governed changes, preparing safe context, and
onboarding an existing repository.

## Install, build, and start

```powershell
pnpm install
pnpm build
node dist/web/bin.js --db C:/absolute/path/to/project.intentarc.sqlite
```

The server prints a launch URL containing a per-launch web credential. It is
valid for that server process's lifetime. Open the URL locally and do not share
it. IntentArc exchanges the query-string token for an `HttpOnly`,
`SameSite=Strict` cookie and redirects immediately so the credential is removed
from the address bar. The server binds only to `127.0.0.1`; there is no
public-network mode.

The database is created at the absolute path supplied with `--db`. Stop the
server with `Ctrl+C`; IntentArc then closes the HTTP listener and database.

## Development in two terminals

Start the application server in the first terminal:

```powershell
pnpm dev:server
```

Start Vite in a second terminal:

```powershell
pnpm dev:web
```

First open the credential-bearing launch URL printed by `dev:server` so the
application server can exchange it for the session cookie. Then open
`http://127.0.0.1:5173`. The development script explicitly permits that exact
loopback origin for mutations through `--dev-origin`; other origins remain
rejected. The development database is `.intentarc-dev.sqlite` in the repository
root unless the script is changed deliberately. Stop both processes with
`Ctrl+C`.

## Security and privacy boundary

- Browser access is authenticated by the in-memory launch credential and
  `HttpOnly` cookie. Mutation requests also require an allowed exact loopback
  origin.
- The web client never opens SQLite. Provider credentials, connection
  credentials, raw client settings, and private diagnostics remain outside
  ordinary browser state and browser preferences.
- Project operations flow through the same IntentArc application services,
  governance rules, outbound-safety checks, and audit boundary used by other
  adapters.
- Handoff Desk copies or downloads one released, safety-reviewed portable
  context. It does not launch, open, upload to, or control Codex, Claude Code,
  Cursor, a browser chat, or another AI client.
- Repository import reads eligible evidence and requires review before an
  atomic baseline is applied. It does not run repository code.
- Documentation reopens accepted repository files through bounded containment,
  format, size, and hash checks. Stale or unavailable content is never rendered
  as accepted, and safe rendering performs no automatic remote fetches.
- Repository refresh is user-started, streamed without polling, cancellable,
  persistent across restart, and split into repository facts and optional
  governed semantic proposals. It never edits the repository or Git.

## Desktop AI setup and the browser interface

**Settings → AI Connections** is available only when the interface is hosted by
IntentArc Desktop, which supplies the narrow local lifecycle and connector
bridge. A standalone browser cannot detect or configure local AI applications.
The presence of a desktop application also does not prove that its supported
local connector is installed.

Desktop users can follow the Codex CLI guide and choose **Check again**, use the
generic MCP flow to create a revocable Safe-profile setup, or choose
**Continue without AI**. Generic setup remains labelled **Setup details
created** until the user adds the displayed command and arguments in the
external client. Removing it revokes IntentArc access but cannot edit that
external setting.

An API-only account and a browser chat do not provide a local process that can
start the MCP bridge. IntentArc requests no provider API key and makes no local-
connector claim for them. The no-AI route remains available in Desktop, and
the standalone web interface continues to support archive work without an AI
connection.

## Agent Work Queue entry

Within a project, **Work Queue** opens the **Agent Work Queue**. Before
authentication, it shows an owner-visible summary of that project's task count
and current task, then lists enabled profiles that have access to the project.
Selecting a profile fills its public, non-secret ID and opens **Advanced
access**. It does not authenticate the profile.

**Advanced access** is closed by default. Authentication requires the
profile's separately held token, which the browser screen cannot recover from
a configured profile. Tokens remain in browser memory only, never URLs or
browser storage, and are cleared on sign-out, project change, credential
failure, and ordinary request errors. Desktop can link to AI Connections for
setup; a standalone browser reports that setup is unavailable and keeps manual
Advanced access available.

## Browser-chat handoff

Handoff Desk shows **Copy task context** and **Download Markdown** only after a
request has completed local inspection, approval/redaction, immutable release,
and retrieval validation. Both actions consume the same server-produced
Markdown text. The browser does not recompute disclosure data or task context.

The downloaded file is UTF-8 Markdown with media type
`text/markdown;charset=utf-8` and a filename derived from the opaque release
ID. Its metadata includes original and released token estimates, requested
budget, release digest and SHA-256, all finding counts, explicit omissions and
retrieval references, and the released task context. Browser acceptance proved
that the downloaded bytes equal the exact text supplied to the copy action and
that redacted content remains absent.

Copy and download recover independently: failure of one leaves the other
available. No copy or download action appears while preparing, scanning,
reviewing, denied, loading, or before release. IntentArc only prepares the file
locally; the user decides whether and where to paste or upload it.

## Product surfaces

**Projects** is the project-selection surface. Inside a project, **Overview**
summarizes current focus, attention, and recent change with links to the owning
records. The sidebar separates **Actions** (Work Queue, Current Task,
Proposals, Ideas, and Import Project) from **Information** (Overview, Map,
Documentation, and Repository).

The **Project Map** presents the authoritative project-rooted hierarchy with
the Project selected and current in **Whole Project** scope by default, with all
root Outcomes represented. Selecting a record changes its detail and route but
does not narrow the tree. **Focus here** alone scopes the map to a branch;
descendant selection retains that scope, and **Show whole project** restores
project context without discarding the selection. Neutral, Software, and Simple
vocabulary presets change labels, not hierarchy authority; projects may use
arbitrary depth while each hierarchy child has at most one primary parent and
cycles are rejected.

The responsive Map is one semantic Project-rooted tree. Wide layouts arrange
bounded visible levels in layered columns and can draw an SVG relationship
overlay between cards. Narrow layouts stack the same hierarchy and retain the
authoritative text relationship ledger even when that SVG is absent. The
**Direct cross-links** ledger reports direct non-parent relationships rather
than transitive reachability. Selected detail groups canonical repository
attachments by accepted, observed, inferred, or conflicting basis and shows
each basis, kind, and relative path, with stable destinations into Map,
Documentation, and Repository.

**Repository Explorer** is read-only. It puts repository search and the accepted
tree/results before its common filters, with advanced classification filters
collapsed. Selected nodes show their project path and explicit connections to
Map records or Documentation. It never edits files, stages or commits changes,
changes Git configuration, or runs repository code. When the repository is
unavailable, recovery replaces the empty tree and filters with the applicable
Locate, Attach, retry, or project switch action.

**Documentation** puts search, the accepted document list, and the selected
bounded preview before collapsed advanced filters. A selected document shows
its project/repository path and connection basis, with links to Map records or
Repository nodes. Stale, unavailable, unsupported, and desktop-only external
open states remain explicit.

In a standalone browser, import and attachment accept a validated manual
repository path, while Map, Repository, and Documentation remain available for
normal inspection. The browser cannot invoke a native folder picker, use
**Locate** for a moved source, or open a document in an operating-system
application. IntentArc Desktop adds the native repository-folder chooser for
import, attachment, and same-identity Locate, and enables explicit **Open
externally**. Both hosts use the same reviewed refresh, containment, identity,
and read-only boundaries.

Other action surfaces include Handoff Desk and outbound review, proposal
review and decisions, existing-project Import, and [idea capture and the
bounded, read-only Ideas inbox](ideas.md). Repository refresh remains reviewed,
manual, and recoverable.

IntentArc does not provide Insights, unbounded graphs, provider execution,
repository editing, or automatic synchronization. Slice 2 has no watcher or
polling loop. See
[structured knowledge and repository refresh](structured-knowledge.md).

## Verification boundaries

The current local evidence does not establish macOS or Linux runtime behavior.
It also includes no fresh live signing, certificate/trust/key mutation,
release, Setup, install, update, upgrade, or other product-lifecycle attempt.
The earlier sole authorized Signed attempt failed during certificate
preparation before release or artifact publication; a new live attempt requires
fresh authorization for its exact operations.
