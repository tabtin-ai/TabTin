/**
 * MarketplaceAppInstaller — Wave D SHA256 强校验单元测试
 *
 * 覆盖 PRD §4.1 N-3 ⑤ 与 §6.5 验收：
 * 1. 缺 checksums 时拒装（默认）
 * 2. 缺 checksums + TABTIN_ALLOW_UNCHECKED_INSTALL=1 → 允许（dev/CI 豁免）
 * 3. 有 checksums 且匹配 → 安装成功
 * 4. 有 checksums 但 mismatch → 拒装
 * 5. 当前 platform 不在 platformMap 时拒装（先于 checksum 校验）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { ipcMain } from 'electron'

const tmpRoot = await mkdtemp(join(tmpdir(), 'mpinstaller-'))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_kind: string) => tmpRoot),
  },
  net: {
    fetch: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

const FAKE_BIN_CONTENT = 'fake-cli-binary'
const FAKE_BIN_SHA256 = createHash('sha256').update(Buffer.from(FAKE_BIN_CONTENT, 'utf-8')).digest('hex')

function manifestWith(checksums?: Record<string, string>): {
  id: string
  name: string
  version: string
  cli: {
    binary: string
    version: string
    downloadUrl: string
    checksums?: Record<string, string>
    platformMap: Record<string, string>
    archMap: Record<string, string>
  }
} {
  return {
    id: 'demo-app',
    name: 'Demo App',
    version: '1.0.0',
    cli: {
      binary: 'demo-cli',
      version: '1.0.0',
      downloadUrl: 'https://cdn.example/{version}-{platform}-{arch}.tar.gz',
      checksums,
      platformMap: { darwin: 'darwin', linux: 'linux', win32: 'windows' },
      archMap: { x64: 'amd64', arm64: 'arm64' },
    },
  }
}

function manifestWithUnsupportedPlatform(): {
  id: string
  name: string
  version: string
  cli: {
    binary: string
    version: string
    downloadUrl: string
    checksums?: Record<string, string>
    platformMap: Record<string, string>
    archMap: Record<string, string>
  }
} {
  // 完全不映射当前平台 → resolveDownloadUrl 与 resolveMarketplaceChecksumKey 都会失败
  return {
    id: 'demo-app',
    name: 'Demo App',
    version: '1.0.0',
    cli: {
      binary: 'demo-cli',
      version: '1.0.0',
      downloadUrl: 'https://cdn.example/{version}-{platform}-{arch}.tar.gz',
      checksums: {},
      platformMap: { freebsd: 'freebsd' },
      archMap: { mips: 'mips' },
    },
  }
}

describe('MarketplaceAppInstaller.installApp — Wave D SHA256 strong check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.TABTIN_ALLOW_UNCHECKED_INSTALL
  })

  afterEach(async () => {
    delete process.env.TABTIN_ALLOW_UNCHECKED_INSTALL
    // 清理本次安装目录，避免相邻用例干扰
    await rm(join(tmpRoot, 'marketplace-apps', 'demo-app'), {
      recursive: true,
      force: true,
    })
  })

  async function loadInstallerWithDownloadStub(content: string): Promise<{
    installer: { installApp(appId: string, manifest: unknown): Promise<void> }
    downloadCalls: number
  }> {
    vi.resetModules()
    const mod = await import('../MarketplaceAppInstaller')
    const installer = mod.getMarketplaceAppInstaller()
    let downloadCalls = 0
    vi.spyOn(installer as unknown as Record<string, unknown>, 'downloadAndExtract' as never)
      .mockImplementation((async (
        _url: string,
        destDir: string,
        binaryName: string,
      ) => {
        downloadCalls += 1
        await mkdir(destDir, { recursive: true })
        await writeFile(join(destDir, binaryName), Buffer.from(content, 'utf-8'))
      }) as never)
    return {
      installer: installer as unknown as {
        installApp(appId: string, manifest: unknown): Promise<void>
      },
      get downloadCalls() {
        return downloadCalls
      },
    } as never
  }

  it('rejects install when manifest.cli.checksums is missing (no escape hatch)', async () => {
    const { installer } = await loadInstallerWithDownloadStub(FAKE_BIN_CONTENT)
    const manifest = manifestWith(undefined)
    await expect(installer.installApp('demo-app', manifest)).rejects.toThrow(
      /E_INSTALL_CHECKSUM_MISSING/,
    )
    // 同时确认 binary 不存在（没有写入 registry/manifest.json）
    const manifestPath = join(tmpRoot, 'marketplace-apps', 'demo-app', 'manifest.json')
    await expect(readFile(manifestPath, 'utf-8').then(() => true, () => false)).resolves.toBe(
      false,
    )
  })

  it('rejects install when checksums entry for current platform is missing', async () => {
    const { installer } = await loadInstallerWithDownloadStub(FAKE_BIN_CONTENT)
    // 只填一个不存在的 key，确保当前 platform 找不到
    const manifest = manifestWith({ 'definitely-not-this-platform': 'aa' })
    await expect(installer.installApp('demo-app', manifest)).rejects.toThrow(
      /E_INSTALL_CHECKSUM_MISSING/,
    )
  })

  it('allows install when TABTIN_ALLOW_UNCHECKED_INSTALL=1 and checksums missing', async () => {
    process.env.TABTIN_ALLOW_UNCHECKED_INSTALL = '1'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { installer } = await loadInstallerWithDownloadStub(FAKE_BIN_CONTENT)
      const manifest = manifestWith(undefined)
      await installer.installApp('demo-app', manifest)
      // 安装成功后 manifest.json 写入
      const written = JSON.parse(
        await readFile(
          join(tmpRoot, 'marketplace-apps', 'demo-app', 'manifest.json'),
          'utf-8',
        ),
      )
      expect(written.id).toBe('demo-app')
      // 必须打印一条 dev/CI 豁免提示，避免静默绕过
      expect(warnSpy).toHaveBeenCalledTimes(1)
      // createLogger 会把 [模块前缀] 作为首个参数，消息在后续参数——整条 join 再匹配。
      const msg = String(warnSpy.mock.calls[0]?.join(' ') ?? '')
      expect(msg).toMatch(/SHA256 verification skipped/)
      expect(msg).toMatch(/TABTIN_ALLOW_UNCHECKED_INSTALL=1/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('allows install when checksum matches', async () => {
    const platformKey = `${process.platform === 'win32' ? 'windows' : process.platform}-${
      process.arch === 'x64' ? 'amd64' : process.arch
    }`
    const { installer } = await loadInstallerWithDownloadStub(FAKE_BIN_CONTENT)
    const manifest = manifestWith({ [platformKey]: FAKE_BIN_SHA256 })
    await installer.installApp('demo-app', manifest)
    const written = JSON.parse(
      await readFile(
        join(tmpRoot, 'marketplace-apps', 'demo-app', 'manifest.json'),
        'utf-8',
      ),
    )
    expect(written.id).toBe('demo-app')
  })

  it('rejects install when checksum mismatches even with provided checksums', async () => {
    const platformKey = `${process.platform === 'win32' ? 'windows' : process.platform}-${
      process.arch === 'x64' ? 'amd64' : process.arch
    }`
    const { installer } = await loadInstallerWithDownloadStub(FAKE_BIN_CONTENT)
    const wrongHash = 'a'.repeat(64)
    const manifest = manifestWith({ [platformKey]: wrongHash })
    await expect(installer.installApp('demo-app', manifest)).rejects.toThrow(
      /SHA256 verification failed/,
    )
    // verifyBinarySha256 在失败时会删除 binary；manifest.json 也不应被写入
    const manifestPath = join(tmpRoot, 'marketplace-apps', 'demo-app', 'manifest.json')
    await expect(readFile(manifestPath, 'utf-8').then(() => true, () => false)).resolves.toBe(
      false,
    )
  })

  it('rejects install when current platform/arch is not in platformMap (URL resolve fails first)', async () => {
    const { installer } = await loadInstallerWithDownloadStub(FAKE_BIN_CONTENT)
    const manifest = manifestWithUnsupportedPlatform()
    await expect(installer.installApp('demo-app', manifest)).rejects.toThrow(
      /No CLI binary available for current platform/,
    )
  })

  it('mismatch is rejected even when escape hatch is set (env var only excuses missing checksums)', async () => {
    process.env.TABTIN_ALLOW_UNCHECKED_INSTALL = '1'
    const platformKey = `${process.platform === 'win32' ? 'windows' : process.platform}-${
      process.arch === 'x64' ? 'amd64' : process.arch
    }`
    const { installer } = await loadInstallerWithDownloadStub(FAKE_BIN_CONTENT)
    const wrongHash = 'b'.repeat(64)
    const manifest = manifestWith({ [platformKey]: wrongHash })
    await expect(installer.installApp('demo-app', manifest)).rejects.toThrow(
      /SHA256 verification failed/,
    )
  })

  it('wraps marketplace local lifecycle IPC handlers in envelopes', async () => {
    vi.resetModules()
    const mod = await import('../MarketplaceAppInstaller')
    const installer = mod.getMarketplaceAppInstaller()
    vi.spyOn(installer, 'installApp').mockResolvedValue(undefined)
    vi.spyOn(installer, 'uninstallApp').mockResolvedValue(undefined)
    vi.spyOn(installer, 'checkForUpdates').mockResolvedValue({
      appId: 'demo-app',
      currentVersion: '1.0.0',
      newVersion: '1.0.1',
      downloadUrl: 'https://cdn.example/demo-app.tar.gz',
    })
    vi.spyOn(installer, 'upgradeApp').mockResolvedValue(undefined)
    vi.spyOn(installer, 'getCliPath').mockReturnValue('/tmp/demo-cli')

    const handleMock = vi.mocked(ipcMain.handle)
    handleMock.mockClear()
    mod.registerMarketplaceAppIpc()
    const handlers = new Map(
      handleMock.mock.calls.map(([channel, handler]) => [channel, handler]),
    )

    await expect(
      handlers.get('marketplace:install-app')?.({}, 'demo-app', manifestWith({})),
    ).resolves.toMatchObject({ ok: true, data: { success: true } })
    await expect(
      handlers.get('marketplace:uninstall-app')?.({}, 'demo-app'),
    ).resolves.toMatchObject({ ok: true, data: { success: true } })
    await expect(
      handlers.get('marketplace:check-updates')?.({}, 'demo-app', manifestWith({})),
    ).resolves.toMatchObject({ ok: true, data: { appId: 'demo-app' } })
    await expect(
      handlers.get('marketplace:upgrade-app')?.({}, 'demo-app', manifestWith({})),
    ).resolves.toMatchObject({ ok: true, data: { success: true } })
    expect(handlers.get('marketplace:get-cli-path')?.({}, 'demo-app')).toMatchObject({
      ok: true,
      data: '/tmp/demo-cli',
    })
  })

  it('installs official plugin releases through the agent-runtime catalog seam', async () => {
    vi.resetModules()
    const mod = await import('../MarketplaceAppInstaller')
    const installer = mod.getMarketplaceAppInstaller()
    try {
      const record = await installer.installOfficialPluginRelease(
        'tabtin-minimal-codex-plugin@0.1.0+official.1',
      )
      expect(record.upstream).toMatchObject({
        packageName: 'minimal-codex-plugin',
        version: '0.1.0',
      })
      expect(record.officialRelease).toMatchObject({
        id: 'tabtin-minimal-codex-plugin@0.1.0+official.1',
        version: '0.1.0+official.1',
      })
      expect(record.capabilityManifest.hooks.every((hook) => hook.displayOnly)).toBe(true)

      const installed = await installer.listInstalledApps()
      expect(installed['tabtin-minimal-codex-plugin']).toMatchObject({
        version: '0.1.0+official.1',
        upstreamPlugin: {
          packageName: 'minimal-codex-plugin',
        },
        officialPluginRelease: {
          id: 'tabtin-minimal-codex-plugin@0.1.0+official.1',
        },
      })
    } finally {
      await rm(join(tmpRoot, 'marketplace-apps', 'official-plugins'), {
        recursive: true,
        force: true,
      })
      await rm(join(tmpRoot, 'marketplace-apps', 'registry.json'), { force: true })
    }
  })
})
