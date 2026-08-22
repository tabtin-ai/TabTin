/**
 * CLI request context — shared module owning per-request state used by both
 * `cli-server.ts` and `routes/*.ts`.
 *
 * Existed because `cli-server.ts` imports route handlers (`./routes/*`) for
 * dispatch, while route handlers in turn need the current Space / executor /
 * bridge to do their work. Putting those module-level state vars + getters
 * directly on `cli-server.ts` created ~6 pairs of circular dependencies. This
 * module owns the state instead, so both sides depend on it (a leaf, not each
 * other).
 *
 * `cli-server.ts` re-exports the same names so external callers
 * (ipc-registry / bridge-core / deferred-init-action-bridge / tests) keep
 * importing from `../cli/cli-server` unchanged. Routes import from this file
 * directly to avoid reintroducing the cycle.
 *
 * Side effects: `setCLISpaceContextState` mutates `process.env.TABTIN_*_ID`
 * to mirror the active Space context; downstream surface runtime
 * reconfiguration is the caller's responsibility (see `setCLISpaceContext`
 * in `cli-server.ts`).
 */

// ── Action executor (FrontendActionBridge IPC) ────────────────────────────

export type ActionExecutor = (action: any) => Promise<any>

let actionExecutor: ActionExecutor | null = null

export function setCLIActionExecutor(executor: ActionExecutor): void {
  actionExecutor = executor
}

export function getCLIActionExecutor(): ActionExecutor | null {
  return actionExecutor
}

// ── BrowserView lookup by tab id ──────────────────────────────────────────

type ViewGetter = (tabId: string) => any

let viewGetter: ViewGetter | null = null

export function setCLIViewGetter(getter: ViewGetter): void {
  viewGetter = getter
}

export function getCLIViewGetter(): ViewGetter | null {
  return viewGetter
}

// ── Desktop executor + guard ──────────────────────────────────────────────
//
// IMPORTANT: this leaf module cannot `import` (even `import type`) from
// `services/DesktopExecutorService` or `services/DesktopUseGuard`. madge
// tracks `import type` edges, and `services/DesktopUseGuard` transitively
// reaches `services/notification/presenter` → `cli/cli-server`, which would
// reintroduce a `cli-server` ↔ `cli-context` cycle.
//
// So:
//   - `desktopExecutor` is stored as `unknown` and exposed via a generic
//     getter; route handlers (`routes/desktop.ts`) supply the real type
//     parameter. They already import `services/DesktopExecutorService` for
//     `BatchAction`, so passing the class type adds no new dep edge.
//   - `desktopGuard` is stored against an inline `DesktopGuardContract`
//     that covers the 3 methods route handlers actually call. The
//     production callsite (`deferred-init-action-bridge.ts`) hands in the
//     real `DesktopUseGuard` module namespace; TS structural typing checks
//     it against this contract. If route handlers ever start using more
//     guard methods, extend this interface.

let desktopExecutor: unknown = null

export function setCLIDesktopExecutor(executor: unknown): void {
  desktopExecutor = executor
}

export function getCLIDesktopExecutor<T = unknown>(): T | null {
  return (desktopExecutor as T) ?? null
}

/**
 * Minimal contract for the DesktopUseGuard surface that CLI route handlers
 * exercise. Real implementation lives in `services/DesktopUseGuard.ts`;
 * structural typing keeps the two in sync without forcing a hard import
 * here (which would create a circular dep through `services/notification`).
 */
export interface DesktopGuardContract {
  acquire(
    sessionId: string,
  ): Promise<
    | { readonly ok: true; readonly abortSignal: AbortSignal }
    | { readonly ok: false; readonly reason: string }
  >
  release(sessionId: string): Promise<void>
  revokeDesktopApproval(): void
}

let desktopGuard: DesktopGuardContract | null = null

export function setCLIDesktopGuard(guard: DesktopGuardContract): void {
  desktopGuard = guard
}

export function getCLIDesktopGuard(): DesktopGuardContract | null {
  return desktopGuard
}

// ── Context-Space bridge (renderer-process IPC) ───────────────────────────

type ContextSpaceBridgeInvoker = (action: string, payload: any, timeoutMs?: number) => Promise<any>

let contextSpaceBridgeInvoker: ContextSpaceBridgeInvoker | null = null

export function setCLIContextSpaceBridge(invoker: ContextSpaceBridgeInvoker): void {
  contextSpaceBridgeInvoker = invoker
}

export function getCLIContextSpaceBridge(): ContextSpaceBridgeInvoker | null {
  return contextSpaceBridgeInvoker
}

// ── Space / Crawlspace / Organization context ────────────────────────────────

let currentSpaceId: string | null = null
let currentCrawlspaceId: string | null = null
let currentOrganizationId: string | null = null
let currentOrganizationRoot: string | null = null
/**
 * 无 thread 的 legacy 显式 scope。
 * Agent query 禁止写入；人手 CLI 未带 thread 时通常交给 renderer 当前前台 fallback。
 */
let currentWorkspaceScopeKey: string | null = null
type WorkspaceScopeRegistration = {
  owner: symbol
  scopeKey: string
}
/**  / ：同一 thread 可有多个重叠 query，栈顶登记是当前 owner。 */
const workspaceScopeRegistrationsByThreadId = new Map<string, WorkspaceScopeRegistration[]>()

export type CLIWorkspaceScopeLease = {
  release: () => void
}

type CLIWorkspaceScopeTurn = {
  runId: string
  lease: CLIWorkspaceScopeLease
}

export type CLIWorkspaceScopeTurnInput = {
  runId: string
  sessionId: string
  threadIds: readonly (string | null | undefined)[]
  scopeKey: string | null | undefined
}

/**
 * Update raw CLI Space context state and synchronize the related TABTIN_*_ID
 * env vars. No other side effects — `cli-server.ts` wraps this in
 * `setCLISpaceContext()` to additionally re-configure surface runtime + log.
 */
export function setCLISpaceContextState(
  spaceId: string | null,
  crawlspaceId?: string | null,
  organizationId?: string | null,
  organizationRoot?: string | null,
): void {
  currentSpaceId = spaceId
  currentCrawlspaceId = crawlspaceId ?? null
  currentOrganizationId = organizationId ?? null
  currentOrganizationRoot = organizationRoot ?? null

  if (spaceId) {
    process.env.TABTIN_SPACE_ID = spaceId
  } else {
    delete process.env.TABTIN_SPACE_ID
  }

  if (crawlspaceId) {
    process.env.TABTIN_CRAWLSPACE_ID = crawlspaceId
  } else {
    delete process.env.TABTIN_CRAWLSPACE_ID
  }

  if (organizationId) {
    process.env.TABTIN_ORGANIZATION_ID = organizationId
  } else {
    delete process.env.TABTIN_ORGANIZATION_ID
  }
}

export function getCLISpaceId(): string | null {
  return currentSpaceId
}

/**
 * 根因修复：把"chat IPC payload 里的 Space / Organization 真相"反向同步到 CLI
 * 全局单例，避免 `space:set-active` 异步链路失同步时下游所有 `getCLISpaceId()`
 * 取值点（getOrCreateRuntime cache key、createRuntimeForSession sessionDir、
 * ToolLogWriter 路径、agent reconfigure 等）都拿到陈旧值，session 静默落
 * `_unscoped/` 且 ShellCap 撞硬契约 throw。
 *
 * 与 `setCLISpaceContextState` 的差异：
 *   - 本函数**只 patch spaceId / organizationId**，不动 crawlspaceId / organizationRoot
 *     —— 这两个字段由 `space:set-active` 链路单独维护（crawlspaceId 从
 *     useCrawlTabStore 解出，organizationRoot 由主进程 workspaceRoot resolver
 *     算出），chat IPC payload 不带它们；若用 setCLISpaceContextState 的 4 参
 *     版本会把这两个字段 silently 清空。
 *   - 幂等：传入的值与当前单例相等时不做任何事（含 process.env 副作用）。
 *
 * 调用点：`ElectronAgentHost.handleQueryInternal` 在解析出 effective
 * spaceId / organizationId 之后立即调一次；其它入口不应该调（避免把 chat
 * 路径的副作用泄漏到非 chat 上下文）。
 */
export function syncCLISpaceContextFromQueryRequest(
  spaceId: string | undefined,
  organizationId: string | undefined,
): void {
  let mutated = false
  if (spaceId && spaceId.length > 0 && spaceId !== currentSpaceId) {
    currentSpaceId = spaceId
    process.env.TABTIN_SPACE_ID = spaceId
    mutated = true
  }
  if (organizationId && organizationId.length > 0 && organizationId !== currentOrganizationId) {
    currentOrganizationId = organizationId
    process.env.TABTIN_ORGANIZATION_ID = organizationId
    mutated = true
  }
  if (mutated) {
    // 不调 console.log（生产路径每条消息都会经过这里，避免日志噪声）；
    // 真正需要观测的是「全局单例与 IPC payload 不一致」这种异常状态，
    // 由 `spacePaths.warnIfSessionUnscoped` 在缺 spaceId 时打点（ 不再落盘 _unscoped）。
  }
}

export function getCLICrawlspaceId(): string | null {
  return currentCrawlspaceId
}

export function getCLIOrganizationId(): string | null {
  return currentOrganizationId
}

export function getCLIOrganizationRoot(): string | null {
  return currentOrganizationRoot
}

/**
 * 写入无 thread 的 legacy 显式 scope。Agent query 必须使用 lease API。
 */
export function setCLIWorkspaceScopeKey(scopeKey: string | null | undefined): void {
  currentWorkspaceScopeKey = scopeKey && scopeKey.length > 0 ? scopeKey : null
}

/**
 *  / ：为一轮 Agent query 原子登记 business/runtime thread 双键。
 * 每个调用生成独立 owner token；release 只移除自己的登记，避免重叠 query ABA 清理。
 */
export function acquireCLIWorkspaceScopeLease(
  threadIds: readonly (string | null | undefined)[],
  scopeKey: string | null | undefined,
): CLIWorkspaceScopeLease {
  const normalizedScope = typeof scopeKey === 'string' ? scopeKey.trim() : ''
  const normalizedThreads = [...new Set(
    threadIds
      .map((threadId) => (typeof threadId === 'string' ? threadId.trim() : ''))
      .filter(Boolean),
  )]
  const owner = Symbol('cli-workspace-scope-lease')
  if (normalizedScope) {
    for (const threadId of normalizedThreads) {
      const registrations = workspaceScopeRegistrationsByThreadId.get(threadId) ?? []
      registrations.push({ owner, scopeKey: normalizedScope })
      workspaceScopeRegistrationsByThreadId.set(threadId, registrations)
    }
  }

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      for (const threadId of normalizedThreads) {
        const registrations = workspaceScopeRegistrationsByThreadId.get(threadId)
        if (!registrations) continue
        const remaining = registrations.filter((registration) => registration.owner !== owner)
        if (remaining.length > 0) {
          workspaceScopeRegistrationsByThreadId.set(threadId, remaining)
        } else {
          workspaceScopeRegistrationsByThreadId.delete(threadId)
        }
      }
    },
  }
}

/**
 * ：把 scope lease 绑定到队列实际执行轮次，而不是 query 提交顺序。
 *
 * 调用方只可在轮次开始执行后调用 `start`。
 *  busy≈streaming：须在 streaming 逻辑终态、Host 队列接力下一轮之前
 * 调用 `settle`（`onTurnStreamingDone`）；`onTurnFinally` 里再 settle 仅作幂等兜底。
 * 排队中或被取消的 query 不调用 `start`，因此不会抢占当前轮次。
 */
export class CLIWorkspaceScopeTurnLeaseManager {
  private readonly activeBySessionId = new Map<string, CLIWorkspaceScopeTurn>()

  start(input: CLIWorkspaceScopeTurnInput): void {
    const sessionId = input.sessionId.trim()
    if (!sessionId) return

    const active = this.activeBySessionId.get(sessionId)
    if (active?.runId === input.runId) return
    if (active) {
      throw new Error(
        `CLI workspace scope turn overlap: session=${sessionId} active=${active.runId} next=${input.runId}`,
      )
    }

    this.activeBySessionId.set(sessionId, {
      runId: input.runId,
      lease: acquireCLIWorkspaceScopeLease(input.threadIds, input.scopeKey),
    })
  }

  settle(sessionId: string | null | undefined, runId: string): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!normalizedSessionId) return

    const active = this.activeBySessionId.get(normalizedSessionId)
    if (!active || active.runId !== runId) return
    this.activeBySessionId.delete(normalizedSessionId)
    active.lease.release()
  }
}

/**
 * 读取 workspace scope。
 * - 传入 threadId：只返回该 thread 当前 owner 的登记值；未登记则 null。
 * - 未传 threadId：只返回 legacy 显式值，绝不读取 Agent lease。
 */
export function getCLIWorkspaceScopeKey(threadId?: string | null): string | null {
  const normalizedThread = typeof threadId === 'string' ? threadId.trim() : ''
  if (normalizedThread) {
    const registrations = workspaceScopeRegistrationsByThreadId.get(normalizedThread)
    return registrations?.[registrations.length - 1]?.scopeKey ?? null
  }
  return currentWorkspaceScopeKey
}

/** 子 Agent storage thread（`agent-{childId}`）前缀。 */
export const SUBAGENT_THREAD_PREFIX = 'agent-'

export function buildSubagentThreadId(childId: string): string {
  return `${SUBAGENT_THREAD_PREFIX}${childId}`
}

function expandThreadIdVariants(threadIds: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of threadIds) {
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (!trimmed) continue
    out.add(trimmed)
    if (trimmed.startsWith('chat-session-')) {
      out.add(trimmed.slice('chat-session-'.length))
    } else {
      out.add(`chat-session-${trimmed}`)
    }
  }
  return [...out]
}

/**
 * 子 Agent 开 tab 时解析父会话 workspace scope。
 * 优先读父 thread 当前 lease；无登记时回落 `conversation:{id}` 快照。
 */
export function resolveSubagentParentWorkspaceScope(
  parentScopeThreadIds: readonly string[],
): string {
  for (const candidate of expandThreadIdVariants(parentScopeThreadIds)) {
    const scoped = getCLIWorkspaceScopeKey(candidate)
    if (scoped) return scoped
  }
  for (const candidate of expandThreadIdVariants(parentScopeThreadIds)) {
    const conversationId = candidate.replace(/^chat-session-/, '')
    if (conversationId) return `conversation:${conversationId}`
  }
  const fallback = parentScopeThreadIds.find((id) => typeof id === 'string' && id.trim())?.trim()
  return fallback ? `conversation:${fallback.replace(/^chat-session-/, '')}` : 'conversation:unknown'
}

/**
 * ：子 Agent run 期间为 `agent-{childId}` 及父 thread 变体登记 scope lease，
 * 避免 CLI open_tab 回退到前台 scope 串台。
 */
export function acquireSubagentCLIWorkspaceScopeLease(
  childId: string,
  parentScopeThreadIds: readonly string[],
): CLIWorkspaceScopeLease {
  const childThreadId = buildSubagentThreadId(childId)
  const scopeKey = resolveSubagentParentWorkspaceScope(parentScopeThreadIds)
  return acquireCLIWorkspaceScopeLease(
    [childThreadId, ...expandThreadIdVariants(parentScopeThreadIds)],
    scopeKey,
  )
}

// ── Agent worktree controller  ────────────────────────────────────

export type CLICodeWorktreeController = import('@tabtin/cli-routes').CodeWorktreeController

let cliCodeWorktreeController: CLICodeWorktreeController | null = null

export function setCLICodeWorktreeController(
  controller: CLICodeWorktreeController | null,
): void {
  cliCodeWorktreeController = controller
}

export function getCLICodeWorktreeController(): CLICodeWorktreeController | null {
  return cliCodeWorktreeController
}

/**
 * Chat 路径专用的 organizationRoot 兜底写入。
 *
 * 背景：`syncCLISpaceContextFromQueryRequest`（chat IPC payload 同步入口）
 * 刻意不动 organizationRoot——后者本应由 `space:set-active` 链路单独维护。
 * 但 `space:set-active` 的 Promise 在 `app-shell-init.ts` 被 silent catch
 * （切 Organization race / 某些 Space 切换失败 / 启动期 4 次翻转的中间态），
 * 一旦失败 `currentOrganizationRoot` 保持初始 null。这时 archive 路径仍能落
 * 到正确的 `{wt}/spaces/{sp}/` 目录（不依赖 organizationRoot），但
 * `ElectronAgentHost` 装 `runtimeIdentity` 的三元门闩
 * `(spaceId && organizationId && workspaceRoot)` 会因 workspaceRoot 缺失整组失败，
 * `buildSystemPrompt` 跳过 `<environment>` / `<shell_runtime>` / `<platform_data>`
 * 三段——LLM 不知道 archive 在哪，也不知道工作目录是什么。
 *
 * 修复纪律：
 *   - **只在 currentOrganizationRoot 为 null/空 时写入**——避免覆盖
 *     `space:set-active` 写入的权威值；`space:set-active` 一旦真的成功，
 *     它的 fallback 路径解析就是这条 chat 兜底用的同款算法
 *     （见 `packages/cli-server-core/src/surfaces/space-set-active.ts:91-107`），
 *     两条路径计算结果一致，不会出现"chat 兜底 vs space:set-active"打架。
 *   - **不动** spaceId / organizationId / crawlspaceId / process.env.TABTIN_*——
 *     那些字段在 chat 路径已被 sync 处理，本函数单一职责只补 organizationRoot。
 *   - 计算 fallback 路径的责任在调用方（leaf module 不依赖 terminal-core）。
 *     调用方应传入与 `space:set-active` 等价的 fallback 路径
 *     `resolveSpaceWorkspaceRoot(resolveSpacesRoot(), organizationId, spaceId)`。
 *
 * 调用点：`ElectronAgentHost.handleQueryInternal` 在 sync 之后立即调用一次。
 */
export function setCLIOrganizationRootIfMissing(organizationRoot: string): void {
  if (currentOrganizationRoot != null && currentOrganizationRoot.length > 0) return
  if (!organizationRoot || organizationRoot.length === 0) return
  currentOrganizationRoot = organizationRoot
}

// ── Skills materializer  ────────────────────────────────────────────

/**
 * Wave 1：CLI `skill install/enable` 成功后物化 marketplace app skill。
 * 由 LocalAgentHost 启动后注入 `electronAgentHost.materializeAppSkill`。
 */
export type CLISkillsMaterializer = (params: {
  organizationId: string
  /** @deprecated  本地落盘不再按 space */
  spaceId?: string
  userId?: string
  appId: string
  slug: string
}) => Promise<{ installed: number; skipped: number; errors: string[] }>

let cliSkillsMaterializer: CLISkillsMaterializer | null = null

export function setCLISkillsMaterializer(
  materializer: CLISkillsMaterializer | null,
): void {
  cliSkillsMaterializer = materializer
}

export function getCLISkillsMaterializer(): CLISkillsMaterializer | null {
  return cliSkillsMaterializer
}

/**  / ：npm 装完后把 ~/.agents/skills 挂进 LocalSkillRegistry。 */
export type CLISkillsInteropAdder = (rootPath: string) => Promise<void>

let cliSkillsInteropAdder: CLISkillsInteropAdder | null = null

export function setCLISkillsInteropAdder(
  adder: CLISkillsInteropAdder | null,
): void {
  cliSkillsInteropAdder = adder
}

export function getCLISkillsInteropAdder(): CLISkillsInteropAdder | null {
  return cliSkillsInteropAdder
}
