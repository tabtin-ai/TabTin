/**
 * TabSite IPC handlers — 暴露模板初始化能力给 Renderer 进程。
 *
 * 核心逻辑与 CLI route `/site/init-template/:id` 一致：
 *   1. 从 Django 获取站点信息
 *   2. 将模板复制到沙箱目录
 *   3. PATCH Django 写回 code_project_path
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from '@tabtin/terminal-core'
import { resolveWorkspaceSiteDir } from '@tabtin/agent-runtime'
import { getCLIOrganizationId } from '../cli/cli-context'
import { sanitizePathSegment } from '../utils/path-sanitize'
import {
  copyDirSafe,
  resolveTemplatePath,
  provisionTokenAndWriteEnv,
  hasValidTokenInEnvFile,
  fixWorkspaceDeps,
} from '../utils/tabsite-helpers'
import { djangoRequest } from '../cli/routes/shared/error-handler'
import { guardedHandle } from '../utils/guarded-handle'
import { startDevServer, stopDevServer, getDevServerStatus, stopAllDevServers } from './dev-server'
import { createLogger } from '../logger'
import { TokenManager } from '../auth'

const log = createLogger('TabSiteIPC')

/**
 * ：解析当前登录用户的 userId（新布局 sites 目录必填字段，
 * 字段兼容与 ElectronAgentHost.resolveSkillUserId 同源）。
 */
async function resolveCurrentUserId(): Promise<string | undefined> {
  const userInfo = (await TokenManager.getUserInfo()) as
    | { id?: unknown; user_id?: unknown; userId?: unknown }
    | null
  const raw = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
  if (raw === undefined || raw === null || raw === '') return undefined
  return String(raw)
}

type TabsiteIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

/**
 * Channel→handler 映射。新增/删除 channel 时必须同步更新 ipc-lazy.ts 的
 * TabsiteIPC channels 列表。
 */
export const tabsiteHandlers = {
  'tabsite:initTemplate': async (
    _event: IpcMainInvokeEvent,
    siteId: string,
    spaceId: string,
  ): Promise<{
    success: boolean
    code_project_path?: string
    already_exists?: boolean
    template?: string
    token_provisioned?: boolean
    token_warning?: string
    token_expires_soon?: boolean
    error?: string
  }> => {
      try {
        if (!siteId || !spaceId) {
          return { success: false, error: '缺少 siteId 或 spaceId' }
        }
        log.info(`initTemplate: siteId=${siteId}, spaceId=${spaceId}`)

        const siteResult = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`)
        if (siteResult.status !== 200 || !siteResult.data?.success) {
          return { success: false, error: siteResult.data?.error || '站点信息获取失败' }
        }
        const siteData = siteResult.data.data

        const userId = await resolveCurrentUserId()
        if (!userId) {
          return { success: false, error: '未登录，无法确定站点目录归属（缺少 userId）' }
        }

        const safeSpaceId = sanitizePathSegment(spaceId)
        const safeSlug = sanitizePathSegment(siteData.slug || siteId)
        const organizationIdForSite =
          getCLIOrganizationId() ||
          (typeof siteData.organization_id === 'string' ? siteData.organization_id : '') ||
          ''
        if (!organizationIdForSite) {
          return {
            success: false,
            error: '缺少 organization_id（ hard-cut — 禁止 _unscoped）',
          }
        }
        const projectPath = resolveWorkspaceSiteDir(
          resolveDataRoot(),
          userId,
          organizationIdForSite,
          safeSpaceId,
          safeSlug,
        )

        if (fs.existsSync(projectPath) && fs.readdirSync(projectPath).length > 0) {
          if (!siteData.code_project_path) {
            const patchRes = await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, {
              code_project_path: projectPath,
            })
            if (patchRes.status !== 200 || !patchRes.data?.success) {
              return { success: false, error: `目录已存在但更新站点信息失败: ${patchRes.data?.error || patchRes.status}`, code_project_path: projectPath }
            }
          }

          // TDI-002: already_exists 分支也需要确保 .env.local 中有 Token
          let tokenProvisioned = false
          let tokenWarning: string | undefined
          let tokenExpiresSoon: boolean | undefined
          const template = siteData.template || 'blank'
          if (template === 'dashboard') {
            const envPath = path.join(projectPath, '.env.local')
            let hasToken = false
            try {
              const content = await fsPromises.readFile(envPath, 'utf-8')
              hasToken = hasValidTokenInEnvFile(content)
            } catch { /* file doesn't exist */ }
            if (!hasToken) {
              const result = await provisionTokenAndWriteEnv(siteId, projectPath, { force: true })
              tokenProvisioned = result.tokenProvisioned
              tokenExpiresSoon = result.tokenExpiresSoon
              if (!tokenProvisioned) {
                tokenWarning = result.error || 'Token 恢复失败，站点数据功能可能不可用'
                log.warn(`Token recovery in already_exists branch failed (siteId=${siteId}):`, result.error)
              }
            } else {
              tokenProvisioned = true
            }
          }

          return {
            success: true,
            code_project_path: projectPath,
            already_exists: true,
            token_provisioned: tokenProvisioned,
            ...(tokenWarning && { token_warning: tokenWarning }),
            ...(tokenExpiresSoon && { token_expires_soon: true }),
          }
        }

        const template = siteData.template || 'blank'
        const templateDir = resolveTemplatePath(template)
        if (!templateDir) {
          return { success: false, error: `模板 "${template}" 未找到` }
        }

        await fsPromises.mkdir(projectPath, { recursive: true })
        try {
          await copyDirSafe(templateDir, projectPath)
        } catch (copyErr: any) {
          await fsPromises.rm(projectPath, { recursive: true, force: true }).catch(() => {})
          return { success: false, error: `模板复制失败: ${copyErr.message}` }
        }

        await fixWorkspaceDeps(projectPath)

        const patchResult = await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, {
          code_project_path: projectPath,
        })
        if (patchResult.status !== 200 || !patchResult.data?.success) {
          return {
            success: false,
            error: `模板已复制到 ${projectPath}，但更新站点信息失败: ${patchResult.data?.error || patchResult.status}`,
            code_project_path: projectPath,
          }
        }

        let tokenProvisioned = false
        let tokenWarning: string | undefined
        let tokenExpiresSoon: boolean | undefined
        if (template === 'dashboard') {
          const result = await provisionTokenAndWriteEnv(siteId, projectPath)
          tokenProvisioned = result.tokenProvisioned
          tokenExpiresSoon = result.tokenExpiresSoon
          if (!tokenProvisioned) {
            tokenWarning = result.error || 'Token 配置失败，站点数据功能可能不可用'
            log.warn(`Token auto-provision failed (siteId=${siteId}):`, result.error)
          }
        }

        return {
          success: true,
          code_project_path: projectPath,
          template,
          token_provisioned: tokenProvisioned,
          ...(tokenWarning && { token_warning: tokenWarning }),
          ...(tokenExpiresSoon && { token_expires_soon: true }),
        }
      } catch (err: any) {
        log.error(`initTemplate error (siteId=${siteId}):`, err)
        return { success: false, error: err?.message || 'initTemplate failed' }
      }
  },

  'tabsite:startDevServer': async (
    _event: IpcMainInvokeEvent,
    siteId: string,
    projectPath: string,
  ) => {
    try {
      log.info(`startDevServer: siteId=${siteId}`)
      return await startDevServer(siteId, projectPath)
    } catch (err: any) {
      log.error(`startDevServer error (siteId=${siteId}):`, err)
      return { success: false, error: err?.message || 'startDevServer failed' }
    }
  },

  'tabsite:stopDevServer': async (_event: IpcMainInvokeEvent, siteId: string) => {
    log.info(`stopDevServer: siteId=${siteId}`)
    return { stopped: stopDevServer(siteId) }
  },

  'tabsite:getDevServerStatus': async (_event: IpcMainInvokeEvent, siteId: string) => {
    return getDevServerStatus(siteId)
  },
} satisfies Record<string, TabsiteIpcHandler>

export function registerTabsiteIpcHandlers(): void {
  for (const channel of Object.keys(tabsiteHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  for (const [channel, handler] of Object.entries(tabsiteHandlers)) {
    guardedHandle(channel, handler as TabsiteIpcHandler)
  }
}

/**
 * 注销 channel 并停止所有 dev server。生产路径 onBeforeQuit 走这里清理子进程，
 * stub 模式下 channel 由 ipc-lazy 持有，但 stopAllDevServers 必须仍然被调用。
 */
export function unregisterTabsiteIpcHandlers(): void {
  for (const channel of Object.keys(tabsiteHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  stopAllDevServers()
}
