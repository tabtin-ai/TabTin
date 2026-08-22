# Open-source Electron development

This guide covers the TabTin desktop client only. It keeps the default path suitable for developers worldwide and offers an explicit China download profile without changing a developer's global npm configuration.

## Community quick start

Windows and macOS users can launch from the repository root by double-clicking:

- Windows: `start-community-dev.bat`
- macOS: `start-community-dev.command`

The launchers select the download source automatically. You can also run the canonical entry point from a terminal:

```bash
node scripts/dev.mjs community
```

It runs the required Doctor checks, installs Electron dependencies when needed, prepares the public client environment, reuses a healthy backend or starts it, waits for Django, Collab Live, and Centrifugo to become healthy, and only then starts Electron. Each stage reports its duration. The command reports “Electron is ready” only after the main window has finished loading; build failures, missing modules, and early process exits fail immediately before readiness. A cold start may wait for up to ten minutes. After dependencies are installed, the equivalent package alias is `pnpm dev:community`.

The local backend infrastructure is managed exclusively through Docker Compose. Start Docker Desktop (or another Docker daemon) before running the command.

For a mainland China network, we recommend selecting the China download profile explicitly to avoid extra source probing and download variability:

```bash
node scripts/dev.mjs community --region cn
```

To force the official global source instead of automatic region selection, run:

```bash
node scripts/dev.mjs community --region global
```

To run only the environment checks, without installing dependencies, starting the backend, or launching Electron, run:

```bash
node scripts/dev.mjs community --doctor
```

Without starting any stage, print the complete orchestration plan:

```bash
node scripts/dev.mjs community --dry-run
```

If you already manage the backend yourself, this mode still checks its health but does not start or restart it:

```bash
node scripts/dev.mjs community --skip-backend
```

### Windows shells

On Windows, double-click `start-community-dev.bat` in the repository root or run the same `node scripts/dev.mjs community` command from PowerShell, Command Prompt (CMD), or Git Bash. The command selects the native backend path on Windows, so Bash and WSL are not required.

### macOS terminals

On macOS, double-click `start-community-dev.command` in the repository root or run the canonical Node command from Terminal. If the file is not executable, run `chmod +x start-community-dev.command` from the repository root. A Git clone preserves the executable bit.

## Advanced setup and troubleshooting

- Node.js 18 or newer and pnpm 9.
- Python 3 for native Node modules.
- Platform build tools: Visual Studio Build Tools with **Desktop development with C++** on Windows, Xcode Command Line Tools on macOS, or `make` plus a C/C++ compiler on Linux.

Check the local toolchain before installing:

```bash
pnpm bootstrap:electron:doctor
```

The doctor separates download-source configuration from native compilation requirements. A mirror can speed up a download, but it cannot install Python, a compiler, a system SDK, or configure a corporate proxy.

## Install

The global profile uses the official npm registry and the normal upstream Electron binary source:

```bash
pnpm bootstrap:electron
```

Developers in mainland China can opt into child-process-only mirrors for npm, Electron, electron-builder binaries, and Sentry CLI:

```bash
pnpm bootstrap:electron:cn
```

Both commands use the same committed `pnpm-lock.yaml` with `--frozen-lockfile`. The China profile does not run `npm config set`, edit a user-level `.npmrc`, or persist mirror variables after the command exits.

Development startup prepares only the Python runtime by default, so a cold start does not download the roughly 283 MB LibreOffice payload. Fetch Office explicitly when high-fidelity preview or packaging resources are needed:

```bash
pnpm --dir apps/tabtin-electron runtimes:fetch -- --only office
```

The Office runtime source is selected from the system time zone and locale. China addresses prefer the prebuilt archive verified by size and SHA-256; other regions prefer The Document Foundation and Poppler upstream sources. Either path falls back to the other when unavailable. Set `TABTIN_RUNTIME_REGION=cn` or `TABTIN_RUNTIME_REGION=global` for an explicit one-command override; it does not need to be stored in `.env`.

## Run Electron

Start the desktop client from the repository root:

```bash
pnpm --dir apps/tabtin-electron dev
```

Renderer changes normally hot reload. Main-process, preload, IPC, native-module, or environment changes require an Electron restart. API-backed flows also require a compatible backend endpoint; starting Electron does not start that backend.

## Build Profiles

Desktop installers have two build profiles: `local` for packaged behavior checks
against a local backend, and `community` for self-hosted distribution.

On macOS, every `local` build uses ad-hoc signing. It never reads a Developer ID
from Keychain or signing environment variables, and does not need a certificate,
timestamp network access, or Apple notarization. Ad-hoc signatures make the local
app runnable but are not suitable for public distribution.

The `community` profile is the open-source distribution profile:

- Four public endpoints are required: API, Collab WebSocket, Centrifugo WebSocket, and the public Web application. Self-hosted TabChat uses Django `/api/im` on the same API origin; the Tencent control plane is disabled. These endpoints form the complete community trust boundary and are written into the package at build time.
- The updater is disabled when `TABTIN_COMMUNITY_UPDATE_FEED_URL` is absent.
- When present, the update feed must be HTTPS and is recorded in packaged metadata; a runtime environment variable cannot replace or widen it.
- Community builds skip TabTin's official sourcemap upload and notarization services.

Linux/macOS shell example without automatic updates:

```bash
export TABTIN_COMMUNITY_API_BASE_URL=https://api.example.org/api
export TABTIN_COMMUNITY_COLLAB_WS_BASE=wss://api.example.org/collab
export TABTIN_COMMUNITY_CENTRIFUGO_WS_URL=wss://api.example.org/connection/websocket
export TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL=https://web.example.org
pnpm --dir apps/tabtin-electron build:linux:community
```

PowerShell example with a community-owned update feed:

```powershell
$env:TABTIN_COMMUNITY_API_BASE_URL = "https://api.example.org/api"
$env:TABTIN_COMMUNITY_COLLAB_WS_BASE = "wss://api.example.org/collab"
$env:TABTIN_COMMUNITY_CENTRIFUGO_WS_URL = "wss://api.example.org/connection/websocket"
$env:TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL = "https://web.example.org"
$env:TABTIN_COMMUNITY_UPDATE_FEED_URL = "https://downloads.example.org/desktop"
pnpm --dir apps/tabtin-electron build:win:community
```

## Native Module Troubleshooting

`node-pty` is rebuilt during Electron installation. If installation fails after all downloads complete, the problem is usually the native toolchain rather than the registry:

- Windows: install Python and Visual Studio Build Tools with the C++ desktop workload.
- macOS: install Python and run `xcode-select --install` if Command Line Tools are missing.
- Linux: install Python, `make`, a C/C++ compiler, and the development headers required by your distribution.

Use `--dry-run` when diagnosing mirror selection without changing `node_modules`:

```bash
node scripts/electron/install-dependencies.mjs --region cn --dry-run
```

## Security Model

- `VITE_*` values, including `VITE_SENTRY_DSN` and SDK application IDs, are public client configuration—not server secrets.
- `SOURCEMAP_UPLOAD_KEY`, `SENTRY_AUTH_TOKEN`, code-signing keys, and signing PINs must be injected through the build process environment. Do not commit them to any `.env` file.
- The packaged artifact audit blocks env files, private-key material, and upload-token patterns without printing secret values.
- Community builds accept only the four declared public service endpoints. Django IM shares the declared API origin; cloud metadata endpoints and embedded URL credentials remain blocked.

Run the Electron open-source audit before sharing changes:

```bash
pnpm --dir apps/tabtin-electron audit:opensource
```

## What This Does Not Start

The one-command path may call the project's existing backend startup script, but it does not implement or redesign backend startup. It does not start the TabTin Daemon, AdminDash, iOS, or Android. It also does not create a public repository, rewrite Git history, choose a project-wide license, or govern the root `.env`; those are project-level open-source responsibilities owned outside the Electron workstream.
