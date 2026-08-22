/**
 * 组织 IPC 处理器
 *
 * 负责组织本地配置的持久化（userData/organization-configs/{organizationId}.json）。
 * 注意：组织数据存储在后端，主进程只负责本地偏好（主题、最近访问时间等）。
 */

import { app } from 'electron'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from './logger'
import { guardedHandle } from './utils/guarded-handle'
import { isOpenAICodexModel } from '../shared/openai-codex-models'

const log = createLogger('OrganizationIPC')

const CONFIG_DIR = path.join(app.getPath('userData'), 'organization-configs')

export interface OrganizationDeviceModelPreferences {
  /** 当前设备上新任务优先使用的本地模型；仅允许本机 Codex model id。 */
  mainModelId?: string
  /** 当前设备覆盖组织子 Agent 策略的本地模型；缺省时使用服务端策略。 */
  subagentModelId?: string
}

interface OrganizationLocalConfig {
  theme?: 'auto' | 'light' | 'dark'
  lastAccessed?: string
  modelPreferences?: OrganizationDeviceModelPreferences
  /** 当前设备上的用户级模型偏好；BYOK/ChatGPT 额度不能跨 TabTin 账号共享。 */
  modelPreferencesByUser?: Record<string, OrganizationDeviceModelPreferences>
  [key: string]: unknown
}

async function ensureConfigDir(): Promise<void> {
  await fsPromises.mkdir(CONFIG_DIR, { recursive: true })
}

function configPath(organizationId: string): string {
  // Sanitize id: only allow alphanumeric, hyphen, underscore
  const safeId = organizationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
  if (!safeId) throw new Error('Invalid organizationId')
  return path.join(CONFIG_DIR, `${safeId}.json`)
}

function userPreferenceKey(userId: string): string {
  const normalized = userId.trim()
  if (!normalized) throw new Error('userId is required')
  return normalized
}

async function readConfig(organizationId: string): Promise<OrganizationLocalConfig> {
  try {
    const raw = await fsPromises.readFile(configPath(organizationId), 'utf-8')
    return JSON.parse(raw) as OrganizationLocalConfig
  } catch {
    return { theme: 'auto', lastAccessed: new Date().toISOString() }
  }
}

export function normalizeOrganizationDeviceModelPreferences(
  value: unknown,
): OrganizationDeviceModelPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const mainModelId = typeof raw.mainModelId === 'string' && isOpenAICodexModel(raw.mainModelId.trim())
    ? raw.mainModelId.trim()
    : undefined
  const subagentModelId = typeof raw.subagentModelId === 'string'
    && isOpenAICodexModel(raw.subagentModelId.trim())
    ? raw.subagentModelId.trim()
    : undefined
  return {
    ...(mainModelId ? { mainModelId } : {}),
    ...(subagentModelId ? { subagentModelId } : {}),
  }
}

export async function readOrganizationDeviceModelPreferences(
  userId: string,
  organizationId: string,
): Promise<OrganizationDeviceModelPreferences> {
  const config = await readConfig(organizationId)
  const key = userPreferenceKey(userId)
  const scoped = normalizeOrganizationDeviceModelPreferences(config.modelPreferencesByUser?.[key])
  if (Object.keys(scoped).length > 0 || !config.modelPreferences) return scoped

  // 首次升级时把旧版 Organization 级偏好一次性认领给当前登录用户，随后删除
  // unscoped 字段，避免同机下一位用户继承。
  const legacy = normalizeOrganizationDeviceModelPreferences(config.modelPreferences)
  const nextByUser = { ...(config.modelPreferencesByUser ?? {}), [key]: legacy }
  const { modelPreferences: _legacy, ...rest } = config
  await writeConfig(organizationId, { ...rest, modelPreferencesByUser: nextByUser })
  return legacy
}

async function writeConfig(organizationId: string, config: OrganizationLocalConfig): Promise<void> {
  await ensureConfigDir()
  await fsPromises.writeFile(configPath(organizationId), JSON.stringify(config, null, 2), 'utf-8')
}

export async function writeOrganizationDeviceModelPreferences(
  userId: string,
  organizationId: string,
  preferences: OrganizationDeviceModelPreferences,
): Promise<OrganizationDeviceModelPreferences> {
  const normalized = normalizeOrganizationDeviceModelPreferences(preferences)
  const existing = await readConfig(organizationId)
  const key = userPreferenceKey(userId)
  const nextByUser = { ...(existing.modelPreferencesByUser ?? {}) }
  if (Object.keys(normalized).length > 0) {
    nextByUser[key] = normalized
  } else {
    delete nextByUser[key]
  }
  const { modelPreferences: _legacy, ...rest } = existing
  await writeConfig(organizationId, {
    ...rest,
    modelPreferencesByUser: nextByUser,
    lastAccessed: new Date().toISOString(),
  })
  return normalized
}

/** ChatGPT 断开后清理当前用户在所有 Organization 的本机模型默认。 */
export async function clearUserDeviceModelPreferences(userId: string): Promise<void> {
  const key = userPreferenceKey(userId)
  let names: string[]
  try {
    names = await fsPromises.readdir(CONFIG_DIR)
  } catch {
    return
  }
  await Promise.all(names.filter(name => name.endsWith('.json')).map(async (name) => {
    const filePath = path.join(CONFIG_DIR, name)
    try {
      const config = JSON.parse(await fsPromises.readFile(filePath, 'utf-8')) as OrganizationLocalConfig
      if (!config.modelPreferencesByUser?.[key]) return
      const nextByUser = { ...config.modelPreferencesByUser }
      delete nextByUser[key]
      await fsPromises.writeFile(filePath, JSON.stringify({
        ...config,
        modelPreferencesByUser: nextByUser,
        lastAccessed: new Date().toISOString(),
      }, null, 2), 'utf-8')
    } catch (error) {
      log.warn(`Failed to clear device model preferences from ${name}:`, error)
    }
  }))
}

export function registerOrganizationHandlers(): void {
  guardedHandle('organization:getLocalConfig', async (_event, organizationId: string) => {
    try {
      if (!organizationId || typeof organizationId !== 'string') {
        return { success: false, error: 'organizationId is required' }
      }
      const config = await readConfig(organizationId)
      config.lastAccessed = new Date().toISOString()
      await writeConfig(organizationId, config).catch(() => {/* non-critical */})
      return { success: true, config }
    } catch (error) {
      log.error('getLocalConfig failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'read error' }
    }
  })

  guardedHandle('organization:saveLocalConfig', async (_event, organizationId: string, config: unknown) => {
    try {
      if (!organizationId || typeof organizationId !== 'string') {
        return { success: false, error: 'organizationId is required' }
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { success: false, error: 'config must be a plain object' }
      }
      const existing = await readConfig(organizationId)
      const merged: OrganizationLocalConfig = {
        ...existing,
        ...(config as OrganizationLocalConfig),
        lastAccessed: new Date().toISOString(),
      }
      await writeConfig(organizationId, merged)
      return { success: true }
    } catch (error) {
      log.error('saveLocalConfig failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'write error' }
    }
  })

  guardedHandle('organization:clearLocalCache', async (_event, organizationId?: string) => {
    try {
      if (organizationId) {
        await fsPromises.rm(configPath(organizationId), { force: true })
        log.info(`Cleared local config for organization: ${organizationId}`)
      } else {
        await fsPromises.rm(CONFIG_DIR, { recursive: true, force: true })
        log.info('Cleared all organization local configs')
      }
      return { success: true }
    } catch (error) {
      log.error('clearLocalCache failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'clear error' }
    }
  })

  log.info('IPC handlers registered')
}
