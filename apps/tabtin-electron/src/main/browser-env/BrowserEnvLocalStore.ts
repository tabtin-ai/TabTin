/**
 * BrowserEnvLocalStore —— 本地化退役 Wave 1 新建。
 *
 * 职责：把 BrowserEnvironment 的"环境列表 + Space 绑定"整体快照按 userId
 * 隔离地落到本地 `app-config.json`(`AppConfigService`)。Service 层只通过
 * 本接口读写,不直连文件系统——这样未来要换成"先读云、写云"包装(C 路径),
 * 替换实现即可,Service 完全无感。
 *
 *
 * - **ADR-1**：复用 AppConfigService。env 名字 + 绑定无敏感性,无需加密。
 *   单文件 JSON 体积极小(<10KB),原子写已被 ConfigService 保证。
 * - **ADR-2**：无快照时同步创建一个默认 env(`tabtin:env:default`)——不再
 *   等后端 ensure_default,启动期立即可用。
 * - **ADR-3**：partition_key 命名沿用云端时代规则 —— 默认是
 *   `tabtin:env:default`,新建是 `tabtin:env:{uuid hex}`。这样 Chromium
 *   `userData/Partitions/` 目录与历史兼容。
 * - **ADR-4**：按 userId 嵌套是必须的(多账号天然隔离)。未登录态用
 *   '__guest__' 作为 fallback。
 * - **ADR-10**：本接口纯同步、无副作用扩展点(`readSync` / `writeSync`),
 *   未来要回到云端时,可包装成 `RemoteAwareStore`(优先读云、写双写)。
 */

import { randomUUID } from 'crypto'

import { configService } from '../services/ConfigService'
import type { BrowserEnvSnapshot } from '../services/ConfigService'
import type { BrowserEnvironment } from '../../shared/types/browser-env'

export const GUEST_USER_ID = '__guest__'

/**
 * 默认 env 的 id / partition_key —— ADR-2/3 产品保证。
 * 暴露 export 让 Service 单点引用,避免在多文件镜像同一字面量。
 */
export const DEFAULT_ENV_ID = 'default'
export const DEFAULT_ENV_PARTITION_KEY = 'tabtin:env:default'
export const DEFAULT_ENV_NAME = '默认环境'

const CONFIG_KEY = 'browser_env'

/**
 * 抽象的存储后端 —— 默认走 AppConfigService。测试可注入内存实现。
 */
export interface BrowserEnvStorageBackend {
  get(): Record<string, BrowserEnvSnapshot> | undefined
  set(value: Record<string, BrowserEnvSnapshot>): void
}

// 走 setOrThrow 而不是 set —— BrowserEnvironment 是用户主动操作的数据,
// UI 期待"成功 / 失败"明确反馈;静默吞写盘失败会让"重启后数据丢失"难以
// 复现。`ConfigPersistError` 由 Service 层接住,转成 IPC `success:false`。
const defaultBackend: BrowserEnvStorageBackend = {
  get: () => configService.get(CONFIG_KEY),
  set: (value) => configService.setOrThrow(CONFIG_KEY, value),
}

export class BrowserEnvLocalStore {
  constructor(private readonly backend: BrowserEnvStorageBackend = defaultBackend) {}

  /**
   * 同步读某 userId 的 snapshot。无快照返回 null —— 调用方应再调 `ensureDefault`。
   *
   * 这里不在 read 时偷偷创建默认 env：保留 null 让 Service 显式 emit "刚刚
   * 初始化了一份新数据" 的语义日志,便于排查"为什么用户重启后多出一个 env"
   * 类问题。
   */
  readSync(userId: string): BrowserEnvSnapshot | null {
    const all = this.safeGetAll()
    const snapshot = all[normalizeUserId(userId)]
    if (!snapshot) return null
    // 防御性 clone —— 调用方修改返回数组不污染 backend 缓存
    return cloneSnapshot(snapshot)
  }

  /**
   * 写入 snapshot。整体覆盖该 userId 的 entry —— 调用方需要先用 readSync
   * 拿到当前快照、改完再写回。
   *
   * **失败语义(默认 backend)**:走 `configService.setOrThrow` —— 落盘失败
   * 时**会抛 `ConfigPersistError`**,内存被回滚到上一次成功状态。
   * `BrowserEnvironmentService.persist` 接住后转 `BrowserEnvValidationError`
   * (`code='PERSIST_FAILED'`),IPC 层返回 `success:false` 让 renderer toast。
   *
   * 注入测试 backend 时可以选择"抛"或"noop 不抛",contract 由 backend 决定;
   * 调用方不应假设 writeSync 永远不抛。
   */
  writeSync(userId: string, snapshot: BrowserEnvSnapshot): void {
    const all = this.safeGetAll()
    all[normalizeUserId(userId)] = cloneSnapshot(snapshot)
    this.backend.set(all)
  }

  /**
   * 确保某 userId 至少有一份 snapshot:
   *   - 已有快照(且包含至少一个 env)→ 校验默认 env 不变质
   *   - 无快照或 environments 为空 → 同步创建只含默认 env 的初始快照
   *
   * "environments 为空"也兜底是为了防御未来某次错误的 writeSync 把环境列表
   * 清空 —— 默认 env 是产品保证,任何时刻都不能丢。
   *
   * **腐坏数据修复**:磁盘上可能存在 `id === DEFAULT_ENV_ID` 但 `is_default = false`
   * 的脏 entry(老 bug / 用户手贱 PATCH 出来),repair 时不能盲目 prepend 一条
   * 新默认 env —— 否则会得到两条 id='default' 的 entry,后续 `applySnapshot` 里
   * `envById.set` 后写覆盖前写 → 列表显示两条但 Map 里只有一条,绑定可能挂错。
   * 正确做法:发现已存在 id='default' 的 entry 就**就地修正**为默认 env 的标准
   * 字段,不再 append。
   */
  ensureDefault(userId: string): BrowserEnvSnapshot {
    const existing = this.readSync(userId)
    if (existing && existing.environments.length > 0) {
      const hasDefaultFlag = existing.environments.some((e) => e.is_default)
      if (hasDefaultFlag) return existing
      const indexOfDefaultId = existing.environments.findIndex(
        (e) => e.id === DEFAULT_ENV_ID,
      )
      let repairedEnvs: BrowserEnvironment[]
      if (indexOfDefaultId >= 0) {
        // 已有 id='default' entry 但 flag 错了 —— 就地修正,避免 id 重复。
        // 同时同步 partition_key / name(防御历史腐坏)和 updated_at。
        const stale = existing.environments[indexOfDefaultId]
        const fixed: BrowserEnvironment = {
          ...stale,
          name: DEFAULT_ENV_NAME,
          partition_key: DEFAULT_ENV_PARTITION_KEY,
          is_default: true,
          updated_at: new Date().toISOString(),
        }
        repairedEnvs = existing.environments.map((e, i) =>
          i === indexOfDefaultId ? fixed : e,
        )
      } else {
        repairedEnvs = [createDefaultEnvironment(), ...existing.environments]
      }
      const repaired: BrowserEnvSnapshot = {
        environments: repairedEnvs,
        bindings: existing.bindings,
      }
      this.writeSync(userId, repaired)
      return repaired
    }
    const fresh: BrowserEnvSnapshot = {
      environments: [createDefaultEnvironment()],
      bindings: [],
    }
    this.writeSync(userId, fresh)
    return fresh
  }

  private safeGetAll(): Record<string, BrowserEnvSnapshot> {
    const raw = this.backend.get()
    if (!raw || typeof raw !== 'object') return {}
    return { ...raw }
  }
}

/**
 * 默认 env 的工厂 —— 字段语义见 BrowserEnvironment 接口。
 *
 * - id 用固定字符串 `'default'`,非 UUID:这是"产品保证存在"的 env,任何
 *   user 的快照都用同一个 id,绑定 / 删除等业务校验依赖此 id 区分"系统
 *   默认环境"vs"用户自建环境"。
 * - using_space_count 初始为 0:本地化后该字段含义 = explicit_binding_count
 *   (不再像云端那样"总 Space 数 - 显式绑到其他 env 的"——本地无后端无法
 *   知道"总 Space 数")。Service 在 emit 时按 explicit binding 计算填充。
 */
function createDefaultEnvironment(): BrowserEnvironment {
  const now = new Date().toISOString()
  return {
    id: DEFAULT_ENV_ID,
    name: DEFAULT_ENV_NAME,
    partition_key: DEFAULT_ENV_PARTITION_KEY,
    is_default: true,
    binding_count: 0,
    explicit_binding_count: 0,
    using_space_count: 0,
    created_at: now,
    updated_at: now,
  }
}

/**
 * 用户新建 env 的 partition_key —— ADR-3 规则:`tabtin:env:{uuid hex}`。
 *
 * 不带连字符的 hex 是为了让 Chromium `userData/Partitions/` 目录名简短;
 * 历史云端实现也是这个格式,本地化后保持一致才能让"曾经存在的 partition
 * 目录"在用户重新创建 env 时复用(虽然现在没有用户,但留好这个口子)。
 */
export function generateEnvironmentPartitionKey(): string {
  return `tabtin:env:${randomUUID().replace(/-/g, '')}`
}

export function generateEnvironmentId(): string {
  return randomUUID()
}

function cloneSnapshot(snapshot: BrowserEnvSnapshot): BrowserEnvSnapshot {
  return {
    environments: snapshot.environments.map((e) => ({ ...e })),
    bindings: snapshot.bindings.map((b) => ({ ...b })),
  }
}

/**
 * 把任意 userId 入参归一到一个安全的桶 key。
 *
 * 防御脏值:
 *   - null / undefined / 非 string → guest
 *   - 空字符串 / 全空白 → guest
 *   - 字面量 'undefined' / 'null'(stringify 一个 undefined/null 会拿到这个,
 *     有些上游粗心会传进来)→ guest
 *   - 其他值 → trim 后返回(保留大小写,因为 userId 是后端 PK 严格匹配)
 *
 * 不归一会让脏值变成独立的 config 桶,与 guest 隔离失效,也极难诊断。
 */
function normalizeUserId(userId: string | null | undefined): string {
  if (typeof userId !== 'string') return GUEST_USER_ID
  const trimmed = userId.trim()
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return GUEST_USER_ID
  return trimmed
}
