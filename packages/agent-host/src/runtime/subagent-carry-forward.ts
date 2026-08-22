/**
 * subagent-carry-forward.ts — runtime 硬重建时 SubagentManager / BudgetTracker
 * 的复用决策 SSoT，抽自两端 host `createRuntimeForSession` 原本 inline 的复读
 * 代码（Electron `ElectronAgentHost.createRuntimeForSession` L7867–L7962 /
 * Daemon `DaemonAgentHost.createRuntimeForSession` L5343–L5429）。
 *
 * 契约锁死（W4a S3③ PR2 review P1 修复的产物）：
 *
 * 1. **BudgetTracker 复用是「条件式」**：仅当旧 Manager 未 dispose 且**仍有
 *    后台子在跑**（`hasBackgroundRuns()`）或**父 run 已提交后台等待屏障**
 *    （`hasCompletionBarriers()`）才复用其 `budgetTracker`——避免真实并发击穿
 *    maxActive，也避免 runtime 重建期间把等待屏障和旧预算账本拆开；无后台子且无
 *    等待屏障时新建，让新 runtime 从 0 起算。
 *
 * 2. **SubagentManager 复用是「无条件式」**（旧 Manager 未 dispose）——不复用
 *    会把仍在跑的后台子误 abort。
 *
 * 3. **existing = carryForward ?? liveSession**：factory 硬重建路径下
 *    `host.sessions` 已在 build 前被摘除，必须优先取 factory 通过 carryForward
 *    透传下来的旧 Manager；未走 factory 的兜底路径（soft-reconfigure /
 *    handleQueryFromForward 等）继续用 `host.sessions.get()` 查询。
 *
 * 4. **spaceId 解析优先级**（`resolveSubagentCompletionSpaceId`）：
 *    liveSpaceId → liveManagerSpaceId → assemblySpaceId → cliSpaceIdFallback。
 *    先 live 后快照，避免 Space 切换硬重建后完成通知带错 spaceId；Daemon 无
 *    CLI 上下文，`cliSpaceIdFallback` 传 null。
 *
 * 参考：
 *   - `packages/agent-runtime/src/session/subagent-manager.ts`（SubagentManager
 *     真实实现，提供 `isDisposed` / `hasBackgroundRuns()` /
 *     `hasCompletionBarriers()` / `getLiveDeps()`）
 */

import type { BudgetTracker } from '@tabtin/agent-runtime'

/**
 * Manager 面向 host 侧复用决策所需的最小接口——与 `SubagentManager` 结构类型
 * 兼容，但只暴露决策用到的三个成员，让测试 / 未来替换实现零成本。
 */
export interface SubagentManagerLike {
  readonly isDisposed: boolean
  hasBackgroundRuns(): boolean
  hasCompletionBarriers?(): boolean
  getLiveDeps(): { budgetTracker?: BudgetTracker } | undefined
}

/**
 * spaceId 解析入参。所有字段都是可选的：调用方按自身可拿到的口径填。
 *
 * - `liveSpaceId`：`host.sessions.get(sessionId)?.spaceId`——runtime 重建时会
 *   随之更新，是最新真值。
 * - `liveManagerSpaceId`：`host.sessions.get(sessionId)?.subagentManager?.spaceId`
 *   ——Manager 构造期 readonly 快照，carry-forward 复用时不随 runtime 重建
 *   更新；`liveSpaceId` 缺失时次选。
 * - `assemblySpaceId`：`createRuntimeForSession` 装配期从 `getCLISpaceId()` /
 *   `spaceId` 参数拿到的快照，兜底位。
 * - `cliSpaceIdFallback`：仅 Electron 有的 CLI 上下文回落；Daemon 传 null 显式
 *   表达"我没有这个来源"。
 */
export interface ResolveSubagentCompletionSpaceIdInput {
  liveSpaceId?: string
  liveManagerSpaceId?: string
  assemblySpaceId?: string
  cliSpaceIdFallback?: string | null
}

/**
 * 按 host 语义决定投递 SubagentCompletion 时的 target `spaceId`。空串视作缺失
 * （与 `dst.sources.workingDir` 处的空字符串防御同源）；全部缺省时返 undefined，
 * 让调用方 warn 并 skip 入队。
 */
export function resolveSubagentCompletionSpaceId(
  args: ResolveSubagentCompletionSpaceIdInput,
): string | undefined {
  const pick = (value: string | undefined | null): string | undefined => {
    if (typeof value !== 'string') return undefined
    return value.length > 0 ? value : undefined
  }
  return (
    pick(args.liveSpaceId)
    ?? pick(args.liveManagerSpaceId)
    ?? pick(args.assemblySpaceId)
    ?? pick(args.cliSpaceIdFallback ?? undefined)
  )
}

/**
 * 调用方在 host 侧准备好的最小 SubagentManager 构造入参 shape。
 *
 * `enqueueNotification` 用宽松签名（`(...args: any[]) => boolean`）避开 host 层
 * 与 `SubagentCompletionInfo` 的循环依赖——真实 host 传的是
 * `EnqueueSubagentCompletion`，这里仅在类型层放行。
 */
export interface CreateSubagentManagerLikeInput {
  parentThreadId: string
  spaceId?: string
  budgetTracker: BudgetTracker
  /** host 注入的 completion 投递句柄。 */
  enqueueNotification: (...args: unknown[]) => boolean
}

export interface CreateBudgetTrackerInput {
  maxConcurrentChildren: number
  maxQueueSize: number
}

export interface ResolveSubagentCarryForwardInput {
  /** factory 通过 `context.carryForward.subagentManager` 显式透传的旧 Manager。 */
  carryForwardSubagentManager?: SubagentManagerLike
  /** 未走 factory 路径时的兜底：`host.sessions.get(sessionId)?.subagentManager`。 */
  liveSessionManager?: SubagentManagerLike
  maxConcurrentChildren: number
  maxQueueSize: number
  createBudgetTracker: (opts: CreateBudgetTrackerInput) => BudgetTracker
  createSubagentManager: (
    opts: CreateSubagentManagerLikeInput,
  ) => SubagentManagerLike
  parentThreadId: string
  spaceId?: string
  enqueueNotification: (...args: unknown[]) => boolean
}

export interface ResolveSubagentCarryForwardResult {
  budgetTracker: BudgetTracker
  subagentManager: SubagentManagerLike
  /** true = 复用了旧 Manager；false = new。 */
  reusedManager: boolean
  /** true = 复用了旧 tracker；false = new。 */
  reusedBudgetTracker: boolean
}

/**
 * 决策规则（与两端 host 原 inline 代码等价）：
 *
 * ```txt
 * existing = carryForward ?? liveSession
 * budget  = existing 未 dispose 且 (hasBackgroundRuns() || hasCompletionBarriers())
 *             ? existing.getLiveDeps().budgetTracker      // 条件复用
 *             : createBudgetTracker(...)                  // 无后台子时新建
 * manager = existing 未 dispose
 *             ? existing                                  // 无条件复用
 *             : createSubagentManager(...)                // 已 dispose 才新建
 * ```
 *
 * 注意 `getLiveDeps()` 可能返回 undefined（Manager 尚未 `rebindLiveDeps`），
 * 或返回没有 budgetTracker 的对象——这两种情况都回落到新建 tracker。
 */
export function resolveSubagentCarryForward(
  input: ResolveSubagentCarryForwardInput,
): ResolveSubagentCarryForwardResult {
  const existing =
    input.carryForwardSubagentManager ?? input.liveSessionManager
  const managerAlive = !!existing && !existing.isDisposed
  const shouldKeepBudget =
    managerAlive
    && (existing!.hasBackgroundRuns() || (existing!.hasCompletionBarriers?.() ?? false))

  const carryTracker =
    shouldKeepBudget
      ? existing!.getLiveDeps()?.budgetTracker
      : undefined
  const budgetTracker =
    carryTracker
    ?? input.createBudgetTracker({
      maxConcurrentChildren: input.maxConcurrentChildren,
      maxQueueSize: input.maxQueueSize,
    })

  const subagentManager: SubagentManagerLike = managerAlive
    ? existing!
    : input.createSubagentManager({
        parentThreadId: input.parentThreadId,
        spaceId: input.spaceId,
        budgetTracker,
        enqueueNotification: input.enqueueNotification,
      })

  return {
    budgetTracker,
    subagentManager,
    reusedManager: managerAlive,
    reusedBudgetTracker: !!carryTracker,
  }
}
