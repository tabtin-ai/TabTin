/**
 * BrowserEnvironment 主进程服务 —— 本地化退役 Wave 1 重写。
 *
 * ## 它做什么
 *
 * 把"Space → BrowserEnvironment 映射"维护在主进程内存里,所有读 / 写都
 * 同步走本地 JSON(`BrowserEnvLocalStore` → `AppConfigService`)。**没有
 * HTTP、没有 pending 状态、没有 bootstrap 概念**。
 *
 * 同步 getter(`getPartitionForSpace` / `getEnvironmentBySpace`)永远返回
 * 真实 partition —— Wave 2/3 的所有"pending guard"在 Wave 1 范围内已是
 * 死代码。
 *
 * ## 启动流程(总控 §4.1 流程图对应)
 *
 * 1. **构造函数**：同步用 '__guest__' fallback 初始化一份内存快照。这样
 *    `getPartitionForSpace` 在 `start()` 完成前被 IPC 调用也能立即返回真
 *    实 partition(默认 env),避免冷启动期空窗。
 * 2. **`start()`**:异步等 `TokenManager.preloadAuthData` 完成,拿到真实
 *    userId 后切换到该 user 的 snapshot;若不同于构造时的 guest 数据则
 *    emit `change(reason='manual-refresh')` 让 IPC / CookieSync 重建监听。
 * 3. **`onAuthChanged`**:监听登录 / 刷新 / 登出 / 部分清除等任意 auth 状态变化,
 *    user 变化时 reload(切回 guest 或换到新 userId 的 snapshot)。
 *
 * ## 不做的事(本地优先后不再有的概念)
 *
 * - HTTP bootstrap / refresh —— 删
 * - pending partition 占位 —— 删
 * - 5s 限速被动 refresh —— 删
 * - bootstrappedOnce / bootstrapInFlight / pendingRefresh / lastPassiveRefreshAt 状态 —— 删
 * - BackendError / NotStartedError —— 删(本地操作不会有这些错)
 *
 * ## 留给未来 C 路径的扩展点(总控 §10)
 *
 * - 本类不假设"永远本地",所有数据访问走 `BrowserEnvLocalStore` 接口
 * - `onChanged` 订阅 + `change` 事件广播 IPC 协议保留(未来推送通道复用)
 * - 写操作仍然返回 `Promise`(虽然内部同步),给未来云端化留余地
 */

import { EventEmitter } from 'events'

import { TokenManager } from '../auth'
import { createLogger } from '../logger'
import type {
  BrowserEnvBinding,
  BrowserEnvironment,
} from '../../shared/types/browser-env'
import { buildOrganizationBrowserPartition } from '../../shared/types/browser-env'
import {
  BrowserEnvLocalStore,
  DEFAULT_ENV_ID,
  DEFAULT_ENV_PARTITION_KEY,
  GUEST_USER_ID,
  generateEnvironmentId,
  generateEnvironmentPartitionKey,
  type BrowserEnvStorageBackend,
} from './BrowserEnvLocalStore'
import { ConfigPersistError, type BrowserEnvSnapshot } from '../services/ConfigService'

const log = createLogger('BrowserEnv')

// 默认 env 的 id / partition_key 是产品保证(ADR-2/3),复用 LocalStore 的
// 单一来源——避免在两个文件各定义一份字面量同步漂移。
const DEFAULT_PARTITION_KEY = DEFAULT_ENV_PARTITION_KEY

/** 业务校验失败时抛出 —— 调用方(IPC 层)负责转 4xx 错误码给 renderer。 */
export class BrowserEnvValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserEnvValidationError'
  }
}

export type BrowserEnvChangeReason =
  | 'created'
  | 'renamed'
  | 'deleted'
  | 'bound'
  | 'manual-refresh'

export interface BrowserEnvChangePayload {
  reason: BrowserEnvChangeReason
  /** 受影响的 environment id(deleted 时是被删的)。不精确变更可省略。 */
  environmentId?: string
  /** 受影响的 space id(bound 时指向被 bind 的)。 */
  spaceId?: string
}

interface InternalState {
  userId: string
  environments: BrowserEnvironment[]
  bindings: BrowserEnvBinding[]
  defaultEnv: BrowserEnvironment | null
  /** space_id → binding 的快查索引。 */
  bindingBySpace: Map<string, BrowserEnvBinding>
  envById: Map<string, BrowserEnvironment>
}

export interface BrowserEnvironmentServiceDeps {
  store?: BrowserEnvLocalStore
  /** 测试可注入。默认走 TokenManager(异步拿 userId)。 */
  resolveUserId?: () => Promise<string>
  /** 测试可注入。默认走 TokenManager.onAuthChanged（任意 auth 状态变化都通知）。 */
  onAuthChanged?: (cb: () => void) => () => void
  /**
   * 边界改造 Phase 3a：解析"当前活跃 Organization id"，用于普通浏览器的
   * Organization 级 cookie partition。生产装配在 `deferred-services` 注入
   * `getCLIOrganizationId`（由 `space:set-active` / chat query 维护）。
   *
   * **opt-in**：未注入时 `getPartitionForSpace` 回落到历史默认 env partition
   * （`tabtin:env:default`），既有单测无需改动即保持绿。
   */
  resolveCurrentOrganizationId?: () => string | null | undefined
}

/**
 * EMPTY_STATE 必须由函数生成 —— Map 是引用类型,如果做 module-level
 * 单例 const,多个 service 实例会**共享同一个 Map**,测试 reset 后再
 * `new` 拿到新实例但 Map 仍是同一份,埋下跨实例污染的雷。
 */
function createEmptyState(): InternalState {
  return {
    userId: GUEST_USER_ID,
    environments: [],
    bindings: [],
    defaultEnv: null,
    bindingBySpace: new Map(),
    envById: new Map(),
  }
}

export class BrowserEnvironmentService {
  private state: InternalState = createEmptyState()
  private started = false
  private firstResolveDone = false
  private readonly emitter = new EventEmitter()
  private readonly store: BrowserEnvLocalStore
  private readonly resolveUserId: () => Promise<string>
  private readonly onAuthChanged: (cb: () => void) => () => void
  private resolveCurrentOrganizationId: (() => string | null | undefined) | null
  private authUnsubscribe: (() => void) | null = null

  constructor(deps: BrowserEnvironmentServiceDeps = {}) {
    this.store = deps.store ?? new BrowserEnvLocalStore()
    this.resolveUserId = deps.resolveUserId ?? defaultResolveUserId
    this.onAuthChanged = deps.onAuthChanged ?? ((cb) => TokenManager.onAuthChanged(cb))
    this.resolveCurrentOrganizationId = deps.resolveCurrentOrganizationId ?? null
    // 构造时同步用 guest snapshot 初始化:
    //   - 保证 IPC 在 start() 前调用也能立即返回真实 partition
    //   - 避免任何"未就绪"分支(本地化后不存在该状态)
    this.loadFromStore(GUEST_USER_ID)
  }

  /**
   * 异步切到真实 userId 的 snapshot。可重复调用(幂等)。
   *
   * 失败兜底:任何环节抛错都只 warn,服务继续用 guest snapshot 工作 ——
   * 用户感知 = 看到 guest 数据(默认 env),不会卡死。
   */
  async start(): Promise<void> {
    if (this.started) {
      // 重入只重新订阅一次 auth 监听(若之前 unsubscribe 过)
      this.ensureAuthSubscription()
      return
    }
    this.started = true
    this.ensureAuthSubscription()
    try {
      const userId = await this.resolveUserId()
      // 显式跟踪"是否首次完成 user 解析"——而不是靠 `userId !== state.userId`
      // 隐式判定。后者会误判:如果未来构造时直接用真 userId(避开 guest 兜
      // 底),此处比较恒为 true 而不会 emit;反之如果首次解析得到 guest,
      // userId 不变也不 emit,renderer 拿不到一次"启动完成"信号。
      const isFirstResolve = !this.firstResolveDone
      this.firstResolveDone = true
      const previousUserId = this.state.userId
      this.switchUser(userId)
      // 首次完成 user 解析,或确实切了 user → 广播一次 change,
      // 让 IPC 桥接的 renderer / CookieSync 重建监听。
      if (isFirstResolve || userId !== previousUserId) {
        this.emitter.emit('change', { reason: 'manual-refresh' })
      }
    } catch (err) {
      log.warn('start 期间解析 userId 失败,继续使用 guest snapshot', err)
    }
  }

  /**
   * 边界改造 Phase 3a：注入 / 替换"当前活跃 Organization id"解析器。生产装配在
   * `deferred-services` 调用一次，把 `getCLIOrganizationId` 转进来。
   */
  setCurrentOrganizationIdResolver(resolver: (() => string | null | undefined) | null): void {
    this.resolveCurrentOrganizationId = resolver
  }

  /**
   * 同步查询 Space 应使用的浏览器 partition —— 永远返回真实 partition,无 pending 概念。
   *
   * 优先级（边界改造 Phase 3a）：
   *   1. **显式 env 绑定**（legacy，UI 已移除但数据模型保留）→ 该 env 的 partition_key
   *   2. **普通浏览器** → Organization 级共享 partition `tabtin:organization:{id}:browser`
   *      （同 organization 下桌面 + 所有 Space/对话共享同一份 cookie）
   *   3. 无 organization（未登录 / guest / 启动早期解析器未就绪）→ 历史默认 env
   *      partition（`tabtin:env:default`）兜底
   *
   * 隔离 named session（`tabtin:session:*`）不走本方法（renderer 端 createWorkspace
   * 直接用 `buildSessionPartition` 显式 partition），承重墙保持。
   */
  getPartitionForSpace(
    spaceId: string,
    authoritativeOrganizationId?: string | null,
  ): string {
    // 1. 显式 env 绑定优先（本地化后只会出现 is_explicit=true 的显式绑定）
    if (typeof spaceId === 'string' && spaceId) {
      const binding = this.state.bindingBySpace.get(spaceId)
      if (binding) {
        const env = this.state.envById.get(binding.environment_id)
        if (env?.partition_key) return env.partition_key
      }
    }
    // 2. 已经由服务端 Workspace 校验的 Organization 优先于当前 UI 上下文。
    //    登录态接力等跨设备 action 会显式传入，避免组织切换竞态写错罐。
    const authoritativePartition = buildOrganizationBrowserPartition(
      authoritativeOrganizationId,
    )
    if (authoritativePartition) return authoritativePartition
    // 3. 普通浏览器：当前 Organization 级共享 cookie partition
    const organizationPartition = this.resolveOrganizationBrowserPartition()
    if (organizationPartition) return organizationPartition
    // 4. 兜底：无 organization 时回落历史默认 env partition
    return DEFAULT_PARTITION_KEY
  }

  /**
   * 解析当前 organization 对应的浏览器 partition；拿不到 organization（未注入解析器 /
   * 解析器抛错 / 返回空）时返回空串，由 `getPartitionForSpace` 兜底。
   */
  private resolveOrganizationBrowserPartition(): string {
    if (!this.resolveCurrentOrganizationId) return ''
    let organizationId: string | null | undefined
    try {
      organizationId = this.resolveCurrentOrganizationId()
    } catch (err) {
      log.warn('resolveCurrentOrganizationId 抛错,回落默认 partition:', err)
      return ''
    }
    return buildOrganizationBrowserPartition(organizationId)
  }

  getEnvironmentBySpace(spaceId: string): BrowserEnvironment | null {
    if (typeof spaceId === 'string' && spaceId) {
      const binding = this.state.bindingBySpace.get(spaceId)
      if (binding) {
        const env = this.state.envById.get(binding.environment_id)
        if (env) return env
      }
    }
    return this.state.defaultEnv
  }

  listEnvironmentsSync(): BrowserEnvironment[] {
    return this.state.environments.map((e) => ({ ...e }))
  }

  listBindingsSync(): BrowserEnvBinding[] {
    return this.state.bindings.map((b) => ({ ...b }))
  }

  // ── 写操作:本地化后全部同步,但保留 Promise 签名给未来云端化留余地 ──

  async listEnvironments(): Promise<BrowserEnvironment[]> {
    return this.listEnvironmentsSync()
  }

  async createEnvironment(name: string): Promise<BrowserEnvironment> {
    const trimmed = (name ?? '').trim()
    if (!trimmed) {
      throw new BrowserEnvValidationError('ENV_NAME_REQUIRED', '环境名不能为空')
    }
    if (trimmed.length > 50) {
      throw new BrowserEnvValidationError('ENV_NAME_TOO_LONG', '环境名最多 50 字符')
    }
    if (this.state.environments.some((e) => e.name === trimmed)) {
      throw new BrowserEnvValidationError('ENV_NAME_DUPLICATE', '已存在同名环境')
    }
    const now = new Date().toISOString()
    const env: BrowserEnvironment = {
      id: generateEnvironmentId(),
      name: trimmed,
      partition_key: generateEnvironmentPartitionKey(),
      is_default: false,
      binding_count: 0,
      explicit_binding_count: 0,
      using_space_count: 0,
      created_at: now,
      updated_at: now,
    }
    const nextEnvs = [...this.state.environments, env]
    this.persist({ environments: nextEnvs, bindings: this.state.bindings })
    this.applySnapshot(this.state.userId, { environments: nextEnvs, bindings: this.state.bindings })
    this.emitter.emit('change', { reason: 'created', environmentId: env.id })
    return { ...env }
  }

  async renameEnvironment(id: string, name: string): Promise<BrowserEnvironment> {
    const trimmed = (name ?? '').trim()
    if (!trimmed) {
      throw new BrowserEnvValidationError('ENV_NAME_REQUIRED', '环境名不能为空')
    }
    if (trimmed.length > 50) {
      throw new BrowserEnvValidationError('ENV_NAME_TOO_LONG', '环境名最多 50 字符')
    }
    const target = this.state.envById.get(id)
    if (!target) {
      throw new BrowserEnvValidationError('ENV_NOT_FOUND', `找不到环境 ${id}`)
    }
    if (target.is_default) {
      throw new BrowserEnvValidationError('DEFAULT_ENV_LOCKED', '默认环境不可改名')
    }
    if (this.state.environments.some((e) => e.id !== id && e.name === trimmed)) {
      throw new BrowserEnvValidationError('ENV_NAME_DUPLICATE', '已存在同名环境')
    }
    const now = new Date().toISOString()
    const updated: BrowserEnvironment = { ...target, name: trimmed, updated_at: now }
    const nextEnvs = this.state.environments.map((e) => (e.id === id ? updated : e))
    this.persist({ environments: nextEnvs, bindings: this.state.bindings })
    this.applySnapshot(this.state.userId, { environments: nextEnvs, bindings: this.state.bindings })
    this.emitter.emit('change', { reason: 'renamed', environmentId: id })
    return { ...updated }
  }

  async deleteEnvironment(id: string): Promise<{
    deleted_id: string
    rebound_bindings: number
    rebound_space_ids: string[]
  }> {
    const target = this.state.envById.get(id)
    if (!target) {
      throw new BrowserEnvValidationError('ENV_NOT_FOUND', `找不到环境 ${id}`)
    }
    if (target.is_default) {
      throw new BrowserEnvValidationError('DEFAULT_ENV_LOCKED', '默认环境不可删除')
    }
    // 把绑到该 env 的 Space 重置回默认 env(语义对齐云端旧实现)
    const reboundSpaceIds: string[] = []
    const nextBindings = this.state.bindings.flatMap<BrowserEnvBinding>((b) => {
      if (b.environment_id !== id) return [b]
      reboundSpaceIds.push(b.space_id)
      // 删除显式绑定 = fallback 到默认 env;不再保留 is_explicit=false 的
      // 显式记录(本地无后端 fallback 表,getEnvironmentBySpace 会用 defaultEnv)
      return []
    })
    const nextEnvs = this.state.environments.filter((e) => e.id !== id)
    this.persist({ environments: nextEnvs, bindings: nextBindings })
    this.applySnapshot(this.state.userId, { environments: nextEnvs, bindings: nextBindings })
    this.emitter.emit('change', { reason: 'deleted', environmentId: id })
    return {
      deleted_id: id,
      rebound_bindings: reboundSpaceIds.length,
      rebound_space_ids: reboundSpaceIds,
    }
  }

  async bindSpaceToEnvironment(
    spaceId: string,
    environmentId: string,
  ): Promise<BrowserEnvironment> {
    if (typeof spaceId !== 'string' || !spaceId) {
      throw new BrowserEnvValidationError('SPACE_ID_REQUIRED', 'spaceId 不能为空')
    }
    const env = this.state.envById.get(environmentId)
    if (!env) {
      throw new BrowserEnvValidationError('ENV_NOT_FOUND', `找不到环境 ${environmentId}`)
    }
    const next: BrowserEnvBinding = {
      space_id: spaceId,
      environment_id: environmentId,
      is_explicit: true,
    }
    const others = this.state.bindings.filter((b) => b.space_id !== spaceId)
    const nextBindings = [...others, next]
    this.persist({ environments: this.state.environments, bindings: nextBindings })
    this.applySnapshot(this.state.userId, {
      environments: this.state.environments,
      bindings: nextBindings,
    })
    this.emitter.emit('change', { reason: 'bound', spaceId, environmentId })
    return { ...env }
  }

  // ── 事件 ──

  onChanged(handler: (payload: BrowserEnvChangePayload) => void): () => void {
    this.emitter.on('change', handler)
    return () => {
      this.emitter.off('change', handler)
    }
  }

  // ── 生命周期 ──

  /** 测试 / 退出时调用 —— 解除 auth 订阅。重启 service 需先 `start()`。 */
  dispose(): void {
    if (this.authUnsubscribe) {
      try {
        this.authUnsubscribe()
      } catch {
        /* ignore */
      }
      this.authUnsubscribe = null
    }
  }

  // ── 私有 ──

  private ensureAuthSubscription(): void {
    if (this.authUnsubscribe) return
    try {
      this.authUnsubscribe = this.onAuthChanged(() => {
        this.handleAuthChange().catch((err) => {
          log.warn('auth 变更后 reload 快照失败:', err)
        })
      })
    } catch (err) {
      log.warn('注册 auth 订阅失败,多账号切换不会自动同步 env 数据:', err)
    }
  }

  private async handleAuthChange(): Promise<void> {
    const userId = await this.resolveUserId()
    if (userId === this.state.userId) return
    log.info(`检测到 auth 变更,切换 env snapshot 到 userId=${userId}`)
    this.switchUser(userId)
    this.emitter.emit('change', { reason: 'manual-refresh' })
  }

  private switchUser(userId: string): void {
    if (userId === this.state.userId && this.state.environments.length > 0) return
    this.loadFromStore(userId)
  }

  private loadFromStore(userId: string): void {
    const snapshot = this.store.ensureDefault(userId)
    this.applySnapshot(userId, snapshot)
  }

  /**
   * 把 snapshot 写入本地存储。失败时**不**静默吞掉 —— 让上层(写操作 entry
   * point)拿到 `BrowserEnvValidationError(code='PERSIST_FAILED')`,这样:
   *   1. IPC 层会返回 `success:false` 让 renderer toast 失败
   *   2. 写操作不会再继续 applySnapshot / emit change(避免"UI 显示成功 +
   *      重启数据回滚"的隐藏 bug)
   */
  private persist(snapshot: BrowserEnvSnapshot): void {
    try {
      this.store.writeSync(this.state.userId, snapshot)
    } catch (err) {
      if (err instanceof ConfigPersistError) {
        log.warn('写入本地 env 快照失败,中断本次写操作:', err)
        throw new BrowserEnvValidationError(
          'PERSIST_FAILED',
          `本地存储写入失败:${err.message}`,
        )
      }
      throw err
    }
  }

  /**
   * 把 snapshot 应用到内存 + 重算派生字段(binding_count / using_space_count
   * 等)。
   *
   * Wave 1 简化的语义:
   *   - explicit_binding_count = bindings 中绑该 env 的条数
   *   - binding_count = explicit_binding_count(向后兼容老字段名)
   *   - using_space_count = explicit_binding_count(本地无"全量 Space 列表",
   *     默认 env 也无法算"未显式绑定的隐式数量",取等)
   *
   * 这是本地化后的产品折衷,UI 文案会显示"与其他 N 个 Agent 共享" — 默认
   * env 在没人显式绑定时会显示"0 个" —— 真实但稍显别扭。Wave 2/3 若产品
   * 想优化文案再处理。
   */
  private applySnapshot(userId: string, snapshot: BrowserEnvSnapshot): void {
    const envCounts = new Map<string, number>()
    const bindingBySpace = new Map<string, BrowserEnvBinding>()
    const validBindings: BrowserEnvBinding[] = []
    const tmpEnvById = new Map<string, BrowserEnvironment>()
    for (const e of snapshot.environments) tmpEnvById.set(e.id, e)
    for (const b of snapshot.bindings) {
      if (!b || typeof b.space_id !== 'string' || !b.space_id) continue
      if (!tmpEnvById.has(b.environment_id)) {
        log.warn('snapshot 含悬空 environment_id,跳过', {
          space_id: b.space_id,
          environment_id: b.environment_id,
        })
        continue
      }
      validBindings.push(b)
      bindingBySpace.set(b.space_id, b)
      envCounts.set(b.environment_id, (envCounts.get(b.environment_id) ?? 0) + 1)
    }

    const envs = snapshot.environments.map((e) => {
      const count = envCounts.get(e.id) ?? 0
      return {
        ...e,
        binding_count: count,
        explicit_binding_count: count,
        using_space_count: count,
      }
    })

    const envById = new Map<string, BrowserEnvironment>()
    for (const e of envs) envById.set(e.id, e)

    const defaultEnv = envs.find((e) => e.is_default) ?? envs[0] ?? null

    this.state = {
      userId,
      environments: envs,
      bindings: validBindings,
      defaultEnv,
      bindingBySpace,
      envById,
    }
  }
}

async function defaultResolveUserId(): Promise<string> {
  try {
    await TokenManager.preloadAuthData()
    // L-W1-8 契约:auth 视为"有效"必须 access token + userInfo 都存在。仅有 userInfo
    // 没 token = token 已过期/被 clearTokens 清除,等价于"无效会话",落 guest snapshot。
    // 没有这道判定时,token 刷新失败路径调 `clearTokens()` → BES 仍读到旧 userInfo →
    // 不切 guest,导致登出态下下游模块仍持有上一个 user 的数据(L-W1-8 描述的边角)。
    const accessToken = await TokenManager.getAccessToken()
    if (!accessToken) {
      return GUEST_USER_ID
    }
    const userInfo = await TokenManager.getUserInfo()
    const id =
      (userInfo?.id as unknown) ??
      (userInfo?.user_id as unknown) ??
      (userInfo?.userId as unknown)
    if (typeof id === 'string' && id) return id
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  } catch (err) {
    log.debug('resolveUserId 失败,使用 guest:', err)
  }
  return GUEST_USER_ID
}

// ── 模块级单例 ──
//
// 主进程生命周期 = 应用生命周期;单例即可,省去每次 import 都要 new 的负担。
// 对象在 deferred-services 里被 start(),IPC 层 / 其他主进程模块直接 import 使用。

let _instance: BrowserEnvironmentService | null = null

export function getBrowserEnvironmentService(): BrowserEnvironmentService {
  if (!_instance) _instance = new BrowserEnvironmentService()
  return _instance
}

/** 仅测试用：重置单例 —— 避免跨用例状态串。 */
export function __resetBrowserEnvironmentServiceForTests(): void {
  if (_instance) {
    try {
      _instance.dispose()
    } catch {
      /* ignore */
    }
  }
  _instance = null
}

export { DEFAULT_PARTITION_KEY, DEFAULT_ENV_ID }
