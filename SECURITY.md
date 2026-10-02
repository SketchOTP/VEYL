# Security

## Report a vulnerability

Use the repository's [private vulnerability reporting](https://github.com/SketchOTP/VEYL/security/advisories/new) if enabled. Otherwise contact the maintainer at **sketchotp@gmail.com** with a minimal sanitized description and arrange a private channel before sending exploit details. Do not attach API keys, OAuth stores, private paths, chat transcripts or personal images to a public issue. There is no promised response SLA.

## Supported release

Security fixes target the latest VEYL 1.x release on Ubuntu 24.04 x86-64. Newer systems may work but are unverified; other operating systems/architectures and older releases are not verified.

## Boundaries

- Electron renderers are sandboxed, context isolated and have no Node integration. Narrow IPC validates senders; local preview protocols/CSP avoid privileged loading of arbitrary HTML/SVG scripts. Thumbnails/previews do not execute file-supplied instructions.
- CLI planning uses private scratch space, fixed arguments, disabled native tools/extensions and independently validated structured outputs. API adapters use fixed official HTTPS endpoints, header-only selected keys, no redirects or tools. No model/provider fallback exists. Unsupported isolation/authentication fails closed.
- Assistant permissions and scope are enforced in app-owned services, not solely prompts. Mixed plans are checked before execution; queued/current-version checks and supported cancellation guard operation boundaries. Hidden directories/ancestors, credential files and app-state paths are refused to agents, including unfamiliar hidden configuration stores. Directory boundaries use filesystem/member metadata, allowing ordinary hidden regular files when hidden visibility is authorized. User-controlled manual explorer operations remain available.
- Mutations use source identities, exclusive/no-clobber destinations and truthful partial results. Trash is recoverable. Supported Undo refuses changed targets. Folder descendants are checked during execution rather than sealed indefinitely at planning time.
- Text replacement uses bounded UTF-8 regular files and an identity-bound descriptor. It is not an atomic transaction against an external writer. Stable app-owned partials may permit Undo; externally changed content/replacement is never blessed for automatic overwrite recovery.
- Archives preflight names/types/conflicts/resource budgets and extract into a new exclusive folder. Links/special files/traversal and unsupported formats are refused. Image input is header-bounded, sandbox decoded and staged as sanitized PNG, without modifying originals.

## Sandbox and installation

Launchers require a root:root mode4755 regular Chromium helper and root-owned, non-writable ancestor chain. The Debian package manager configures only VEYL's own helper under `/opt/VEYL`; portable builds require an existing trusted helper. No launcher adds sandbox-disabling flags, changes an external helper or installs a relaxed AppArmor profile. Explicit unsafe helpers are rejected rather than ignored.

Release app files use an exact allowlist and SHA-256 readback manifest. The manifest detects app-payload changes relative to the build; it is not a signature, complete Electron-runtime attestation or independent trust root. Verify downloaded release checksums through a trusted channel. Releases do not bundle CLI tools, credentials, local histories, tests or working checkpoints, and do not auto-update.

Keep backups. Stop/Undo and identity checks cannot make multiple file operations a filesystem transaction, guarantee detection of every concurrent writer or replace OS access controls. API/model availability and vendor policies can change.
