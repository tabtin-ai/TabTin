import { hostname } from 'os'
import { basename, join, resolve, extname, sep } from 'path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import * as fsSync from 'node:fs'

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker } from 'electron'

import { buildSystemUserAgent } from './utils/system-ua'
import { getDeviceFingerprint } from './utils/deviceFingerprint'
import { collectLocalNetworkAddresses } from './local-network-addresses'
import {
  DEVICE_IDENTITY_IPC_CHANNEL,
  registerDeviceIdentityIpcHandler,
} from './device-identity-ipc'
import { registerRunSessionIpcHandlers } from './run-session/ipc'
import { registerSessionIpcHandlers } from './session/ipc'
import { registerTerminalIpcHandlers } from './terminal/ipc'
import { registerCrawlspaceContextIpcHandlers } from './crawlspace/ipc'
import { registerMarketplaceAppIpc } from './services/MarketplaceAppInstaller'
import { registerAppDiscoveryIpc, initAppDiscoveryPatterns } from './services/AppDiscoveryService'
import { registerOverlayIpc, OVERLAY_IPC_CHANNELS } from './overlay/overlay-ipc'
import { getMainWindow, getIMWindow } from './window-manager'
import { setSearchEngineTemplate } from './context-menu/browser-search-engine'
import { okResponse, errResponse } from '@tabtin/agent-wire'
import { guardedHandle, guardedOn } from './utils/guarded-handle'
import { registerSurfaceAsIpc } from './wire/register-surface-as-ipc'
import {
  registerAgentImportSurfaces,
  IMPORT_SURFACE_CHANNELS,
  IMPORT_ARCHIVE_CHANNELS,
} from './agent-import'
import { createSpaceSetActiveSurface } from '@tabtin/cli-server-core/surfaces/space-set-active'
import { createSkillInstallSurface } from '@tabtin/cli-server-core/surfaces/skill-install'
import { createSkillUninstallSurface } from '@tabtin/cli-server-core/surfaces/skill-uninstall'
import { setCLISpaceContext } from './cli/cli-server'
import { getCLIOrganizationId } from './cli/cli-context'
import { requestSpacePrewarm } from './agent/space-prewarm'
import { setCurrentSpaceDevicePermissions } from './cli/cli-space-desktop-cache'
import { resolveSpacesRoot, resolveDataRoot } from '@tabtin/terminal-core'
import {
  resolveSpaceWorkspaceRoot,
  resolveOrganizationSkillDir,
  resolveUserSkillDir,
} from '@tabtin/agent-runtime'
import { installSkillFromBundle, uninstallSkillLocal, isValidSkillKey } from '@tabtin/agent-host/skills'
import { TokenManager } from './auth'
import { stat } from 'node:fs/promises'
import * as DesktopUseGuard from './services/DesktopUseGuard'
import { getOsPermissions } from './services/os-permissions'
import type { PermissionKind } from './services/os-permissions'
import type { CapabilityDiscoveryService } from './services/CapabilityDiscoveryService'
import type { UpdateManager } from './services/UpdateManager'
import { registerOssPresignedUploadIpc } from './services/OssPresignedUploadIpc'
import { registerOpenAICodexIpc, OPENAI_CODEX_IPC_CHANNELS } from './llm/openai-codex-ipc'
import { registerCodexSessionShareIpc } from './codex-session-share-ipc'
import { createLogger } from './logger'
import {
  readAppearanceThemeSnapshot,
  type AppearanceThemeSnapshot,
} from './appearance-theme-snapshot'
import type {
  MainWindowAppearance,
} from './types/runtime'

const mainLog = createLogger('Main')
const ipcLog = createLogger('MainIPC')

export interface MainProcessIpcRegistryDependencies {
  getUpdateManager: () => UpdateManager | null
  getCapabilityDiscoveryService: () => CapabilityDiscoveryService
  getCurrentAppearance: () => MainWindowAppearance
  getPrimaryWindow: () => BrowserWindow | null
  applyAppearance: (appearance: MainWindowAppearance) => AppearanceThemeSnapshot
  openIMWindow: () => BrowserWindow
}

export function registerMainProcessIPCHandlers(
  dependencies: MainProcessIpcRegistryDependencies,
): void {
  let sleepBlockerId: number | null = null

  ipcMain.handle('ping', () => 'pong')
  registerOssPresignedUploadIpc()
  registerOpenAICodexIpc()
  registerCodexSessionShareIpc()

  guardedOn('browser-prefs:search-engine-template', (_event, template: string) => {
    setSearchEngineTemplate(template)
  })

  guardedOn('browser-prefs:access-policy', async (_event, policy: string) => {
    try {
      const { getSharedAccessStrategyService } = await import('@tabtin/browser-core')
      const service = getSharedAccessStrategyService()
      service.setPolicy(policy as 'auto' | 'enhanced' | 'off')
      ipcLog.info(`用户切换访问策略: ${policy}`)
    } catch (err) {
      ipcLog.warn('访问策略同步失败:', err)
    }
  })

  guardedHandle('system:getHostname', () => {
    try { return hostname() } catch { return '' }
  })

  guardedHandle('system:get-local-network-addresses', () =>
    okResponse(collectLocalNetworkAddresses()),
  )

  guardedHandle('device:getFingerprint', () => getDeviceFingerprint())
  registerDeviceIdentityIpcHandler()

  guardedHandle('get-system-ua', () => {
    return buildSystemUserAgent()
  })

  guardedHandle('get-app-version', () => {
    return app.getVersion()
  })

  guardedHandle('clipboard:writeImage', async (_event, rawBytes: ArrayBuffer | Uint8Array) => {
    try {
      const byteLength = rawBytes instanceof ArrayBuffer
        ? rawBytes.byteLength
        : ArrayBuffer.isView(rawBytes)
          ? rawBytes.byteLength
          : 0
      if (byteLength <= 0 || byteLength > 100 * 1024 * 1024) {
        return { success: false, error: 'invalid image data' }
      }
      const { copyImageBufferToClipboard } = await import('./clipboard-media')
      copyImageBufferToClipboard(rawBytes)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  guardedHandle('get-update-state', () => {
    return dependencies.getUpdateManager()?.getState() ?? null
  })

  guardedHandle('get-release-history', async (_event, options) => {
    return dependencies.getUpdateManager()?.fetchReleaseHistory(options) ?? []
  })

  guardedHandle('check-for-updates', async () => {
    return dependencies.getUpdateManager()?.checkForUpdates(false)
  })

  guardedHandle('download-update', async () => {
    return dependencies.getUpdateManager()?.downloadUpdate()
  })

  guardedHandle('quit-and-install', () => {
    dependencies.getUpdateManager()?.quitAndInstall()
  })

  guardedHandle('power:prevent-sleep', () => {
    if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) return
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  })
  guardedHandle('power:allow-sleep', () => {
    if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) {
      powerSaveBlocker.stop(sleepBlockerId)
      sleepBlockerId = null
    }
  })

  registerTerminalIpcHandlers()
  registerRunSessionIpcHandlers()
  registerSessionIpcHandlers()
  registerCrawlspaceContextIpcHandlers()

  registerMarketplaceAppIpc()
  registerAppDiscoveryIpc()
  initAppDiscoveryPatterns()

  // ── skill:install / skill:uninstall（：users/{userId}/[organizations/…/]skills）
  const resolveAuthUserId = async (): Promise<string | undefined> => {
    const userInfo = await TokenManager.getUserInfo()
    const raw =
      (userInfo?.id as unknown) ??
      (userInfo?.user_id as unknown) ??
      (userInfo?.userId as unknown)
    if (raw === undefined || raw === null || raw === '') return undefined
    return String(raw)
  }

  const resolveSkillDirForUser = (
    skillKey: string,
    ctx: { userId: string; organizationId?: string },
  ): string => {
    const orgId = ctx.organizationId ?? getCLIOrganizationId() ?? undefined
    if (orgId) {
      return resolveOrganizationSkillDir(resolveDataRoot(), ctx.userId, orgId, skillKey)
    }
    return resolveUserSkillDir(resolveDataRoot(), ctx.userId, skillKey)
  }

  const skillInstall = createSkillInstallSurface({
    isValidSkillKey,
    resolveSkillDir: resolveSkillDirForUser,
    resolveUserId: resolveAuthUserId,
    installSkillFromBundle,
  })
  registerSurfaceAsIpc(skillInstall)

  const skillUninstall = createSkillUninstallSurface({
    isValidSkillKey,
    resolveSkillDir: resolveSkillDirForUser,
    resolveUserId: resolveAuthUserId,
    uninstallSkillLocal,
    statOrNull: (path) =>
      stat(path).catch((err: NodeJS.ErrnoException) => {
        if (err?.code === 'ENOENT') return null
        throw err
      }),
  })
  registerSurfaceAsIpc(skillUninstall)

  // ：目录 Skill 发现（与注入共用 scanWorkspaceForSurface；无 Trust 门控）。
  // 必须返 envelope：ipc-shim 对非 LEGACY channel 拒非 envelope 形状。
  guardedHandle('skill:workspace-scan', async (_event, params: { workspaceRoot?: string; force?: boolean }) => {
    const workspaceRoot = typeof params?.workspaceRoot === 'string' ? params.workspaceRoot : ''
    if (!workspaceRoot) {
      return {
        ok: false as const,
        error: { code: 'INVALID_ROOT', message: 'invalid workspaceRoot' },
      }
    }
    try {
      const { scanWorkspaceForSurface } = await import('./agent/workspace-skills-context')
      const result = await scanWorkspaceForSurface(workspaceRoot, {
        force: params?.force === true,
        onWarn: (msg) => ipcLog.info(`[workspace-scan] ${msg}`),
      })
      if (!result) {
        return {
          ok: false as const,
          error: { code: 'OUT_OF_SCOPE', message: 'workspaceRoot out of allowed scope' },
        }
      }
      return {
        ok: true as const,
        data: {
          truncated: result.truncated,
          skills: result.skills.map((s) => ({
            key: s.canonicalKey,
            slug: s.slug,
            name: s.name,
            display_name: s.displayName,
            description: s.description,
            emoji: s.emoji,
            rel_path: s.workspaceRelPath,
            doc_path: s.docPath,
            content_hash: s.contentHash,
            realpath: s.realpath,
          })),
        },
      }
    } catch (err) {
      return {
        ok: false as const,
        error: { code: 'SCAN_FAILED', message: (err as Error).message },
      }
    }
  })

  // ── 外部 Agent 导入（Layer B 宿主编排）：import:detect/scan/run/status/cancel/rollback ──
  registerAgentImportSurfaces()

  guardedHandle('cli:getCoreCommandCatalog', async () => {
    const { CORE_COMMAND_CATALOG } = await import('./cli/core-command-catalog')
    return CORE_COMMAND_CATALOG
  })

  guardedHandle('capabilityDiscovery:getSummary', async (_event, spaceId: string) => {
    return dependencies.getCapabilityDiscoveryService().getSummary(spaceId)
  })

  guardedHandle('capabilityDiscovery:refreshExecution', async (_event, spaceId: string) => {
    return dependencies.getCapabilityDiscoveryService().refreshExecution(spaceId)
  })

  guardedOn('agent:log-action-result', (_event, payload: any) => {
    try {
      ipcLog.debug('action-result:', JSON.stringify(payload))
    } catch {
      ipcLog.debug('action-result:', payload)
    }
  })

  const SAFE_OPEN_PROPERTIES = new Set([
    'openFile', 'openDirectory', 'multiSelections',
    'showHiddenFiles', 'createDirectory', 'dontAddToRecent',
  ])

  function sanitizeDefaultPath(raw: unknown, defaultDirectory?: unknown): string | undefined {
    if (typeof raw !== 'string' || !raw) return undefined
    const homePath = app.getPath('home')
    const documentsPath = app.getPath('documents')
    const downloadsPath = app.getPath('downloads')
    const desktopPath = app.getPath('desktop')
    const allowedRoots = [homePath, documentsPath, downloadsPath, desktopPath]
    if (defaultDirectory === 'downloads') {
      return join(downloadsPath, basename(raw))
    }
    const resolved = resolve(raw)
    if (allowedRoots.some(root => resolved.startsWith(root))) return resolved
    return documentsPath
  }

  guardedHandle('dialog:showSave', async (_event, options: any) => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: sanitizeDefaultPath(options?.defaultPath, options?.defaultDirectory),
        filters: Array.isArray(options?.filters) ? options.filters : [],
      })
      return result.canceled ? undefined : result.filePath
    } catch (error) {
      mainLog.error('Failed to show save dialog:', error)
      throw error
    }
  })

  guardedHandle('dialog:showOpen', async (_event, options: any) => {
    try {
      const rawProps: string[] = Array.isArray(options?.properties) ? options.properties : ['openFile']
      const safeProps = rawProps.filter(p => SAFE_OPEN_PROPERTIES.has(p))
      if (safeProps.length === 0) safeProps.push('openFile')

      const result = await dialog.showOpenDialog({
        defaultPath: sanitizeDefaultPath(options?.defaultPath),
        filters: Array.isArray(options?.filters) ? options.filters : [],
        properties: safeProps as any,
      })
      return result.canceled ? undefined : result.filePaths
    } catch (error) {
      mainLog.error('Failed to show open dialog:', error)
      throw error
    }
  })

  guardedHandle('window:setAppearance', async (_, appearance: MainWindowAppearance) => {
    try {
      const snapshot = dependencies.applyAppearance(appearance)
      return { success: true, ...snapshot }
    } catch (error) {
      mainLog.error('Failed to set appearance:', error)
      return { success: false, error: String(error) }
    }
  })

  guardedHandle('window:getAppearance', async () => {
    try {
      const appearance = dependencies.getCurrentAppearance()
      const snapshot = readAppearanceThemeSnapshot(nativeTheme, appearance)
      return { success: true, ...snapshot }
    } catch (error) {
      mainLog.error('Failed to get appearance:', error)
      return { success: false, error: String(error) }
    }
  })

  // ── 自绘窗口控件（min/max/close）────────────────────────────────────
  // Windows/Linux 用 frameless 窗口 + renderer 自绘标题栏按钮（飞书风格），
  // 不再依赖原生 titleBarOverlay（原生覆盖层会浮在所有内容之上、悬浮右上角
  // 时遮挡 UI）。这几个 channel 按 event.sender 定位发起窗口，主窗 + 独立
  // 聊天窗复用同一套 handler。
  guardedOn('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  guardedOn('window:toggleMaximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  guardedOn('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  guardedHandle('window:isMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return okResponse(win ? win.isMaximized() : false)
  })

  guardedHandle('window:isFullScreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return okResponse(win ? win.isFullScreen() : false)
  })

  guardedHandle('im:openDetached', () => {
    dependencies.openIMWindow()
    return okResponse({ opened: true })
  })

  // 团队切换双向同步：任一窗口（主窗 / 私信窗）切换团队后，把目标 organizationId
  // 转发给其它窗口，使两个独立 renderer 进程的 selectedOrganization 保持一致。
  // 只转发给「非发送方」，避免回环；目标限定主窗与私信窗两个真实承载团队上下文的窗口。
  guardedOn('im:syncOrganization', (event, rawPayload: unknown) => {
    const payload = rawPayload as { organizationId?: unknown } | null
    if (!payload || typeof payload.organizationId !== 'string' || payload.organizationId.length === 0) {
      return
    }
    const targets = [getMainWindow(), getIMWindow()]
    for (const win of targets) {
      if (!win || win.isDestroyed()) continue
      if (win.webContents === event.sender) continue
      win.webContents.send('im:organizationSynced', { organizationId: payload.organizationId })
    }
  })

  registerOverlayIpc(() => getMainWindow())

  // W6 批次 1：space:setActive 迁到 PlatformSurface。
  // channel 名从 space:setActive 变为 space:set-active（D-5 命名规则要求连字符），
  // 但通过 surface IPC adapter 注册时 channel 名保持为 `space:set-active`。
  // 原 channel 名 `space:setActive` 由 registerSurfaceAsIpc 通过 surface 的 channel
  // 字段控制——但 D-5 格式只允许 [a-z][a-z0-9-]*，所以需要用 alias 保持旧 channel。
  const { spaceSetActive } = createSpaceSetActiveSurface({
    setCLISpaceContext: (spaceId, crawlspaceId, organizationId, resolvedRoot) => {
      setCLISpaceContext(spaceId, crawlspaceId, organizationId, resolvedRoot)
      //  / ：进入 Space 时预热 CLI listing / skills 物化等冷建依赖。
      requestSpacePrewarm(organizationId, spaceId)
    },
    resolveSpaceWorkspaceRoot,
    resolveSpacesRoot,
    ensureDir: (p: string) => fsSync.mkdirSync(p, { recursive: true }),
    logWarn: (msg: string, err: unknown) => mainLog.warn(msg, err),
  })
  registerSurfaceAsIpc(spaceSetActive)

  // PD-11（W6 M3）：删除原 desktop auth preset 推送 IPC handler —— CLI client
  // 不再压低 Space 的 yolo / preset，统一以 Agent.agent_config.security.allow_yolo_mode
  // 为权威（v3 PRD §5.1.1 字段改名）。`desktop:setDevicePermissions` 保留（与 yolo
  // 正交，规范 § 6.5 仍生效）。

  // TabDesktop Wave 2.1 · 规范 § 6.5：渲染侧在 selectedAgent 变化时把当前 Space
  // 的 `agent_config.device_permissions` 推到主进程。主进程缓存后由 /desktop/*
  // 路由在入口消费：`desktop_observe === 'block'` → 直接返回 POLICY_BLOCKED
  // 三段式文案（规范 § 6.5 第 2 条"桌面操控完全不可用"的命令行侧兑现，与
  // Python Prompt 侧跳过 SECTION_TABDESKTOP 一致）。
  //
  // 入参：{ perms: Record<string, 'allow'|'confirm'|'block'> | null }。非对象 /
  // 字段缺失一律视作"未推送"，路由层回退到现有策略评估（保守允许，避免冷启动
  // 打不开）。合法键见 packages/security-policy/src/types.ts DevicePermissionKey。
  guardedHandle(
    'desktop:setDevicePermissions',
    async (_event, params: { perms: Record<string, string> | null }) => {
      setCurrentSpaceDevicePermissions(params?.perms ?? null)
      return { success: true }
    },
  )

  // TabDesktop Wave 2 · 规范 § 6.3 D5：渲染侧设置面板查询当前桌面操控授权状态。
  // 返回 ~/.tabtin/desktop-approval.json 的基本元数据（授权时间、剩余 TTL），
  // 无授权时 granted=false。
  guardedHandle('desktop:getApprovalStatus', async () => {
    return DesktopUseGuard.getDesktopApprovalStatus()
  })

  // TabDesktop Wave 2 · 规范 § 6.3 D5：渲染侧设置面板撤销授权。
  // 等价于 POST /desktop/revoke-approval，但不经由 CLI Server（避免跨 socket）。
  guardedHandle('desktop:revokeApproval', async () => {
    try {
      DesktopUseGuard.revokeDesktopApproval()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── OS 系统权限管理（macOS TCC / Windows 应用权限）─────────────────────
  // 与上面的 desktop:* 是两层正交概念：
  //   - desktop:* 管业务层的 HITL 桌面操控授权（24h TTL）
  //   - osPermissions:* 管「操作系统给 TabTin 这个 App 的能力」（辅助功能 / 录屏 / 麦克风 …）
  // 渲染层 Settings「授权」面板消费 osPermissions:*；ApprovalManager 那条线不动。
  guardedHandle('osPermissions:list', async () => {
    try {
      return okResponse(await getOsPermissions().list())
    } catch (err) {
      return errResponse('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  })

  guardedHandle('osPermissions:check', async (_event, kind: PermissionKind) => {
    try {
      return okResponse(await getOsPermissions().check(kind))
    } catch (err) {
      return errResponse('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  })

  guardedHandle('osPermissions:request', async (_event, kind: PermissionKind) => {
    try {
      return okResponse(await getOsPermissions().request(kind))
    } catch (err) {
      return errResponse('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  })

  guardedHandle('osPermissions:openSettings', async (_event, kind: PermissionKind) => {
    try {
      return okResponse(await getOsPermissions().openSystemSettings(kind))
    } catch (err) {
      return errResponse('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  })

  guardedHandle('slideshow:enterFullscreen', async () => {
    try {
      const win = dependencies.getPrimaryWindow()
      if (win && !win.isDestroyed()) {
        win.setFullScreen(true)
      }
      return { success: true }
    } catch (error) {
      mainLog.error('Failed to enter slideshow fullscreen:', error)
      return { success: false, error: String(error) }
    }
  })

  guardedHandle('slideshow:exitFullscreen', async () => {
    try {
      const win = dependencies.getPrimaryWindow()
      if (win && !win.isDestroyed() && win.isFullScreen()) {
        win.setFullScreen(false)
      }
      return { success: true }
    } catch (error) {
      mainLog.error('Failed to exit slideshow fullscreen:', error)
      return { success: false, error: String(error) }
    }
  })

  guardedHandle('screenshot:readFileAsDataURL', async (_event, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path')
    }

    const resolved = resolve(filePath)
    const screenshotDir = resolve(getHomeTabtinPath('screenshots'))

    if (!resolved.startsWith(screenshotDir + sep) && resolved !== screenshotDir) {
      throw new Error('Access denied: only screenshot directory is allowed')
    }

    const ext = extname(resolved).toLowerCase()
    if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
      throw new Error('Access denied: only image files are allowed')
    }

    const { stat, readFile } = await import('node:fs/promises')

    const stats = await stat(resolved)
    if (stats.size > 20 * 1024 * 1024) {
      throw new Error('File too large: exceeds 20MB limit')
    }

    const buffer = await readFile(resolved)
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${buffer.toString('base64')}`
  })
}

export function unregisterMainProcessIPCHandlers(): void {
  const handleChannels = [
    'ping',
    ...OPENAI_CODEX_IPC_CHANNELS,
    'system:getHostname',
    'system:get-local-network-addresses',
    'device:getFingerprint',
    DEVICE_IDENTITY_IPC_CHANNEL,
    'get-system-ua',
    'get-app-version',
    'clipboard:writeImage',
    'get-update-state',
    'get-release-history',
    'check-for-updates',
    'download-update',
    'quit-and-install',
    'power:prevent-sleep',
    'power:allow-sleep',
    'cli:getCoreCommandCatalog',
    'capabilityDiscovery:getSummary',
    'capabilityDiscovery:refreshExecution',
    'dialog:showSave',
    'dialog:showOpen',
    'window:setAppearance',
    'window:getAppearance',
    'window:isMaximized',
    'window:isFullScreen',
    // chat:*Detached / skill:install / skill:uninstall
    // → W6 批次 2 迁到 PlatformSurface，注销由 surfaceChannels 管理
    'skill:workspace-scan',
    // PD-11（W6 M3）：原 desktop auth preset 推送 IPC handler 已删除。
    'desktop:setDevicePermissions',
    'desktop:getApprovalStatus',
    'desktop:revokeApproval',
    'osPermissions:list',
    'osPermissions:check',
    'osPermissions:request',
    'osPermissions:openSettings',
    'slideshow:enterFullscreen',
    'slideshow:exitFullscreen',
    'screenshot:readFileAsDataURL',
    'overlay:push',
    'overlay:focus',
  ]

  // W6 surface 注销（registerSurfaceAsIpc 内部也用 guardedHandle）
  const surfaceChannels = [
    'skill:install', 'skill:uninstall',
    // W6 批次 1
    'space:set-active', 'space:setActive',
    // 外部 Agent 导入（Layer B + 本机档案）
    ...IMPORT_SURFACE_CHANNELS,
    ...IMPORT_ARCHIVE_CHANNELS,
    ...OVERLAY_IPC_CHANNELS,
  ]
  for (const channel of surfaceChannels) {
    ipcMain.removeHandler(channel)
  }

  for (const channel of handleChannels) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.removeAllListeners('browser-prefs:search-engine-template')
  ipcMain.removeAllListeners('browser-prefs:access-policy')
  ipcMain.removeAllListeners('agent:log-action-result')
  ipcMain.removeAllListeners('overlay:ready')
  ipcMain.removeAllListeners('overlay:confirm-result')
  ipcMain.removeAllListeners('overlay:update-prompt-action')
  ipcMain.removeAllListeners('overlay:global-search-closed')
  ipcMain.removeAllListeners('overlay:navigate-search-result')
  ipcMain.removeAllListeners('overlay:notification-action')
  ipcMain.removeAllListeners('overlay:notification-closed')
  ipcMain.removeAllListeners('overlay:sync-theme')
  ipcMain.removeAllListeners('overlay:sync-locale')
  ipcMain.removeAllListeners('window:minimize')
  ipcMain.removeAllListeners('window:toggleMaximize')
  ipcMain.removeAllListeners('window:close')

  ipcLog.info('已移除所有 main-process IPC handlers')
}
