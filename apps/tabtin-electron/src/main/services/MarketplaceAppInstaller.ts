/**
 * MarketplaceAppInstaller — 市场应用 CLI 生命周期管理
 *
 * 负责 device 级市场应用的 CLI 二进制下载、安装、升级、卸载。
 * 安装记录存在本地 registry.json，不依赖后端 DB。
 */

import { app, ipcMain, BrowserWindow, session } from 'electron'
import { createWriteStream, existsSync, readFileSync } from 'fs'
import { mkdir, readFile, writeFile, rm, chmod, copyFile, readdir, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
// contract W2-α 漏修补 (2026-05-04)：marketplace:list-installed 之前返裸
// `Record<appId, InstalledAppInfo>`，既不是 envelope 也不在 LEGACY_HANDLERS
// 白名单，invokeIpc shim 进 Tier 0 → 抛 LEGACY_SHAPE。
// 修法：handler 改返 envelope `{ok:true, data}`，invokeIpc 自动 unwrap，
// renderer caller (`useSpaceApps.ts`) 拿到的形态完全一致（仍是 record 对象）。
import { okResponse } from '@tabtin/agent-wire'
// dogfood 4d2108a2 第 7 轮：删除 dead imports —— 实际抽取走 shell `tar -xzf`
// 命令（行 196 `execFileAsync('tar', ['-xzf', ...])`），不需要 stream/promises
// pipeline / zlib createGunzip / 'tar' npm 包的 Extract API。这些 import 一直
// 是死代码，但 esbuild 不报错让它进 dist；缩小 main typecheck 范围后 tsc 抓
// 出 'tar' 包 types 缺失（实际是包都没声明依赖），整理时一并删除。
import { net } from 'electron'
import { registerStorageBucket } from '@tabtin/storage-manager'
import {
  createBundledOfficialPluginCatalog,
  installOfficialPluginRelease,
  type InstalledOfficialPluginRecord,
  type OfficialPluginCapabilityManifest,
  type UpstreamPluginIdentity,
} from '@tabtin/agent-runtime/official-plugins'

import {
  resolveMarketplaceChecksumKey,
  verifyBinarySha256,
} from './marketplaceCliChecksum'
import { createLogger } from '../logger'

const log = createLogger('MarketplaceAppInstaller')

const execFileAsync = promisify(execFile)

// ─── Types ───────────────────────────────────────────────────

interface CliConfig {
  binary: string
  version: string
  downloadUrl: string
  checksums?: Record<string, string>
  platformMap: Record<string, string>
  archMap: Record<string, string>
}

interface AppManifest {
  id: string
  name: string
  version: string
  cli?: CliConfig
  skills?: {
    directory: string
    autoLoad: string[]
    onDemand: string[]
  }
  [key: string]: unknown
}

interface InstalledAppInfo {
  version: string
  installedAt: string
  binaryPath?: string
  packagePath?: string
  manifestVersion: string
  upstreamPlugin?: UpstreamPluginIdentity
  officialPluginRelease?: InstalledOfficialPluginRecord['officialRelease']
  capabilityManifest?: OfficialPluginCapabilityManifest
}

interface RegistryData {
  [appId: string]: InstalledAppInfo
}

interface UpdateInfo {
  appId: string
  currentVersion: string
  newVersion: string
  downloadUrl: string
}

// ─── Service ─────────────────────────────────────────────────

class MarketplaceAppInstaller {
  private basePath: string
  private registryPath: string

  constructor() {
    this.basePath = join(app.getPath('userData'), 'marketplace-apps')
    this.registryPath = join(this.basePath, 'registry.json')
  }

  /** 暴露给 storage-manager bucket 注册聚合容量用，业务调用方仍走 getCliPath */
  public getBasePath(): string {
    return this.basePath
  }

  /** 暴露给 storage-manager bucket 注册扫单条 App 占用 */
  public getAppDir(appId: string): string {
    return join(this.basePath, appId)
  }

  /** 暴露给 storage-manager bucket 注册做单文件 stat */
  public getRegistryPath(): string {
    return this.registryPath
  }

  private resolveOfficialPluginBundledRoot(explicitRoot?: string): string | undefined {
    if (explicitRoot) return explicitRoot
    const isPackaged = (app as { isPackaged?: boolean }).isPackaged === true
    return isPackaged ? join(process.resourcesPath, 'official-plugins') : undefined
  }

  // ── Install ──────────────────────────────────────────────────

  /**
   * 安装 marketplace App。
   *
   * Wave D（2026-04-17）SHA256 强校验：
   * - 默认必须能在 manifest `cli.checksums` 中找到当前 platform/arch 对应的哈希；
   *   缺失或当前 platform 无映射时**拒装**（PRD §6.5 / §10.3 Expand-Contract）。
   * - dev/CI 通过 `TABTIN_ALLOW_UNCHECKED_INSTALL=1` 显式豁免；生产构建强校验。
   * - 无论是否豁免，只要 manifest 提供了对应 checksum，都会校验失败时拒装（不允许悄悄绕过）。
   */
  async installApp(appId: string, manifest: AppManifest): Promise<void> {
    const cli = manifest.cli
    if (!cli) {
      throw new Error(`App ${appId} has no CLI configuration in manifest`)
    }
    log.info(`安装开始 appId=${appId} version=${cli.version} platform=${process.platform}/${process.arch}`)

    const appDir = join(this.basePath, appId)
    const binDir = join(appDir, 'bin')
    await mkdir(binDir, { recursive: true })

    const binaryDest = join(binDir, cli.binary)

    const url = this.resolveDownloadUrl(cli)
    if (!url) {
      throw new Error(`No CLI binary available for current platform`)
    }

    const checksumKey = resolveMarketplaceChecksumKey(
      { platformMap: cli.platformMap, archMap: cli.archMap },
      process.platform,
      process.arch,
    )
    const expectedChecksum = checksumKey ? cli.checksums?.[checksumKey] : undefined
    const allowUnchecked = process.env.TABTIN_ALLOW_UNCHECKED_INSTALL === '1'

    if (!expectedChecksum && !allowUnchecked) {
      throw new Error(
        `[E_INSTALL_CHECKSUM_MISSING] Refusing to install '${appId}': ` +
          `manifest.cli.checksums is missing entry for '${checksumKey ?? 'current platform'}'. ` +
          `Set TABTIN_ALLOW_UNCHECKED_INSTALL=1 only for dev/CI.`,
      )
    }

    await this.downloadAndExtract(url, binDir, cli.binary)

    if (expectedChecksum) {
      await verifyBinarySha256(binaryDest, expectedChecksum)
    } else if (allowUnchecked) {
      log.warn(
        `'${appId}': SHA256 verification skipped ` +
          `because TABTIN_ALLOW_UNCHECKED_INSTALL=1 (dev/CI escape hatch). ` +
          `Production builds must populate manifest.cli.checksums.`,
      )
    }

    await chmod(binaryDest, 0o755)

    await writeFile(
      join(appDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    )

    await this.updateRegistry(appId, {
      version: cli.version,
      installedAt: new Date().toISOString(),
      binaryPath: binaryDest,
      manifestVersion: manifest.version,
    })
    log.info(`安装完成 appId=${appId} version=${cli.version}`)
  }

  async installOfficialPluginRelease(
    releaseId: string,
    options: { bundledRoot?: string } = {},
  ): Promise<InstalledOfficialPluginRecord> {
    const catalog = createBundledOfficialPluginCatalog({
      bundledRoot: this.resolveOfficialPluginBundledRoot(options.bundledRoot),
    })
    const record = await installOfficialPluginRelease({
      catalog,
      releaseId,
      installRoot: join(this.basePath, 'official-plugins'),
    })

    await this.updateRegistry(record.pluginId, {
      version: record.officialRelease.version,
      installedAt: record.installedAt,
      packagePath: record.packagePath,
      manifestVersion: String(record.capabilityManifest.manifestVersion),
      upstreamPlugin: record.upstream,
      officialPluginRelease: record.officialRelease,
      capabilityManifest: record.capabilityManifest,
    })

    return record
  }

  private resolveDownloadUrl(cli: CliConfig): string | null {
    const platform = cli.platformMap[process.platform]
    const arch = cli.archMap[process.arch]
    if (!platform || !arch) return null

    return cli.downloadUrl
      .replace('{version}', cli.version)
      .replace('{platform}', platform)
      .replace('{arch}', arch)
  }

  private async downloadAndExtract(
    url: string,
    destDir: string,
    _binaryName: string,
  ): Promise<void> {
    const tmpPath = join(destDir, `_download_${Date.now()}.tar.gz`)

    try {
      log.info(`下载 CLI 二进制: ${url}`)
      const response = await net.fetch(url)
      if (!response.ok) {
        log.error(`下载失败 status=${response.status} ${response.statusText} url=${url}`)
        throw new Error(`Download failed: ${response.status} ${response.statusText}`)
      }

      const body = response.body
      if (!body) throw new Error('Empty response body')

      const fileStream = createWriteStream(tmpPath)
      const reader = body.getReader()

      const writeToFile = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          fileStream.write(Buffer.from(value))
        }
        fileStream.end()
        await new Promise<void>((resolve, reject) => {
          fileStream.on('finish', resolve)
          fileStream.on('error', reject)
        })
      }

      await writeToFile()

      await execFileAsync('tar', ['-xzf', tmpPath, '-C', destDir])
    } finally {
      if (existsSync(tmpPath)) {
        await rm(tmpPath, { force: true })
      }
    }
  }

  // ── Upgrade ──────────────────────────────────────────────────

  async checkForUpdates(
    appId: string,
    latestManifest: AppManifest,
  ): Promise<UpdateInfo | null> {
    const registry = await this.readRegistry()
    const installed = registry[appId]
    if (!installed) return null

    const latestCli = latestManifest.cli
    if (!latestCli) return null

    if (installed.version === latestCli.version) return null

    const url = this.resolveDownloadUrl(latestCli)
    if (!url) return null

    return {
      appId,
      currentVersion: installed.version,
      newVersion: latestCli.version,
      downloadUrl: url,
    }
  }

  async upgradeApp(appId: string, manifest: AppManifest): Promise<void> {
    const registry = await this.readRegistry()
    const installed = registry[appId]
    if (!installed) {
      throw new Error(`App ${appId} is not installed`)
    }
    if (!installed.binaryPath) {
      throw new Error(`App ${appId} has no CLI binary to upgrade`)
    }

    const appDir = join(this.basePath, appId)
    const backupDir = join(appDir, 'backup')
    await mkdir(backupDir, { recursive: true })

    const cli = manifest.cli!
    const oldBinaryPath = installed.binaryPath
    const backupPath = join(backupDir, `${cli.binary}.${installed.version}`)

    if (existsSync(oldBinaryPath)) {
      await copyFile(oldBinaryPath, backupPath)
    }

    log.info(`升级开始 appId=${appId} ${installed.version} → ${cli.version}`)
    try {
      await this.installApp(appId, manifest)

      const binaryPath = join(appDir, 'bin', cli.binary)
      try {
        await execFileAsync(binaryPath, ['--version'])
      } catch {
        if (existsSync(backupPath)) {
          await copyFile(backupPath, binaryPath)
          await this.updateRegistry(appId, {
            ...installed,
            version: installed.version,
          })
        }
        log.warn(`升级校验失败，已回滚 appId=${appId} → ${installed.version}`)
        throw new Error(`Upgrade verification failed, rolled back to ${installed.version}`)
      }
      log.info(`升级完成 appId=${appId} version=${cli.version}`)
    } catch (err) {
      if (existsSync(backupPath) && !existsSync(oldBinaryPath)) {
        await copyFile(backupPath, oldBinaryPath)
      }
      log.error(`升级失败 appId=${appId}:`, err instanceof Error ? err.message : err)
      throw err
    }
  }

  // ── Uninstall ────────────────────────────────────────────────

  async uninstallApp(appId: string): Promise<void> {
    const appDir = join(this.basePath, appId)

    if (existsSync(appDir)) {
      await rm(appDir, { recursive: true, force: true })
    }

    const registry = await this.readRegistry()
    delete registry[appId]
    await this.writeRegistry(registry)
    log.info(`卸载完成 appId=${appId}`)
  }

  // ── Query ────────────────────────────────────────────────────

  getCliPath(appId: string): string | null {
    try {
      const registryData = JSON.parse(
        readFileSync(this.registryPath, 'utf-8'),
      ) as RegistryData
      return registryData[appId]?.binaryPath ?? null
    } catch {
      return null
    }
  }

  getInstalledVersion(appId: string): string | null {
    try {
      const registryData = JSON.parse(
        readFileSync(this.registryPath, 'utf-8'),
      ) as RegistryData
      return registryData[appId]?.version ?? null
    } catch {
      return null
    }
  }

  async listInstalledApps(): Promise<Record<string, InstalledAppInfo>> {
    return this.readRegistry()
  }

  // ── Registry ─────────────────────────────────────────────────

  private async readRegistry(): Promise<RegistryData> {
    try {
      const data = await readFile(this.registryPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return {}
    }
  }

  private async writeRegistry(data: RegistryData): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true })
    await writeFile(this.registryPath, JSON.stringify(data, null, 2), 'utf-8')
  }

  private async updateRegistry(
    appId: string,
    info: InstalledAppInfo,
  ): Promise<void> {
    const registry = await this.readRegistry()
    registry[appId] = info
    await this.writeRegistry(registry)
  }
}

// ─── Singleton + IPC ─────────────────────────────────────────

let _instance: MarketplaceAppInstaller | null = null

export function getMarketplaceAppInstaller(): MarketplaceAppInstaller {
  if (!_instance) {
    _instance = new MarketplaceAppInstaller()
  }
  return _instance
}

// ── storage-manager 注册（W2.2 G1，business-app）────────────────
//
// Marketplace App 安装位置：{userData}/marketplace-apps/
//   ├── registry.json
//   └── {appId}/{manifest.json + bin/{binary} + backup/...}
//
// sizeFn 递归扫每个 appId 目录获取真实占用（CLI 二进制通常 10-100MB 量级）。

async function _dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        total += await _dirSize(full)
      } else if (entry.isFile()) {
        const st = await stat(full)
        total += st.size
      }
    } catch {
      // ignore
    }
  }
  return total
}

interface MarketplaceBucketEntry {
  appId: string
  bytes: number
  version?: string
  installedAt?: string
}

async function _aggregateMarketplaceSize(): Promise<{
  bytes: number
  itemCount: number
  entries: MarketplaceBucketEntry[]
}> {
  const installer = getMarketplaceAppInstaller()
  let registry: Record<string, InstalledAppInfo> = {}
  try {
    registry = await installer.listInstalledApps()
  } catch {
    return { bytes: 0, itemCount: 0, entries: [] }
  }

  // R3-2/R3-9 双修：(a) 并发扫每个 appId 目录避免串行 N+1；
  // (b) 路径全部走 installer.getAppDir / getRegistryPath，不再硬编码 'marketplace-apps'。
  const sizeResults = await Promise.all(
    Object.entries(registry).map(async ([appId, info]) => {
      const bytes = await _dirSize(installer.getAppDir(appId))
      return { appId, bytes, version: info.version, installedAt: info.installedAt }
    }),
  )

  let totalBytes = sizeResults.reduce((acc, r) => acc + r.bytes, 0)
  // 顺手把 registry.json 自身计入（极小）
  try {
    const registryStat = await stat(installer.getRegistryPath())
    totalBytes += registryStat.size
  } catch {
    // not present
  }

  return { bytes: totalBytes, itemCount: sizeResults.length, entries: sizeResults }
}

// 注册函数幂等：重复调用会因 storage-manager 抛 BucketAlreadyRegisteredError，
// 在 try/catch 里吞掉，HMR / 测试场景下都安全。

export function registerMarketplaceAppsBucket(): () => void {

  let unregister: (() => void) | undefined
  try {
    unregister = registerStorageBucket({
      id: 'marketplace:apps',
      category: 'semi-cache',
      group: 'business-app',
      displayName: '已安装的市场应用',
      description: '你从「应用市场」里安装的工具应用，包含可执行文件和应用配置；也包含每个应用自己存的登录状态、本地缓存。',
      warnings: [
        '清理后已安装的市场应用会被卸载，需要重新去市场安装才能用',
        '应用内你登录过的账号、本地缓存等也会被一并清掉，重装后需要重新登录',
        '清理过程中不要同时打开使用对应应用',
      ],
      requiresConfirmation: 'soft',
      sizeFn: async () => {
        const { bytes, itemCount } = await _aggregateMarketplaceSize()
        return { bytes, itemCount }
      },
      listFn: async () => {
        const { entries } = await _aggregateMarketplaceSize()
        return entries.map((entry) => ({
          id: entry.appId,
          label: `${entry.appId}${entry.version ? ` v${entry.version}` : ''}`,
          bytes: entry.bytes,
          metadata: {
            version: entry.version,
            installedAt: entry.installedAt,
          },
        }))
      },
      clearFn: async (options) => {
        const { bytes, itemCount, entries } = await _aggregateMarketplaceSize()

        if (options?.dryRun) {
          if (options.itemIds?.length) {
            const idSet = new Set(options.itemIds)
            let bytesEstimate = 0
            let countEstimate = 0
            for (const entry of entries) {
              if (idSet.has(entry.appId)) {
                bytesEstimate += entry.bytes
                countEstimate += 1
              }
            }
            return { clearedItemCount: countEstimate, freedBytes: bytesEstimate }
          }
          return { clearedItemCount: itemCount, freedBytes: bytes }
        }

        const installer = getMarketplaceAppInstaller()
        const target = options?.itemIds && options.itemIds.length > 0
          ? entries.filter((entry) => options.itemIds!.includes(entry.appId))
          : entries

        const errors: string[] = []
        let cleared = 0
        let freed = 0
        for (const entry of target) {
          try {
            await installer.uninstallApp(entry.appId)
            // R3-3 修复：marketplace 应用使用 persist:marketplace-${appId} partition
            // （见 view-factory/session-config.ts:82）。卸载时必须级联清掉
            // partition 数据，否则 cookies / localStorage / IDB 会持续累积，
            // 重装后还会把上一轮的状态继承下来，违反"卸载即彻底"的用户期望。
            try {
              const partitionSession = session.fromPartition(`persist:marketplace-${entry.appId}`)
              await partitionSession.clearStorageData()
            } catch (err) {
              log.warn(`清理 partition 失败 appId=${entry.appId}:`, err instanceof Error ? err.message : String(err))
              errors.push(`${entry.appId} partition: ${err instanceof Error ? err.message : String(err)}`)
            }
            cleared += 1
            freed += entry.bytes
          } catch (err) {
            errors.push(`${entry.appId}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return { clearedItemCount: cleared, freedBytes: freed, errors: errors.length ? errors : undefined }
      },
    })
  } catch (err) {
    try { unregister?.() } catch { /* swallow */ }
    log.warn('storage-manager bucket registration skipped:', err instanceof Error ? err.message : err)
    return () => undefined
  }

  return () => {
    try { unregister?.() } catch { /* swallow */ }
  }
}

export function registerMarketplaceAppIpc(): void {
  const installer = getMarketplaceAppInstaller()

  ipcMain.handle('marketplace:install-app', async (_event, appId: string, manifest: AppManifest) => {
    log.info(`IPC marketplace:install-app appId=${appId}`)
    try {
      await installer.installApp(appId, manifest)
    } catch (err) {
      log.error(`IPC marketplace:install-app 失败 appId=${appId}:`, err instanceof Error ? err.message : err)
      throw err
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('marketplace:app-installed', { appId })
    }
    return okResponse({ success: true })
  })

  ipcMain.handle(
    'marketplace:install-official-plugin-release',
    async (_event, releaseId: string, options?: { bundledRoot?: string }) => {
      log.info(`IPC marketplace:install-official-plugin-release releaseId=${releaseId}`)
      let record: InstalledOfficialPluginRecord
      try {
        record = await installer.installOfficialPluginRelease(releaseId, options)
      } catch (err) {
        log.error(`IPC install-official-plugin-release 失败 releaseId=${releaseId}:`, err instanceof Error ? err.message : err)
        throw err
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('marketplace:app-installed', {
            appId: record.pluginId,
            officialReleaseId: record.officialRelease.id,
          })
        }
      }
      return okResponse(record)
    },
  )

  ipcMain.handle('marketplace:uninstall-app', async (_event, appId: string) => {
    log.info(`IPC marketplace:uninstall-app appId=${appId}`)
    try {
      await installer.uninstallApp(appId)
    } catch (err) {
      log.error(`IPC marketplace:uninstall-app 失败 appId=${appId}:`, err instanceof Error ? err.message : err)
      throw err
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('marketplace:app-uninstalled', { appId })
    }
    return okResponse({ success: true })
  })

  ipcMain.handle('marketplace:check-updates', async (_event, appId: string, manifest: AppManifest) => {
    return okResponse(await installer.checkForUpdates(appId, manifest))
  })

  ipcMain.handle('marketplace:upgrade-app', async (_event, appId: string, manifest: AppManifest) => {
    log.info(`IPC marketplace:upgrade-app appId=${appId}`)
    try {
      await installer.upgradeApp(appId, manifest)
    } catch (err) {
      log.error(`IPC marketplace:upgrade-app 失败 appId=${appId}:`, err instanceof Error ? err.message : err)
      throw err
    }
    return okResponse({ success: true })
  })

  ipcMain.handle('marketplace:get-cli-path', (_event, appId: string) => {
    return okResponse(installer.getCliPath(appId))
  })

  // Marketplace 本地生命周期 IPC 统一返回 envelope；invokeIpc 自动 unwrap 后，
  // renderer caller 继续拿原始 data，避免成功路径被误判为 LEGACY_SHAPE。
  ipcMain.handle('marketplace:list-installed', async () => {
    const installed = await installer.listInstalledApps()
    return okResponse(installed)
  })
}
