# Local Development and Desktop Packaging

[中文](getting-started.md)

This is a short guide to running TabTin from source. Run every command from the repository root.

## 1. Prepare the environment

Install these tools first:

- [Node.js](https://nodejs.org/en/download) 18 or newer (the current LTS release is recommended)
- [pnpm](https://pnpm.io/installation) 9.15.0
- [Python 3](https://www.python.org/downloads/)
- [Go](https://go.dev/dl/)
- [Docker Desktop](https://docs.docker.com/desktop/) on Windows or macOS, or [Docker Engine](https://docs.docker.com/engine/install/) on Linux, with Docker running
- [Git](https://git-scm.com/downloads)

Do not worry if you are unsure whether everything is installed. The next step checks it automatically.

## 2. Check the environment

Start Docker first:

- **Windows or macOS:** open Docker Desktop from the Start menu or Applications, then wait until it reports that Docker is running.
- **Linux:** run `sudo systemctl start docker`.

Then run the environment check:

```bash
node scripts/dev.mjs community --doctor
```

Continue when every required item reports `PASS`. This check also verifies the Docker connection; run `docker info` separately if you want to check it manually.

## 3. Create local verification config

Before the first start, copy the committed local example if the repository root does not already contain `.env.local`:

```bash
cp apps/tabtin_django/.env.local.example .env.local
```

The example is restricted to loopback hosts and defaults verification codes to `888888`, without sending real email or SMS. Never overwrite an existing `.env.local`; merge these public development settings if needed.

## 4. Start TabTin

Run:

```bash
node scripts/dev.mjs community
```

The first start installs dependencies, starts the local backend, and builds Electron, so it may take several minutes. Startup is complete when the desktop window opens and the terminal shows:

```text
[community-dev] Electron 已就绪
```

Press `Ctrl+C` in the same terminal to close Electron.

For networks in mainland China, use the China download profile:

```bash
node scripts/dev.mjs community --region cn
```

The launcher writes local configuration to `apps/tabtin-electron/.env.opensource.local`. Git ignores this file. Do not store server-side secrets in it.

## 5. Package the desktop client

A community package needs four public service URLs:

| Variable | Example |
| --- | --- |
| `TABTIN_COMMUNITY_API_BASE_URL` | `https://api.example.org/api` |
| `TABTIN_COMMUNITY_COLLAB_WS_BASE` | `wss://api.example.org/collab` |
| `TABTIN_COMMUNITY_CENTRIFUGO_WS_URL` | `wss://api.example.org/connection/websocket` |
| `TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL` | `https://web.example.org` |

These URLs are embedded in the client package and must not contain usernames, passwords, or other credentials.

### macOS or Linux

```bash
export TABTIN_COMMUNITY_API_BASE_URL=https://api.example.org/api
export TABTIN_COMMUNITY_COLLAB_WS_BASE=wss://api.example.org/collab
export TABTIN_COMMUNITY_CENTRIFUGO_WS_URL=wss://api.example.org/connection/websocket
export TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL=https://web.example.org

# Run this on macOS
pnpm --dir apps/tabtin-electron build:mac:community

# Run this on Linux
pnpm --dir apps/tabtin-electron build:linux:community
```

### Windows PowerShell

```powershell
$env:TABTIN_COMMUNITY_API_BASE_URL = "https://api.example.org/api"
$env:TABTIN_COMMUNITY_COLLAB_WS_BASE = "wss://api.example.org/collab"
$env:TABTIN_COMMUNITY_CENTRIFUGO_WS_URL = "wss://api.example.org/connection/websocket"
$env:TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL = "https://web.example.org"

pnpm --dir apps/tabtin-electron build:win:community
```

After a successful build, installers are written to:

```text
apps/tabtin-electron/dist-app/
```

## If something goes wrong

- **The environment check fails:** install the tool named by the failed check, then rerun `--doctor`.
- **The `build-tools` check fails:** on Windows, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with **Desktop development with C++**; on macOS, follow [Apple's instructions](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools) and run `xcode-select --install`; on Linux, use your distribution's package manager to install [GNU Make](https://www.gnu.org/software/make/) and a C++ compiler such as [GCC](https://gcc.gnu.org/). Windows packaging also needs [Git for Windows](https://git-scm.com/downloads/win).
- **`docker info` cannot connect:** start [Docker Desktop](https://docs.docker.com/desktop/) or [Docker Engine on Linux](https://docs.docker.com/engine/install/), then check again.
- **The backend does not start:** find the first error in the terminal.
- **Dependency installation fails:** check Python 3 and the compiler tools for your operating system.
- **Electron never reports that it is ready:** look for a build failure, missing module, or port conflict in the terminal.
- **The package audit fails:** do not bypass the audit or distribute the failed output. Correct the configuration and rebuild.

For more options, manual installation, and native-module troubleshooting, see [Open-source Electron development](../../apps/tabtin-electron/docs/open-source-development.md).

## Using an AI operator

You can give this guide to an AI, but require it to:

1. Run `--doctor` before starting or packaging.
2. On the first start, copy `apps/tabtin_django/.env.local.example` to the repository root only when `.env.local` is absent; never overwrite or commit an existing local config.
3. Never change global npm configuration or regenerate the lockfile.
4. Never bypass health checks or the package audit.
