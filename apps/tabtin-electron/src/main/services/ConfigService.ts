import { app } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { atomicWriteFileSync } from '@tabtin/terminal-core'

import type { BrowserEnvironment, BrowserEnvBinding } from '../../shared/types/browser-env'
import { createLogger } from '../logger'

const log = createLogger('ConfigService')

/**
 * 单个 user 的 BrowserEnvironment 本地快照（环境列表 + Space 绑定）。
 * BrowserEnvLocalStore 按 userId 嵌套到 'browser_env' 这一 key 下。
 */
export interface BrowserEnvSnapshot {
  environments: BrowserEnvironment[]
  bindings: BrowserEnvBinding[]
}

/**
 * 全局配置结构定义
 *
 * 在这里添加新的配置模块，以保持类型安全
 */
export interface AppConfig {
  /** 窗口状态（主窗口） */
  'window.main'?: {
    width: number
    height: number
    x?: number
    y?: number
    isMaximized?: boolean
  }
  /** 通知偏好 — 账号级，对当前用户所有 organization 一致生效 */
  'notification.userPrefs'?: {
    enabled: boolean
    desktopEnabled: boolean
    dockBadgeEnabled: boolean
    soundEnabled: boolean
    dndEnabled: boolean
    dndSchedule?: { start: string; end: string; days: number[] }
    categoryOverrides: Record<string, { desktopEnabled?: boolean; soundEnabled?: boolean; dockBadgeEnabled?: boolean }>
  }
  /**
   * 通知偏好的同步元信息（IA Phase 2）：
   * - `updatedAt`：本地最后改动的毫秒时间戳，用于与服务器 `ui_settings.notificationPrefs`
   *   做 per-namespace last-write-wins 合并。
   * - `owner`：最后一次同步对应的 userId，用于换人登录时识别"非同一账号"并先重置
   *   本地偏好再合并，避免共享设备串账号（渲染层 5 类靠登出清 localStorage，主进程
   *   这份偏好不经登出清理，故用 owner guard 兜底）。
   */
  'notification.userPrefsMeta'?: {
    updatedAt: number
    owner?: string
  }
  /** 下载历史 (id -> item) */
  'download.history'?: Record<string, any>
  /** WS Gateway ID */
  'ws.gatewayId'?: string
  /** MCP 连接 */
  'mcp.connections'?: any[]
  /** 其他通用偏好设置 */
  'settings'?: {
    theme?: 'light' | 'dark' | 'system'
    language?: string
    autoStart?: boolean
    /** Windows/macOS 点 X 后继续后台运行（默认 true，见 tray-policy.ts） */
    minimizeToTray?: boolean
    /** 「已收进托盘」系统通知只提示一次的标记 */
    trayHideHintShown?: boolean
  }
  /**
   * BrowserEnvironment 本地快照（按 userId 嵌套）。
   *
   * 未登录态使用 '__guest__' 作为 fallback userId。
   */
  'browser_env'?: Record<string, BrowserEnvSnapshot>
  // 'approval.scopeCache' 字段由 ApprovalScopeCache.ts 通过 module augmentation
  // 注入精确类型 (`Record<string, ScopeEntry>`)。此处不重复声明，避免与
  // augmentation 的具体类型冲突 (TS 要求合并的两次声明类型完全一致)。
  // KEY_CATEGORIES 仍需登记该 key 的分类——编译期 guard 会校验所有 AppConfig
  // 字段（含 augmentation 后的）都已分类。
}

/**
 * 写盘失败专用错误 —— 让调用方能通过 instanceof 判定"是磁盘问题"而
 * 不是其它逻辑异常,从而决定是否给用户友好提示。
 */
export class ConfigPersistError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigPersistError'
  }
}

export type BucketCategory = 'cache' | 'semi-cache' | 'data'

/**
 * 每个 AppConfig key 的语义分类。
 *
 * - cache：纯缓存，清掉无副作用（window 状态、WS sticky ID）
 * - semi-cache：云端有副本或可重建，清掉体验降级但不丢数据
 * - data：本地唯一，清了真没了
 *
 * **类型设计**：
 *   内部 `_CATEGORY_REGISTRY` 用 `as const satisfies` 保留字面量 key 集合，
 *   供下方 `_appConfigKeyCoverageGuard` 编译期校验「AppConfig 每个字段都已分类」。
 *   导出的 `KEY_CATEGORIES` 用宽类型 `Record<string, BucketCategory>`，让外部
 *   模块（如 ApprovalScopeCache）通过 module augmentation 加 AppConfig 字段时，
 *   也能在此 registry 索引到对应分类，不被字面量 key 集合卡住。
 */
const _CATEGORY_REGISTRY = {
  'window.main': 'cache',
  'ws.gatewayId': 'cache',
  'notification.userPrefs': 'semi-cache',
  'notification.userPrefsMeta': 'semi-cache',
  'download.history': 'semi-cache',
  'approval.scopeCache': 'semi-cache',
  'mcp.connections': 'data',
  'settings': 'data',
  'browser_env': 'data',
} as const satisfies Record<string, BucketCategory>

export const KEY_CATEGORIES: Record<string, BucketCategory> = _CATEGORY_REGISTRY

// 编译期守卫：AppConfig 每个字段（含 module augmentation 后的）都必须在
// _CATEGORY_REGISTRY 中有分类。新增 AppConfig 字段而忘加分类时，此处会
// 编译失败，错误消息含具体漏掉的 key 名。
type _MissingCategoryKey = Exclude<keyof Required<AppConfig>, keyof typeof _CATEGORY_REGISTRY>
const _appConfigKeyCoverageGuard: [_MissingCategoryKey] extends [never]
  ? true
  : `MISSING_CATEGORY_FOR: ${_MissingCategoryKey & string}` = true
void _appConfigKeyCoverageGuard

/**
 * AppConfigService - 统一的 Electron 主进程配置管理服务
 */
export class AppConfigService {
  private static instance: AppConfigService
  private config: AppConfig = {}
  private readonly configPath: string

  private constructor() {
    this.configPath = join(this.resolveUserDataPath(), 'app-config.json')
    this.load()
  }

  private resolveUserDataPath(): string {
    try {
      const userDataPath = app?.getPath?.('userData')
      return typeof userDataPath === 'string' && userDataPath ? userDataPath : '/tmp'
    } catch {
      return '/tmp'
    }
  }

  public static getInstance(): AppConfigService {
    if (!AppConfigService.instance) {
      AppConfigService.instance = new AppConfigService()
    }
    return AppConfigService.instance
  }

  /**
   * 加载配置（通常只在初始化时调用）
   */
  private load(): void {
    try {
      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf-8')
        this.config = JSON.parse(data)
        log.info('配置已加载:', this.configPath)
      } else {
        this.config = {}
      }
    } catch (err) {
      log.error('无法加载配置:', this.configPath, err)
      this.config = {}
    }
  }

  /**
   * 保存配置（同步原子写入以确保安全）。
   *
   * 返回是否落盘成功 —— 调用方可据此决定是否回滚内存或上抛错误。
   * 历史实现只 `console.error` 静默吞掉,导致写依赖该函数的模块(如
   * `BrowserEnvLocalStore`)无法感知失败、上层 IPC 仍返回 `success`,
   * 用户重启后数据消失却没有任何提示——本地化退役 Wave 1 后这成为
   * 单点信任风险,故改为返回 boolean。
   */
  private save(): boolean {
    try {
      atomicWriteFileSync(this.configPath, JSON.stringify(this.config, null, 2), { mkdirSync: true })
      return true
    } catch (err) {
      log.error('无法保存配置:', this.configPath, err)
      return false
    }
  }

  /**
   * 获取指定 key 的配置
   */
  public get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key]
  }

  /**
   * 设置指定 key 的配置并保存。
   *
   * **软失败**模式:落盘失败仅 `console.error`,不抛 —— 向后兼容
   * 历史调用方(window 状态、download 历史等场景下静默继续是可接受的)。
   * **需要"写入失败感知"的调用方**请使用 `setOrThrow`。
   */
  public set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.config[key] = value
    this.save()
  }

  /**
   * 设置指定 key 的配置并保存,落盘失败时**回滚内存 + 抛 `ConfigPersistError`**。
   *
   * 用于"用户主动操作 + UI 期待反馈"的场景(如 BrowserEnvLocalStore):
   * 静默吞掉会让"UI 显示成功 / 重启数据回滚"的 bug 难以复现。
   */
  public setOrThrow<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    const previous = this.config[key]
    this.config[key] = value
    if (!this.save()) {
      if (previous === undefined) {
        delete this.config[key]
      } else {
        this.config[key] = previous
      }
      throw new ConfigPersistError(
        `failed to persist config key=${String(key)} (磁盘满 / 权限问题?)`,
      )
    }
  }

  /**
   * 局部更新指定 key 的配置（如果 key 指向对象）。软失败模式同 `set`。
   */
  public update<K extends keyof AppConfig>(key: K, partial: Partial<AppConfig[K]>): void {
    const current = this.config[key] || {}
    if (typeof current === 'object' && typeof partial === 'object') {
      this.config[key] = {
        ...(current as Record<string, unknown>),
        ...(partial as Record<string, unknown>),
      } as AppConfig[K]
      this.save()
    } else {
      this.set(key, partial as AppConfig[K])
    }
  }

  /**
   * 清除单个 key，重置为默认值（undefined）。
   *
   * 写盘失败时回滚内存 + 抛 ConfigPersistError——调用方（UI 层）
   * 不应在写盘失败时给用户"清理成功"的假象。
   */
  public clearByKey<K extends keyof AppConfig>(key: K): void {
    const previous = this.config[key]
    delete this.config[key]
    if (!this.save()) {
      if (previous !== undefined) {
        this.config[key] = previous
      }
      throw new ConfigPersistError(
        `failed to clear config key=${String(key)} (磁盘满 / 权限问题?)`,
      )
    }
  }

  /**
   * 按语义分类批量清除。返回本次实际清除的 key 列表。
   *
   * 写盘失败时回滚全部内存变更 + 抛 ConfigPersistError。
   */
  public clearByCategory(category: BucketCategory): { clearedKeys: string[] } {
    const targetKeys = (Object.keys(KEY_CATEGORIES) as Array<keyof AppConfig>)
      .filter(k => KEY_CATEGORIES[k] === category)

    const snapshot = new Map<keyof AppConfig, AppConfig[keyof AppConfig]>()
    const clearedKeys: string[] = []

    for (const key of targetKeys) {
      if (this.config[key] !== undefined) {
        snapshot.set(key, this.config[key])
        clearedKeys.push(key)
      }
      delete this.config[key]
    }

    if (!this.save()) {
      for (const [key, value] of snapshot) {
        (this.config as Record<string, unknown>)[key] = value
      }
      throw new ConfigPersistError(
        `failed to clear category=${category} (磁盘满 / 权限问题?)`,
      )
    }

    return { clearedKeys }
  }

  /**
   * 获取所有配置（谨慎使用）
   */
  public getAll(): AppConfig {
    return { ...this.config }
  }
}

export const configService = AppConfigService.getInstance()
