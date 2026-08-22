/**
 * @tabtin/resource-router · router
 *
 * `ResourceRouter` —— 「在 Space 内打开任意指针」唯一入口。三种 Agent 输出
 * 形式（增强 markdown / open_in_space 工具 / 富 ResourceCard）最终都收口到
 * `ResourceRouter.open(spaceId, pointer)`。
 *
 * 这是 RFC §9 决定的「ContextRegistry 薄包装层」：
 *   - 不重新造轮子——读 `ContextRegistryAdapter.hasHandlerByAppId` 判断
 *     candidate 真在
 *   - 最终落点复用 `useSpaceContextTabsStore.openResourceTab`，不在本层
 *     塞新的 store
 *   - 自己只多两个数据结构（typeIndex / schemeIndex）+ 两个方法
 *     （resolve / open）
 *
 * D2 优先级表（PRD §4 D2）在 `resolve()` 内严格执行：
 *   1. user_pref         —— `useResourceOpenPreferences`
 *   2. session_override  —— `options.forceCarrierAppId`
 *   3. agent_hint        —— `pointer.hint`
 *   4. manifest_default  —— registry priority desc
 *   5. system_fallback   —— SYSTEM_CARRIER_APP_ID（永远兜底，不会缺失）
 *
 * `options.modifierExternal` 是 D2 之外的独立短路通道（⌘ 修饰键），直接跳第 5 层。
 */

import type {
  ContextRegistryAdapter,
  OpenOutcome,
  OpenResourceTabFn,
  OpenResourceTabParams,
  ResolveCandidate,
  ResolveResult,
  ResolveSource,
  ResourceOpenEvent,
  ResourceOpenPreferenceStore,
  ResourceOpenTriggerSource,
  ResourcePointer,
} from './types.js'
import { SYSTEM_CARRIER_APP_ID } from './types.js'
import { ResourceRouterRegistry } from './registry.js'

// ─── 已知坏 scheme 黑名单（D4 全开 + known-bad 兜底） ─────────────────

/**
 * 思路参照 `apps/tabtin-electron/src/main/credential-vault/autofill-service.ts:598`
 * 的 `chrome://` / `devtools://` 跳过判断；本表在那个基础上**额外**收口
 * `chrome-extension:` —— autofill 场景不需要拦截扩展 URL，但 ResourceRouter
 * 是用户在 chat 里点击外链的入口，扩展 URL 不该被路由到系统应用（一般
 * 是 Agent 误生成的 cosmetic 链接）。任何扩展请同步那里 + 这里。
 *
 * 注意：`javascript:` / `vbscript:` 不在此处而是在 sanitize 层 XSS 黑名单里
 * 拦截（`packages/media-core/src/svg/primitives.ts:HREF_DANGEROUS_RE`），
 * 本层不抢那个职责。
 */
const KNOWN_BAD_SCHEMES = new Set<string>(['chrome:', 'chrome-extension:', 'devtools:'])

// ─── Resolve / Open 上下文 ─────────────────────────────────────────────

export interface ResolveContext {
  spaceId: string
  /**
   * 当前会话临时切换（用户右键「用 X 打开」）；仅本次点击生效。
   * D2 第 2 层。
   */
  sessionOverride?: { pointerKey: string; carrierAppId: string }
}

export interface OpenOptions {
  /**
   * 强制使用某个 carrier；D2 第 2 层「session 临时切换」入口。
   * 若指定且 contextRegistry 找不到对应 handler，按 fallback 处理（system）。
   */
  forceCarrierAppId?: string

  /**
   * ⌘ / Ctrl 修饰键短路：直接跳到第 5 层系统应用，不参与 1-4 排序。
   * D2 优先级表外的独立通道。
   */
  modifierExternal?: boolean

  /**
   * 触发源 tag（埋点用）。默认 'chat_markdown'，调用方应明确指定。
   */
  triggerSource?: ResourceOpenTriggerSource

  /**
   * UI tab bucket override. The resource still belongs to `spaceId`; this only
   * controls where Electron records/activates the opened tab.
   */
  tabScopeKey?: string | null

  /**
   * 仅登记到目标标签桶，不切换 active、不拉起外部应用。
   * 用于 Agent 显式交付物进入任务工作台，但不抢用户当前焦点。
   */
  registerOnly?: boolean

  /** 调用方上下文（埋点用） */
  userId?: string
  organizationId?: string
  agentRunId?: string | null
  messageId?: string | null
  toolCallId?: string | null
  clientVersion?: string
}

// ─── 依赖注入 ───────────────────────────────────────────────────────

export interface ResourceRouterDeps {
  contextRegistry: ContextRegistryAdapter
  preferenceStore: ResourceOpenPreferenceStore
  openResourceTab: OpenResourceTabFn
  /**
   * IPC 包装（renderer 通过 preload 调 main 进程的 shell.openExternal）。
   * 失败必须 throw 让 router 捕获 → outcome='error'。
   */
  shellOpenExternal: (url: string) => Promise<void> | void
  /**
   * 异步埋点发射器。失败永远不能阻塞 UI——调用方实现里应 catch 后 best-effort。
   * 默认空实现（适用于 unit test）。
   */
  emitEvent?: (event: ResourceOpenEvent) => void
  /** 默认 'electron'；daemon 端实例化时传 'daemon'（mobile 单独专题）。 */
  client?: ResourceOpenEvent['client']
  /**
   * Local file artifact resolver. Used only for self-format file pointers
   * such as `tabtin://resource/file/artifacts%2Fx.xlsx?hint=tabfiles`.
   * Runtime-specific wiring resolves the relative path against the current
   * Space-bound Agent working_dir and may throw user-facing errors.
   */
  localFileResolver?: (ctx: {
    spaceId: string
    pointer: ResourcePointer
  }) => OpenResourceTabParams | null | undefined | Promise<OpenResourceTabParams | null | undefined>
}

// ─── ResourceRouter 主类 ────────────────────────────────────────────

export class ResourceRouter {
  constructor(
    private readonly deps: ResourceRouterDeps,
    private readonly registry: ResourceRouterRegistry,
  ) {}

  /**
   * 按 D2 五层优先级排出 candidates。同步、纯函数、无副作用——
   * 任何调用方都可在 onContextMenu 里调用以渲染右键菜单。
   *
   * @param pointer 已 parse 好的 ResourcePointer（注意：input 必须已是 pointer
   *   而非原始字符串——parse 留给调用点处理，避免 router 双职责）
   * @param ctx Resolve 上下文（必填 spaceId；session override 可选）
   */
  resolve(pointer: ResourcePointer, ctx: ResolveContext): ResolveResult {
    const candidates: ResolveCandidate[] = []

    // 注：层级 5（system_fallback）永远在尾部 push，保证 candidates 永远非空。

    // ── 收集 manifest_default（第 4 层）作为基底 ────────────
    // 自有格式优先按 type 查；行业格式按 scheme 查。两者不混淆。
    const manifestCandidates: ResolveCandidate[] = []

    if (pointer.scheme === 'tabtin' && pointer.type) {
      const list = this.registry.lookupByType(pointer.type)
      for (const c of list) {
        manifestCandidates.push({
          appId: c.appId,
          priority: c.priority,
          source: 'manifest_default',
        })
      }
    } else if (pointer.scheme !== 'tabtin' && pointer.scheme !== 'unknown') {
      const list = this.registry.lookupByScheme(`${pointer.scheme}:`)
      for (const c of list) {
        manifestCandidates.push({
          appId: c.appId,
          priority: c.priority,
          source: 'manifest_default',
        })
      }
    }

    // ── 第 1 层：user_pref ────────────────────────────────────
    const prefKey = preferenceKeyOf(pointer)
    const userPrefAppId = prefKey ? this.deps.preferenceStore.get(prefKey) : undefined
    if (userPrefAppId && this.deps.contextRegistry.hasHandlerByAppId(userPrefAppId)) {
      candidates.push({
        appId: userPrefAppId,
        // 用 +Infinity 不合适——埋点维度看排序；约定层 1 用 1e9 这样的数字常量
        priority: 1_000_000_000,
        source: 'user_pref',
      })
    }

    // ── 第 2 层：session_override ────────────────────────────
    if (
      ctx.sessionOverride &&
      ctx.sessionOverride.carrierAppId &&
      ctx.sessionOverride.pointerKey === prefKey &&
      this.deps.contextRegistry.hasHandlerByAppId(ctx.sessionOverride.carrierAppId)
    ) {
      candidates.push({
        appId: ctx.sessionOverride.carrierAppId,
        priority: 999_000_000,
        source: 'session_override',
      })
    }

    // ── 第 3 层：agent_hint ─────────────────────────────────
    if (pointer.hint && this.deps.contextRegistry.hasHandlerByAppId(pointer.hint)) {
      candidates.push({
        appId: pointer.hint,
        priority: 998_000_000,
        source: 'agent_hint',
      })
    }

    // ── 第 4 层：manifest_default ───────────────────────────
    // 过滤掉 contextRegistry 里没有对应 handler 的 ghost candidate（manifest 写了
    // 但 handler 文件还没加 / 已被删除的边角情况）。
    for (const c of manifestCandidates) {
      if (this.deps.contextRegistry.hasHandlerByAppId(c.appId)) {
        candidates.push(c)
      }
    }

    // ── 第 5 层：system_fallback ────────────────────────────
    candidates.push({
      appId: SYSTEM_CARRIER_APP_ID,
      priority: -1, // 永远在尾部
      source: 'system_fallback',
    })

    // 注意：不要再二次按 priority 排序——我们故意按层级 push，第 1 层永远最前。
    // 单层内部 manifest_default 已在 registry 排好。

    return {
      pointer,
      candidates,
      chosen: candidates[0]!,
    }
  }

  /**
   * 在 Space 内打开 / 调系统应用。返回 OpenOutcome 便于调用方做后续 toast / log。
   * 始终不抛异常——任何 throw 都被 catch 转成 outcome='error'。
   */
  async open(
    spaceId: string,
    pointer: ResourcePointer,
    options?: OpenOptions,
  ): Promise<OpenOutcome> {
    const startedAt = Date.now()
    const triggerSource = options?.triggerSource ?? 'chat_markdown'

    try {
      // Step 1. 决定 carrier
      //
      // 设计要点（修复双轮 Review 视角 A P0-1 + 视角 C P1-1/P1-2）：
      //   - 唯一短路通道是 ⌘ 修饰键 → 直接跳第 5 层（D2 优先级表外的独立短路）
      //   - `forceCarrierAppId` 不再独立短路，而是注入 ResolveContext.sessionOverride，
      //     交还 resolve() 让 D2 五层（user_pref > session_override > hint > manifest > system）
      //     继续生效——保证 user_pref 永远胜过 session 临时切换（PRD §4 D2 用户主权原则）
      let chosen: ResolveCandidate

      if (options?.modifierExternal) {
        // ⌘ 修饰键短路 ── 直接系统应用，resolve_source = 'modifier_key'（独立 tag）
        chosen = {
          appId: SYSTEM_CARRIER_APP_ID,
          priority: -1,
          source: 'modifier_key',
        }
      } else {
        const ctx: ResolveContext = { spaceId }
        // sessionOverride 数据源两路：
        //   1. options.forceCarrierAppId —— 调用方显式传入（如 RFC 早期 W2/W3 测试
        //      fixture）；继续保留以保证向后兼容
        //   2. preferenceStore.getSessionOverride(prefKey) —— W4 接通的 zustand
        //      sessionOverrides Map；renderer 端"用 X 打开"统一走 store，所有
        //      router.open 调用点（chat / open_in_space / 富 ResourceCard）自动
        //      获得 D2 第 2 层语义，无需每个调用点重复读
        // 优先级：option 显式 > store；store 没值则不注入
        const prefKey = preferenceKeyOf(pointer)
        if (prefKey) {
          const sessionCarrierAppId =
            options?.forceCarrierAppId ?? this.deps.preferenceStore.getSessionOverride?.(prefKey)
          if (sessionCarrierAppId) {
            ctx.sessionOverride = {
              pointerKey: prefKey,
              carrierAppId: sessionCarrierAppId,
            }
          }
        }
        const result = this.resolve(pointer, ctx)
        chosen = result.chosen
      }

      // Step 2. 落地 carrier
      if (chosen.appId === SYSTEM_CARRIER_APP_ID) {
        if (options?.registerOnly) {
          return {
            outcome: 'error',
            carrierAppId: null,
            resolveSource: chosen.source,
            errorMessage: 'Resource cannot be registered in Space',
            durationMs: Date.now() - startedAt,
          }
        }
        return await this.openExternalSafely(pointer, chosen.source, startedAt, {
          triggerSource,
          spaceId,
          ...options,
        })
      }

      const handlerExists = this.deps.contextRegistry.hasHandlerByAppId(chosen.appId)
      if (!handlerExists) {
        // 兜底：candidate 来自 manifest 但 contextRegistry 没注册——降级到 system
        return await this.openExternalSafely(pointer, 'system_fallback', startedAt, {
          triggerSource,
          spaceId,
          ...options,
        })
      }

      const params = await this.deriveOpenParams(spaceId, pointer)
      if (options?.tabScopeKey) {
        params.tabScopeKey = options.tabScopeKey
      }
      if (options?.registerOnly) {
        params.silent = true
      }
      await this.deps.openResourceTab(spaceId, params)

      const outcome: OpenOutcome = {
        outcome: 'in_space_opened',
        carrierAppId: chosen.appId,
        resolveSource: chosen.source,
        durationMs: Date.now() - startedAt,
      }
      this.emitEvent({
        outcome,
        pointer,
        triggerSource,
        spaceId,
        opts: options,
        eventName: 'resource_open.resolved',
      })
      return outcome
    } catch (err) {
      const outcome: OpenOutcome = {
        outcome: 'error',
        carrierAppId: null,
        resolveSource: 'system_fallback',
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      }
      this.emitEvent({
        outcome,
        pointer,
        triggerSource,
        spaceId,
        opts: options,
        eventName: 'resource_open.failed',
      })
      return outcome
    }
  }

  // ── 内部 ─────────────────────────────────────────────────

  private async openExternalSafely(
    pointer: ResourcePointer,
    resolveSource: ResolveSource,
    startedAt: number,
    ctx: {
      triggerSource: ResourceOpenTriggerSource
      spaceId: string
    } & OpenOptions,
  ): Promise<OpenOutcome> {
    const protocol = `${pointer.scheme}:`
    if (KNOWN_BAD_SCHEMES.has(protocol)) {
      const outcome: OpenOutcome = {
        outcome: 'denied_known_bad',
        carrierAppId: null,
        resolveSource,
        errorMessage: `Refused to open known-bad scheme: ${protocol}`,
        durationMs: Date.now() - startedAt,
      }
      this.emitEvent({
        outcome,
        pointer,
        triggerSource: ctx.triggerSource,
        spaceId: ctx.spaceId,
        opts: ctx,
        eventName: 'resource_open.failed',
      })
      return outcome
    }

    try {
      await this.deps.shellOpenExternal(pointer.raw)
      const outcome: OpenOutcome = {
        outcome: 'system_app_opened',
        carrierAppId: null,
        resolveSource,
        durationMs: Date.now() - startedAt,
      }
      this.emitEvent({
        outcome,
        pointer,
        triggerSource: ctx.triggerSource,
        spaceId: ctx.spaceId,
        opts: ctx,
        eventName: 'resource_open.resolved',
      })
      return outcome
    } catch (err) {
      const outcome: OpenOutcome = {
        outcome: 'error',
        carrierAppId: null,
        resolveSource,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      }
      this.emitEvent({
        outcome,
        pointer,
        triggerSource: ctx.triggerSource,
        spaceId: ctx.spaceId,
        opts: ctx,
        eventName: 'resource_open.failed',
      })
      return outcome
    }
  }

  private emitEvent(args: {
    outcome: OpenOutcome
    pointer: ResourcePointer
    triggerSource: ResourceOpenTriggerSource
    spaceId: string
    opts: OpenOptions | undefined
    eventName: ResourceOpenEvent['event_name']
  }): void {
    const emit = this.deps.emitEvent
    if (!emit) return
    try {
      emit(buildResourceOpenEvent({
        outcome: args.outcome,
        pointer: args.pointer,
        triggerSource: args.triggerSource,
        spaceId: args.spaceId,
        opts: args.opts,
        eventName: args.eventName,
        client: this.deps.client ?? 'electron',
      }))
    } catch {
      // 埋点失败永远不能阻塞 UI / 抛 error
    }
  }

  private async deriveOpenParams(
    spaceId: string,
    pointer: ResourcePointer,
  ): Promise<OpenResourceTabParams> {
    if (isLocalFileResourcePointer(pointer) && this.deps.localFileResolver) {
      const resolved = await this.deps.localFileResolver({ spaceId, pointer })
      if (resolved) return resolved
    }
    return derivePointerOpenParams(pointer)
  }
}

// ─── 辅助函数 ────────────────────────────────────────────────

/**
 * 用户偏好 store 的 key 形态。
 *
 * 规则（与 W4 settings Panel 共识）：
 *   - 自有格式 + type 非空 → `'type:<ContextRefType>'`
 *   - 行业格式 → `'scheme:<scheme>:'`（注意尾冒号，与 URL.protocol 形态一致）
 *   - 解析失败 / scheme === 'unknown' → null（无法形成稳定 key，跳过偏好层）
 */
export function preferenceKeyOf(pointer: ResourcePointer): string | null {
  if (pointer.scheme === 'tabtin' && pointer.type) {
    return `type:${pointer.type}`
  }
  if (pointer.scheme && pointer.scheme !== 'unknown' && pointer.scheme !== 'tabtin') {
    return `scheme:${pointer.scheme}:`
  }
  return null
}

/**
 * Pointer → openResourceTab 入参映射。
 *
 * 自有格式：直接用 `pointer.type` / `pointer.id` / `pointer.meta`。
 * 行业格式：把 raw 装进 meta.url（与 W3 改造时 ChatContent.handleContextBlockNavigate
 * 一致；handler 自决怎么用）。
 */
export function isLocalFileResourcePointer(pointer: ResourcePointer): boolean {
  return pointer.scheme === 'tabtin' && pointer.type === 'file'
}

export function derivePointerOpenParams(pointer: ResourcePointer): OpenResourceTabParams {
  if (pointer.scheme === 'tabtin' && pointer.type) {
    return {
      type: pointer.type,
      id: pointer.id,
      ...(typeof pointer.meta?.['title'] === 'string'
        ? { title: pointer.meta['title'] as string }
        : {}),
      ...(pointer.meta ? { meta: pointer.meta } : {}),
    }
  }
  // 行业格式：type 留 null 不合规——但 openResourceTab 接受具体 type，
  // 调用方应当先按 scheme → type 反查 manifest。本函数只做语义上「就用原文 raw」
  // 的兜底；上层 W3 chat handler 会专门为 file:// / mailto: 生成正确的 type/id。
  // 该兜底分支主要用于「scheme 没注册但又走不到 system fallback」的极端情况，
  // openResourceTab 实现端会按 type 查 handler 失败而抛错——这是预期行为。
  return {
    type: pointer.scheme,
    id: pointer.raw,
    meta: { url: pointer.raw },
  }
}

interface BuildEventArgs {
  outcome: OpenOutcome
  pointer: ResourcePointer
  triggerSource: ResourceOpenTriggerSource
  spaceId: string
  opts: OpenOptions | undefined
  eventName: ResourceOpenEvent['event_name']
  client: ResourceOpenEvent['client']
}

function buildResourceOpenEvent(args: BuildEventArgs): ResourceOpenEvent {
  return {
    event_name: args.eventName,
    trigger_source: args.triggerSource,
    pointer_scheme: args.pointer.scheme,
    pointer_type: args.pointer.type,
    pointer_id_hash: hashPointerId(args.pointer.id),
    hint_app_id: args.pointer.hint,
    resolved_carrier_app_id: args.outcome.carrierAppId,
    resolve_source: args.outcome.resolveSource,
    outcome: args.outcome.outcome,
    space_id: args.spaceId,
    user_id: args.opts?.userId ?? '',
    organization_id: args.opts?.organizationId ?? '',
    agent_run_id: args.opts?.agentRunId ?? null,
    message_id: args.opts?.messageId ?? null,
    tool_call_id: args.opts?.toolCallId ?? null,
    duration_ms: args.outcome.durationMs ?? 0,
    ts: Date.now(),
    ...(args.outcome.errorMessage ? { error_message: args.outcome.errorMessage } : {}),
    client: args.client,
    client_version: args.opts?.clientVersion ?? '',
  }
}

/**
 * pointer.id 的 16 字符不可逆摘要（同步 hash，**非 SHA256**）。
 *
 * 隐私考虑：上报时不能写明文 url / 业务 ID（RFC §8.1 拒绝清单）。本实现用
 * djb2 + FNV-1a 双轨 32-bit 累加器拼成 16 hex 字符（8 bytes）输出。
 *
 * 为何不是 SHA256：
 *   - SubtleCrypto.digest 是 async（Web Crypto API 唯一入口），但 router emit
 *     必须同步——任何 await 都会让"用户点了链接 → 立刻打开"的关键路径在
 *     emit 时阻塞 1+ 个 micro-task，影响性能预算（resolve()<5ms / open()<50ms）
 *   - 隐私目标只是"不让明文 url / 业务 ID 入库"，不要求密码学安全（输入空间
 *     是用户业务 ID，不是密码 / token），32×2-bit 摘要碰撞概率对统计聚合无影响
 *
 * 这跟 RFC v1.0 §8.1 字面写的"SHA256(pointer.id)[:16]"不一致——RFC 起草时
 * 没考虑 SubtleCrypto 的 async 约束。harness §6.2 已登记此契约修订项；
 * W7 实施埋点上报通路时若要真 SHA256，需把整条 emit 链改成 async（性能
 * 预算重审）或在 main 进程 telemetry queue 重 hash 一次。
 *
 * 算法版本：v1（djb2 + FNV-1a 双轨）。如需迁移到 SHA256，应在事件 schema
 * 加 `pointer_id_hash_algo` 字段做向后兼容查询。
 */
function hashPointerId(id: string): string {
  let h1 = 0x811c9dc5 >>> 0 // djb2 起始（也是 FNV offset basis）
  let h2 = 0xcbf29ce4 >>> 0 // FNV-1a 起始
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i)
    h1 = ((h1 << 5) + h1 + c) >>> 0 // djb2 风格：h1*33 + c
    h2 = ((h2 ^ c) * 0x01000193) >>> 0 // FNV-1a：h2 ^= c; h2 *= FNV prime
  }
  const hex1 = h1.toString(16).padStart(8, '0')
  const hex2 = h2.toString(16).padStart(8, '0')
  return (hex1 + hex2).slice(0, 16)
}
