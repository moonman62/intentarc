# Release status

IntentArc is an early source release. The public repository contains the
application, development tooling, tests, and user documentation. It does not
provide a signed Windows installer.

Windows is the locally tested platform. macOS and Linux runtime support has
not been verified. Source builds and browser startup are separate from signed
installer, update, and uninstall acceptance.

The most recent full development-suite run was not completely green. The
reported failures received focused follow-up checks, but the full suite was
not rerun afterward. Do not treat this source publication as certification
that every test or installed-product workflow passes.

Use the [README](../README.md) to build and run the local browser interface.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for verification commands. Public
signed installer delivery still requires signing setup and clean-machine
installation, update, and removal checks.

Historical one-shot release controllers are retained as development code with
synthetic operator paths. Their fixed machine and authorization bindings are
not configured for public users. Ordinary source setup does not require them.

Internal development reports and the original Git history are intentionally
not included in this public snapshot.
