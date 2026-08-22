# 社区版 Electron 一键开发启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 Windows、macOS 和 Linux 社区开发者提供一个无需理解平台脚本差异、可自动准备客户端配置并在本地后端健康后启动 Electron 的统一命令。

**Architecture:** 使用 Node CLI 作为唯一用户入口，把参数、环境文件、后端适配和健康检查拆为可单测模块。依赖安装继续复用 `scripts/electron/install-dependencies.mjs`；Windows 后端走现有 `.bat`，macOS/Linux 后端走现有 `.sh`，Electron 继续走 `scripts/electron/dev.mjs`。

**Tech Stack:** Node.js ESM、`node:test`、pnpm workspace、Windows CMD/PowerShell、Bash、Electron Vite。

**Spec:** `apps/tabtin-electron/docs/community-dev-bootstrap-design.md`

## Global Constraints

- 唯一无需预装工作区依赖的入口是 `node scripts/dev.mjs community`。
- Windows 用户不得被要求安装 Bash 或 WSL；PowerShell、CMD 和 Git Bash 运行同一 Node 命令。
- Windows 后端适配器调用 `scripts/backend/start.bat`，macOS/Linux 调用 `scripts/backend/start.sh`。
- 国内镜像只作用于安装子进程，不修改全局或仓库 `.npmrc`。
- 生成的 Electron 环境文件只包含白名单中的公开客户端配置，不复制或打印服务端秘密。
- Django、Collab Live 和 Centrifugo 未全部健康时不得启动 Electron。
- 不修改 Daemon、AdminDash、iOS 或 Android。
- 所有实现先写失败测试，再写最小实现；当前 CI 停跑，以本地测试和真实 Windows 验收兜底。

---

## File Structure

- `scripts/electron/community/start.mjs`：CLI 入口和阶段编排，不承载平台细节。
- `scripts/electron/community/options.mjs`：参数解析和帮助文本。
- `scripts/electron/community/environment.mjs`：公开客户端环境配置的解析、校验和原子写入。
- `scripts/electron/community/backend.mjs`：平台后端命令、健康探测和等待逻辑。
- `scripts/electron/community/doctor.mjs`：Node、pnpm、Python、Go、编译工具和后端前置检查。
- `scripts/electron/community/install-cache.mjs`：锁文件指纹和成功安装标记。
- `scripts/electron/install-dependencies.mjs`：扩展 `auto` 区域探测，保留现有显式 `cn/global` 安装计划。
- `scripts/electron/community/*.test.mjs`：各模块的 Node 单元测试。
- `scripts/electron/community/start.test.mjs`：用假子进程和假健康服务做编排集成测试。
- `.gitignore`：忽略生成的 `.env.opensource.local`。
- `package.json`、`apps/tabtin-electron/package.json`：增加 `dev:community` 别名。
- `apps/tabtin-electron/docs/open-source-development.md`、`open-source-development.zh-CN.md`：把一键入口提升为默认路径。
- `apps/tabtin-electron/scripts/open-source-docs-contract.test.mjs`：锁定中英文命令一致性。

---

### Task 1: CLI 参数与平台后端命令

**Files:**

- Create: `scripts/electron/community/options.mjs`
- Create: `scripts/electron/community/options.test.mjs`
- Create: `scripts/electron/community/backend.mjs`
- Create: `scripts/electron/community/backend.test.mjs`

**Interfaces:**

- Produces: `parseCommunityDevArgs(argv): CommunityDevOptions`
- Produces: `formatCommunityDevHelp(): string`
- Produces: `resolveBackendCommand(platform, rootDir): { command, args }`
- `CommunityDevOptions` shape: `{ region, skipBackend, doctor, dryRun, help }`

- [x] **Step 1: 写 CLI 参数失败测试**

```js
test('parses the non-interactive community development options', () => {
  assert.deepEqual(
    parseCommunityDevArgs(['--region', 'cn', '--skip-backend', '--dry-run']),
    {
      region: 'cn',
      skipBackend: true,
      doctor: false,
      dryRun: true,
      help: false,
    },
  )
})

test('rejects unsupported regions', () => {
  assert.throws(
    () => parseCommunityDevArgs(['--region', 'apac']),
    /auto.*cn.*global/,
  )
})
```

- [x] **Step 2: 运行参数测试并确认失败**

Run: `node --test scripts/electron/community/options.test.mjs`

Expected: FAIL，原因是 `options.mjs` 或导出函数尚不存在。

- [x] **Step 3: 实现最小参数模块**

```js
export function parseCommunityDevArgs(argv) {
  const options = {
    region: process.env.TABTIN_DEV_REGION || 'auto',
    skipBackend: false,
    doctor: false,
    dryRun: false,
    help: false,
  }
  // 逐个消费 --region/--skip-backend/--doctor/--dry-run/--help；
  // 未知参数和缺失 region 值直接 throw Error。
  return options
}
```

- [x] **Step 4: 写 Windows 与 Unix 后端适配失败测试**

```js
test('uses cmd.exe and the native batch entry on Windows', () => {
  assert.deepEqual(resolveBackendCommand('win32', 'C:\\TabTin Repo'), {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', 'call', 'scripts\\start-all.bat'],
  })
})

test('uses bash and start-all.sh on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const plan = resolveBackendCommand(platform, '/workspace/TabTin')
    assert.equal(plan.command, 'bash')
    assert.deepEqual(plan.args, ['/workspace/TabTin/scripts/backend/start.sh'])
  }
})
```

- [x] **Step 5: 运行后端适配测试并确认失败**

Run: `node --test scripts/electron/community/backend.test.mjs`

Expected: FAIL，原因是 `resolveBackendCommand()` 尚不存在。

- [x] **Step 6: 实现平台命令解析并通过测试**

Windows 以仓库根为 `cwd`，把 `call` 和固定相对路径 `scripts\\start-all.bat` 作为两个独立参数传给 `cmd.exe`；执行阶段必须使用 `shell: false`，避免仓库路径中的空格或 CMD 元字符进入命令解析。Unix 直接把绝对脚本路径作为单独参数传给 Bash。

Run: `node --test scripts/electron/community/options.test.mjs scripts/electron/community/backend.test.mjs`

Expected: PASS。

- [x] **Step 7: 提交 CLI 与平台适配**

```bash
git add scripts/electron/community/options.mjs scripts/electron/community/options.test.mjs \
  scripts/electron/community/backend.mjs scripts/electron/community/backend.test.mjs
git commit -m "feat(electron): 增加社区启动平台适配"
```

---

### Task 2: 国内外安装源自动选择与工具链 Doctor

**Files:**

- Modify: `scripts/electron/install-dependencies.mjs`
- Modify: `scripts/electron/install-dependencies.test.mjs`
- Create: `scripts/electron/community/doctor.mjs`
- Create: `scripts/electron/community/doctor.test.mjs`

**Interfaces:**

- Produces: `resolveElectronInstallRegion(requested, dependencies): Promise<'cn' | 'global'>`
- Produces: `buildElectronArtifactUrl(profile, version, platform, arch): string`
- Produces: `collectCommunityDoctorChecks(context): DoctorCheck[]`
- `DoctorCheck` shape: `{ id, ok, required, summary, remediation }`

- [x] **Step 1: 写区域优先级与网络探测失败测试**

```js
test('explicit region bypasses network probes', async () => {
  let probes = 0
  const region = await resolveElectronInstallRegion('cn', {
    probeProfile: async () => { probes += 1; return true },
  })
  assert.equal(region, 'cn')
  assert.equal(probes, 0)
})

test('auto prefers global when official registry and binary are healthy', async () => {
  const region = await resolveElectronInstallRegion('auto', {
    probeProfile: async (name) => name === 'global',
  })
  assert.equal(region, 'global')
})

test('auto falls back to cn when global is unavailable', async () => {
  const region = await resolveElectronInstallRegion('auto', {
    probeProfile: async (name) => name === 'cn',
  })
  assert.equal(region, 'cn')
})
```

- [x] **Step 2: 运行安装器测试并确认失败**

Run: `node --test scripts/electron/install-dependencies.test.mjs`

Expected: FAIL，原因是自动区域导出尚不存在。

- [x] **Step 3: 实现有超时的区域探测**

从 `apps/tabtin-electron/package.json` 读取当前 Electron 版本，使用 Node `fetch()` 和 `AbortSignal.timeout(2500)` 探测每个 profile 的 npm `/-/ping` 与该版本对应的平台压缩包。只有 registry 和二进制来源都可达才视为 profile 健康。显式 `cn/global` 不发探测请求；两者都不可用时抛出包含两个来源摘要、不包含代理凭据的错误。

- [x] **Step 4: 写 Doctor 分类失败测试**

```js
test('reports missing Go as required for a fresh Electron predev build', () => {
  const checks = collectCommunityDoctorChecks({
    platform: 'win32',
    nodeVersion: 'v20.18.0',
    packageManager: 'pnpm@9.15.0',
    commands: new Set(['node', 'pnpm', 'python']),
    backendAlreadyHealthy: false,
  })
  const go = checks.find((check) => check.id === 'go')
  assert.equal(go.ok, false)
  assert.equal(go.required, true)
  assert.match(go.remediation, /Go/)
})

test('does not require Docker when the backend is already healthy', () => {
  const checks = collectCommunityDoctorChecks({
    platform: 'win32',
    nodeVersion: 'v20.18.0',
    packageManager: 'pnpm@9.15.0',
    commands: new Set(['node', 'pnpm', 'python', 'go']),
    backendAlreadyHealthy: true,
  })
  assert.equal(checks.find((check) => check.id === 'docker').required, false)
})
```

- [x] **Step 5: 实现 Doctor 检查**

Node 与 pnpm 版本从根 `package.json` 的 `engines` 和 `packageManager` 读取。Windows Build Tools 先查 `cl.exe`，再查默认 `vswhere.exe`；macOS 调用 `xcode-select -p`；Linux 检查 `make` 与 `c++`/`g++`。pnpm 缺失但 Corepack 存在时返回可继续的调用计划，不执行 `corepack enable`。

- [x] **Step 6: 运行安装器与 Doctor 测试**

Run: `node --test scripts/electron/install-dependencies.test.mjs scripts/electron/community/doctor.test.mjs`

Expected: PASS，且原有显式 `cn/global`、dry-run 和镜像隔离测试继续通过。

- [x] **Step 7: 提交区域与 Doctor 能力**

```bash
git add scripts/electron/install-dependencies.mjs \
  scripts/electron/install-dependencies.test.mjs \
  scripts/electron/community/doctor.mjs scripts/electron/community/doctor.test.mjs
git commit -m "feat(electron): 自动选择依赖下载源"
```

---

### Task 3: 安全的社区 Electron 环境文件

**Files:**

- Create: `scripts/electron/community/environment.mjs`
- Create: `scripts/electron/community/environment.test.mjs`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `COMMUNITY_ENV_DEFAULTS: Readonly<Record<string, string>>`
- Produces: `parseEnvText(text): Record<string, string>`
- Produces: `mergeCommunityEnv(existing): Record<string, string>`
- Produces: `validateCommunityEnv(values): EnvValidationIssue[]`
- Produces: `ensureCommunityEnvFile(filePath): Promise<{ values, changed }>`

- [x] **Step 1: 写白名单和默认值失败测试**

```js
test('keeps explicit public values and never copies server secrets', () => {
  const values = mergeCommunityEnv({
    VITE_API_BASE_URL: 'http://127.0.0.1:6061/api',
    SECRET_KEY: 'must-not-survive',
    OPENAI_API_KEY: 'must-not-survive',
  })
  assert.equal(values.VITE_API_BASE_URL, 'http://127.0.0.1:6061/api')
  assert.equal('SECRET_KEY' in values, false)
  assert.equal('OPENAI_API_KEY' in values, false)
})

```

- [x] **Step 2: 运行环境测试并确认失败**

Run: `node --test scripts/electron/community/environment.test.mjs`

Expected: FAIL，原因是环境模块尚不存在。

- [x] **Step 3: 实现解析、合并与校验**

白名单严格限定为设计文档列出的九个键。验证使用 `new URL()`，拒绝未展开的 `${...}`、带用户名或密码的 URL，以及默认本地模式下的未知远端 host。错误只包含键名和安全原因，不拼接原始秘密值。

- [x] **Step 4: 写原子写入和已有配置保护失败测试**

```js
test('writes through a sibling temporary file and preserves explicit values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabtin-community-env-'))
  const file = join(dir, '.env.opensource.local')
  await writeFile(file, 'VITE_DEV_SERVER_PORT=5199\n', 'utf8')
  const result = await ensureCommunityEnvFile(file)
  assert.equal(result.values.VITE_DEV_SERVER_PORT, '5199')
  assert.equal(result.values.VITE_API_BASE_URL, 'http://127.0.0.1:6060/api')
  assert.doesNotMatch(await readFile(file, 'utf8'), /SECRET_KEY|OPENAI_API_KEY/)
})
```

- [x] **Step 5: 实现原子写入并加入忽略规则**

同目录写入 `${filePath}.tmp-${process.pid}`，成功 `rename()` 覆盖；异常时 best-effort 删除临时文件。`.gitignore` 增加精确路径 `/apps/tabtin-electron/.env.opensource.local`，不得用宽泛规则隐藏其他环境文件。

- [x] **Step 6: 运行环境测试和 Git 忽略断言**

Run: `node --test scripts/electron/community/environment.test.mjs`

Run: `git check-ignore apps/tabtin-electron/.env.opensource.local`

Expected: 测试 PASS，`git check-ignore` 输出该文件路径。

- [x] **Step 7: 提交安全环境生成器**

```bash
git add .gitignore scripts/electron/community/environment.mjs \
  scripts/electron/community/environment.test.mjs
git commit -m "feat(electron): 生成社区本地客户端配置"
```

---

### Task 4: 统一后端健康检查和启动门禁

**Files:**

- Modify: `scripts/electron/community/backend.mjs`
- Modify: `scripts/electron/community/backend.test.mjs`

**Interfaces:**

- Produces: `probeCommunityBackend(dependencies): Promise<BackendHealthReport>`
- Produces: `waitForCommunityBackend(options): Promise<BackendHealthReport>`
- Produces: `startCommunityBackend({ platform, rootDir, spawnSyncImpl }): void`
- `BackendHealthReport` shape: `{ healthy, checks: [{ id, ok, endpoint, detail }] }`

- [x] **Step 1: 写 HTTP 和 TCP 健康聚合失败测试**

```js
test('requires Django, Collab and Centrifugo before reporting healthy', async () => {
  const report = await probeCommunityBackend({
    probeHttp: async (url) => ({
      ok: !url.includes('4100'),
      text: url.includes('6060') ? 'healthy' : '',
    }),
    probeTcp: async () => true,
  })
  assert.equal(report.healthy, false)
  assert.deepEqual(
    report.checks.filter((check) => !check.ok).map((check) => check.id),
    ['collab'],
  )
})
```

- [x] **Step 2: 运行后端测试并确认失败**

Run: `node --test scripts/electron/community/backend.test.mjs`

Expected: FAIL，原因是健康聚合导出尚不存在。

- [x] **Step 3: 实现健康探测和有上限等待**

Django 请求 `http://127.0.0.1:6060/health` 并匹配 `healthy`；Collab 请求 `http://127.0.0.1:4100/health` 并匹配 `ok`；Centrifugo 使用 `node:net` 连接 `127.0.0.1:8100`。单次探测超时 1500ms，默认最多等待 60 秒，每 500ms 重试；计时器和探测函数均允许测试注入。

- [x] **Step 4: 写 `--skip-backend` 和启动失败测试**

```js
test('does not hide a non-zero native backend exit code', () => {
  assert.throws(
    () => startCommunityBackend({
      platform: 'win32',
      rootDir: 'C:\\TabTin',
      spawnSyncImpl: () => ({ status: 7 }),
    }),
    /退出码 7/,
  )
})
```

- [x] **Step 5: 实现原生后端调用**

`spawnSyncImpl(command, args, { cwd: rootDir, env: process.env, stdio: 'inherit', shell: false })`。子进程错误、signal 或非零状态都转为阶段化错误，不吞掉原退出码。`skipBackend` 的判断留给顶层编排器；本模块始终只提供显式启动函数。

- [x] **Step 6: 运行后端模块测试**

Run: `node --test scripts/electron/community/backend.test.mjs`

Expected: PASS，包括含空格 Windows 路径、Unix 路径、HTTP/TCP 失败和等待超时。

- [x] **Step 7: 提交后端健康门禁**

```bash
git add scripts/electron/community/backend.mjs scripts/electron/community/backend.test.mjs
git commit -m "feat(electron): 启动前校验本地后端健康"
```

---

### Task 5: 安装缓存与顶层一键编排

**Files:**

- Create: `scripts/electron/community/install-cache.mjs`
- Create: `scripts/electron/community/install-cache.test.mjs`
- Create: `scripts/electron/community/start.mjs`
- Create: `scripts/electron/community/start.test.mjs`
- Modify: `package.json`
- Modify: `apps/tabtin-electron/package.json`

**Interfaces:**

- Produces: `computeElectronInstallFingerprint(rootDir): Promise<string>`
- Produces: `isElectronInstallCurrent(rootDir, fingerprint): Promise<boolean>`
- Produces: `markElectronInstallCurrent(rootDir, metadata): Promise<void>`
- Consumes: Task 1–4 的参数、Doctor、区域、环境和后端接口。

- [x] **Step 1: 写安装缓存失败测试**

```js
test('invalidates the install marker when pnpm-lock.yaml changes', async () => {
  const root = await createFixtureRepo()
  const first = await computeElectronInstallFingerprint(root)
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: changed\n')
  const second = await computeElectronInstallFingerprint(root)
  assert.notEqual(first, second)
})

test('treats a missing Electron module as a cache miss', async () => {
  assert.equal(await isElectronInstallCurrent(fixtureRoot, 'abc'), false)
})
```

- [x] **Step 2: 实现非敏感安装标记**

使用 `node:crypto` 对根 `pnpm-lock.yaml`、根 `package.json` 和 Electron `package.json` 内容计算 SHA-256。标记写到 `node_modules/.cache/tabtin-community-bootstrap.json`，只保存指纹、区域和成功时间；Electron 包不可解析时一律 cache miss。

- [x] **Step 3: 写顶层阶段顺序失败测试**

```js
test('starts Electron only after dependencies, env and backend are ready', async () => {
  const calls = []
  await runCommunityDev({
    argv: ['--region', 'global'],
    doctor: async () => calls.push('doctor'),
    ensureInstall: async () => calls.push('install'),
    ensureEnv: async () => calls.push('env'),
    probeBackend: async () => ({ healthy: true, checks: [] }),
    startElectron: async () => calls.push('electron'),
  })
  assert.deepEqual(calls, ['doctor', 'install', 'env', 'electron'])
})

test('never starts Electron when backend health fails', async () => {
  let started = false
  await assert.rejects(() => runCommunityDev({
    argv: ['--skip-backend'],
    doctor: async () => {},
    ensureInstall: async () => {},
    ensureEnv: async () => {},
    probeBackend: async () => ({ healthy: false, checks: [{ id: 'django' }] }),
    startElectron: async () => { started = true },
  }), /Django/)
  assert.equal(started, false)
})
```

- [x] **Step 4: 实现 `runCommunityDev()` 和 CLI main**

实现文件导出 `runCommunityDev(dependencies)` 供测试，并只在 `process.argv[1]` 等于当前文件时调用 `main()`。依次执行帮助/dry-run、初始后端探测、Doctor、区域解析、安装缓存、环境文件、后端启动与等待、Electron 前台子进程。Electron 命令为当前 Node 解释器执行 `scripts/electron/dev.mjs --env-file apps/tabtin-electron/.env.opensource.local`。

- [x] **Step 5: 实现不写磁盘的 dry-run**

`--dry-run` 只输出区域策略、是否需要后端、平台后端命令、环境文件路径、健康目标和 Electron 命令。测试注入一个在写文件或 spawn 时抛错的依赖对象，断言 dry-run 仍成功。

- [x] **Step 6: 增加 package aliases**

根 `package.json`：

```json
"dev:community": "node scripts/dev.mjs community"
```

Electron `package.json` 使用相同根脚本：

```json
"dev:community": "node ../../scripts/dev.mjs community"
```

- [x] **Step 7: 运行编排与既有回归测试**

Run: `node --test scripts/electron/community/*.test.mjs scripts/electron/install-dependencies.test.mjs`

Expected: PASS。

Run: `node scripts/dev.mjs community --dry-run --region global`

Run: `node scripts/dev.mjs community --dry-run --region cn`

Expected: 两次都不写环境文件、不安装依赖、不启动服务，并打印不同安装源。

- [x] **Step 8: 提交一键编排入口**

```bash
git add package.json apps/tabtin-electron/package.json \
  scripts/electron/community/start.mjs \
  scripts/electron/community/install-cache.mjs \
  scripts/electron/community/install-cache.test.mjs
git commit -m "feat(electron): 串联社区一键开发启动"
```

---

### Task 6: 开源文档契约与真实 Windows 验收

**Files:**

- Modify: `apps/tabtin-electron/docs/open-source-development.md`
- Modify: `apps/tabtin-electron/docs/open-source-development.zh-CN.md`
- Modify: `apps/tabtin-electron/scripts/open-source-docs-contract.test.mjs`
- Modify: `README.md`
- Modify: `apps/tabtin-electron/docs/community-dev-bootstrap-implementation-plan.md`（只勾选已完成步骤）

**Interfaces:**

- Consumes: `node scripts/dev.mjs community` 和 `pnpm dev:community`。
- Produces: 中英文一致的社区首次启动说明和验收记录。

- [x] **Step 1: 扩展文档契约失败测试**

```js
test('both guides lead with the one-command community path', () => {
  for (const name of ['open-source-development.md', 'open-source-development.zh-CN.md']) {
    const content = read(name)
    assert.match(content, /node scripts\/start-community-dev\.mjs/)
    assert.match(content, /--region cn/)
    assert.match(content, /--skip-backend/)
  }
})
```

- [x] **Step 2: 更新中英文指南和根 README**

一键入口放在手动 doctor/install/run 之前。手动命令继续保留为高级用法和排障入口。Windows 文档明确写出 PowerShell、CMD、Git Bash 均运行同一个 Node 命令，且无需 Bash/WSL；不得在文档里复制服务端秘密或私有 URL。

- [x] **Step 3: 运行文档与全量脚本测试**

Run: `node --test apps/tabtin-electron/scripts/open-source-docs-contract.test.mjs`

Run: `node --test scripts/electron/community/*.test.mjs scripts/electron/install-dependencies.test.mjs`

Run: `pnpm exec prettier --check package.json apps/tabtin-electron/package.json scripts/dev.mjs scripts/electron/community apps/tabtin-electron/docs/open-source-development.md apps/tabtin-electron/docs/open-source-development.zh-CN.md README.md`

Expected: 全部 PASS。

- [x] **Step 4: 运行开源审计**

Run: `pnpm --dir apps/tabtin-electron audit:opensource`

Expected: PASS，生成的 `.env.opensource.local` 未进入 Git 或安装包输入。

- [x] **Step 5: 执行 Windows 真实一键启动验收**

在 PowerShell 运行：

```powershell
node scripts/dev.mjs community --region global
```

验收：Django `/health` 返回 `healthy`；Collab `/health` 返回 `ok`；8100 正在监听；5175 可访问；Electron 窗口出现并能进入登录/首页。停止 Electron 后确认后端仍运行。

随后在 Git Bash 运行：

```bash
node scripts/dev.mjs community --skip-backend
```

验收：不调用 Bash 后端脚本，不重启已健康服务，直接复用 Windows 原生后端并启动 Electron。

- [x] **Step 6: 检查测试没有生成跟踪产物**

Run: `git status --short`

Expected: 只包含本任务源码、测试、文档和计划勾选；`.codex-tmp/` 保持未跟踪且不纳入提交。

- [x] **Step 7: 提交文档和验收契约**

```bash
git add README.md apps/tabtin-electron/docs/open-source-development.md \
  apps/tabtin-electron/docs/open-source-development.zh-CN.md \
  apps/tabtin-electron/scripts/open-source-docs-contract.test.mjs \
  apps/tabtin-electron/docs/community-dev-bootstrap-implementation-plan.md
git commit -m "docs(electron): 完善社区一键启动指南"
```

---

## Completion Gate

- [x] `git merge-base --is-ancestor origin/opensource/v1 HEAD` 成功。
- [x] 所有 Node 单元和集成测试通过。
- [x] 两种 region 的 dry-run 不产生写操作。
- [x] Electron 开源审计通过。
- [x] Windows PowerShell 与 Git Bash 的真实启动验收通过。
- [x] `git status --short` 不包含意外生成的已跟踪文件。
- [x] 已知跨平台未实机覆盖项在最终汇报中明确列出。
