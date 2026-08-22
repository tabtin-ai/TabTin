/**
 * SiteAccessMemory 持久化服务
 *
 * 职责：
 * - Electron 启动时从 userData/anti-detect/site-access-memory.json 加载
 * - 变更时异步 debounced 写入
 * - 退出前 flush 保存
 */

import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import {
  SiteAccessMemory,
  AccessStrategyService,
  setSharedAccessStrategyService,
  getSharedAccessStrategyService,
} from '@tabtin/browser-core'
import { createLogger } from '../logger'

const log = createLogger('SiteAccessMemory')

const PERSISTENCE_DIR = 'anti-detect'
const PERSISTENCE_FILE = 'site-access-memory.json'
const DEBOUNCE_MS = 5_000

function getFilePath(): string {
  return join(app.getPath('userData'), PERSISTENCE_DIR, PERSISTENCE_FILE)
}

/**
 * 启动时加载持久化的 SiteAccessMemory，恢复域名访问策略记忆。
 * 加载失败时静默降级为空实例。
 */
export async function loadSiteAccessMemory(): Promise<void> {
  const filePath = getFilePath()
  try {
    const json = await readFile(filePath, 'utf-8')
    const memory = SiteAccessMemory.deserialize(json)
    setSharedAccessStrategyService(new AccessStrategyService(memory))
    log.info(`加载成功: ${memory.size} 条记录`)
  } catch (err) {
    // 首启无文件属正常；反序列化失败也落这里，附带原因以便区分而非静默降级
    log.info('无历史记录或加载失败，使用空实例', err instanceof Error ? err.message : err)
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: Promise<void> | null = null

async function doSave(): Promise<void> {
  try {
    const service = getSharedAccessStrategyService()
    const memory = service.getSiteMemory()
    const dir = join(app.getPath('userData'), PERSISTENCE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, PERSISTENCE_FILE), memory.serialize(), 'utf-8')
    log.debug(`已保存: ${memory.size} 条记录`)
  } catch (err) {
    log.warn('保存失败:', err)
  }
}

/**
 * 调度一次 debounced 保存。多次调用在 5 秒内只会执行最后一次。
 */
export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    pendingSave = doSave().finally(() => { pendingSave = null })
  }, DEBOUNCE_MS)
}

/**
 * 立即写入（退出前调用）。
 * 如果有 pending 的 debounce timer，取消它并立即执行写入。
 */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (pendingSave) {
    await pendingSave
  }
  await doSave()
}
