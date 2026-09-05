# IntentArc Desktop

IntentArc Desktop is the Windows application for the same local-first archive
used by the CLI, loopback web server, and MCP adapter. The Windows x64 package
contains Electron, the React interface, the compiled storage migrations,
SQLite's native module, and a separate `IntentArc Bridge.exe`. A user does not
need Node.js, pnpm, a terminal, an IntentArc account, or a visible loopback URL
to run an installed package.

## Install and launch

Run `IntentArc Setup.exe` as the Windows user who will use IntentArc. The
Squirrel installer is per-user and does not require administrator privileges.
It creates the stable `IntentArc.exe` launcher beneath the user's local
application-data directory. Install, update, obsolete-version, and uninstall
events are handled before the desktop lifecycle starts, so they never open the
IntentArc window.

Windows x64 is the only supported package in this release. A portable folder is
useful for local smoke testing but is not the supported installation shape,
because AI clients depend on a stable installed bridge path.

## Archives, settings, and backups

Application binaries and user data have separate lifecycles:

- Squirrel-managed application binaries live below
  `%LOCALAPPDATA%\IntentArc`.
- Private desktop settings and opaque AI connection records live below
  `%APPDATA%\IntentArc`.
- The default archive is `%APPDATA%\IntentArc\intentarc.sqlite`; a different
  absolute archive can be chosen during onboarding.
- Verified backup bundles use the archive's adjacent `.backups` directory
  unless the user explicitly selects another backup root.

Updating or uninstalling IntentArc does not remove or relocate an archive,
its WAL files, verified backup bundles, or another configured backup root.
Deleting those items is a separate, explicit data-management action. Keep the
archive and its backup directory together when moving data, and use IntentArc's
restore workflow rather than copying a live SQLite file.

After uninstall, Squirrel may temporarily leave
`%LOCALAPPDATA%\IntentArc\.dead`, `Update.exe`, and a locked Squirrel
self-deletion file until Windows restarts. The `.dead` marker prevents the
application from being treated as installed. This narrow tombstone is not a
runnable IntentArc installation: the IntentArc application and bridge payloads,
uninstall registration, and shortcuts must already be gone.

When onboarding saves a different archive, choose **Restart IntentArc**.
Desktop relaunches once and opens the persisted selection; it does not accept a
renderer-supplied path during relaunch. If the relaunch request fails, the same
screen remains visible and offers **Close and reopen manually**. The selected
archive stays saved for the next launch.

## Installed AI bridge integrity

The Windows installer provides the local MCP bridge used by supported clients.
Install and update verify the complete bridge payload, native SQLite support,
protocol compatibility, release identity, and—on public builds—the Windows
publisher signature before activation. A failed activation leaves the last
healthy release selected or records recovery work for the next startup.

The bridge can continue serving a configured local AI client while the Desktop
window is closed. If bridge health checks fail, repair or update IntentArc and
then test the connection again. IntentArc does not download an unverified
runtime fallback or silently replace an unrelated MCP setting.

## Connect a local AI client

Open **Settings → AI Connections**. The page distinguishes an installed desktop
application from a supported connector: IntentArc can connect automatically
only when the maintained local CLI is ready. A desktop shell, browser chat, or
API subscription alone cannot start the local MCP bridge.

For Codex, IntentArc uses the supported Codex CLI. If Codex desktop is present
but the CLI is missing, the card shows **Additional setup needed**. Install or
update the CLI with `npm install -g @openai/codex`, run `codex login` if needed,
return to IntentArc, and choose **Check again**. IntentArc checks the local CLI
and MCP setup rather than the user's ChatGPT account. Codex and Claude Code may
still require their own trust confirmation or restart after connection.

When no automatic connector is ready, the recovery panel offers **Check
again**, **Use another AI tool**, and **Continue without AI**. The generic MCP
route creates a revocable IntentArc Safe profile and shows the command and
arguments to add in the external client's own settings. IntentArc calls this
**Setup details created**, not **Connected**, because it cannot inspect or edit
an unknown client's configuration. Removing the manual setup disables the Safe
profile and invalidates the saved connection reference; remove the external
client entry separately.

An API-only account is not a local connector. IntentArc does not request its API
key or claim that an account is connected. The archive and manual project setup
remain usable through the always-available **Continue without AI** route.

Provider credentials, connection credentials, raw diagnostics, and external
settings content do not enter ordinary renderer state. The AI client's own
repository and terminal permissions remain independent from the IntentArc Safe,
Trusted, or Custom profile.

## Updates

Automatic update checks are opt-in for a packaged Windows application. They are
disabled when `INTENTARC_UPDATE_FEED_URL` is absent. A configured feed must be a
credential-free HTTPS URL; credentials, feed URLs, release notes, and updater
errors are not returned through renderer IPC. Checks are delayed for at least
ten seconds after Squirrel's first-run launch so the installer can release its
file lock.

A downloaded update is reported as public status only. IntentArc never applies
it immediately: the user must choose the explicit restart action, which calls
Electron's Squirrel updater after download.

## Signing and local package verification

`pnpm desktop:make` creates an unsigned Windows x64 installer for local testing.
Its bridge identifies itself as `unsigned-development`; do not publish it.
Public release artifacts are invalid unless the complete
release build succeeds with both:

```text
INTENTARC_WINDOWS_CERTIFICATE
INTENTARC_WINDOWS_CERTIFICATE_PASSWORD
INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT
INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR
```

`INTENTARC_WINDOWS_CERTIFICATE_THUMBPRINT` must be the exact 40-hex SHA-1
thumbprint of the imported signing certificate. `pnpm desktop:release` is the
gated release command. It signs the package and Squirrel artifacts without
placing PFX credentials in Squirrel's arguments, then verifies Authenticode on both packaged
`IntentArc.exe` and packaged `IntentArc Bridge.exe` (and the setup executable)
before succeeding. Set `INTENTARC_BRIDGE_AUTHORIZED_PREDECESSOR=none` only for
an initial release. For an update, supply the exact previous installed release
manifest as strict JSON; its publisher must match the signed candidate. Signing
secrets and predecessor authorization must come from the release environment;
they are not stored in this repository. Local tests use no remote feed and no
signing secret.

For a complete local check on Windows x64 with Node 24.11.0:

```powershell
pnpm test
pnpm typecheck
pnpm test:e2e
pnpm desktop:package
pnpm vitest run src/desktop/e2e
pnpm desktop:make
```

The packaged-process tests use isolated application-data and archive
directories. They do not modify the developer's real Codex or Claude Code
configuration.

The real Squirrel install/uninstall boundary is an additional, explicit Windows
machine test. Run it only after `pnpm desktop:make` and only when IntentArc is
not currently installed for the Windows user:

```powershell
$env:INTENTARC_RUN_INSTALLER_E2E='1'
pnpm desktop:test:installer
```

The command refuses a pre-existing install root, uninstall registration, or
IntentArc shortcut. It snapshots `%APPDATA%\IntentArc` read-only, installs and
uninstalls the fresh package, verifies that user data is byte-for-byte
unchanged, rejects any runnable product residue, and removes only the accepted
test-owned Squirrel tombstone files after reporting them. It never invokes
repository refresh.

## Repair and limitations

- A moved archive must be selected again; IntentArc does not create an empty
  replacement silently.
- A future or incompatible archive must be opened by a matching or newer
  IntentArc version.
- A failed native dependency or bridge health check requires package repair;
  IntentArc does not download a runtime fallback.
- Web-only ChatGPT or Claude sessions cannot start a local stdio executable.
- An OpenRouter API key is not an AI application and is not a desktop
  connection.
- macOS and Linux retain the same application and adapter architecture but are
  not supported release targets until their native packages pass their own
  signing, update, installer, bridge, and archive matrix.
