/**
 * NotificationIdleDrain —— 收拢双端 Host 的 push 通知 idle drain 逻辑。
 *
 * 双端原本各自维护同款私有方法 `scheduleDrain` / `_tryDrain` /
 * `drainThreadNotificationsText`（详见 PRD `run-terminal-command_push通知
 * 重构_2026-05-23.md` §6.3 与两端同名 JSDoc）。它们共享的规则：
 *   1. 三道 race 防御：busy 短路 → peek 短路 → 提交失败退回；
 *   2. session 不在 map = LLM 上下文丢失 → log.error **不退回**（防饿死）；
 *   3. drain 出来的 envelope 用 `composeNotificationPrompt` 合成文本；
 *   4. target.threadId 与 `sessions` Map key 必须同源。
 *
 * 本 helper 把规则集中在一处；平台注入 queue 句柄、composePrompt、runTurn、
 * isBusy、hasSession，就完成一端接线。行为与双端旧实现逐字节对齐。
 */

import {
  composeNotificationPrompt,
  type NotificationEnvelope,
  type NotificationQueue,
} from '@tabtin/terminal-core'

export interface NotificationIdleDrainLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface NotificationDrainContext {
  threadId: string
  items: NotificationEnvelope[]
  /** 已经按 `composeNotificationPrompt` 合成好的 prompt 文本（非空）。 */
  promptText: string
}

export interface NotificationDrainTextOptions {
  /**
   * 子 Agent 的通知按 subagent run_id 入队；run_id 不是 host.sessions 的业务
   * thread key，因此只能由正在运行/续跑的子 runtime 主动 in-turn drain。
   */
  allowMissingSession?: boolean
}

export interface NotificationIdleDrainDeps {
  /** 定位当前 `NotificationQueue`。返回 undefined 视作 queue 不可用（log 后 skip）。 */
  getQueue(): NotificationQueue | undefined
  /** 该 thread 是否已有正在跑的 query。true 时 skip drain。 */
  isBusy(threadId: string): boolean
  /** 该 thread 在 `sessions` Map 是否仍存在。false 时按 §17.5 修复 2 丢消息。 */
  hasSession(threadId: string): boolean
  /**
   * 由平台起新一轮 turn。收到已合成的文本 + 原 items（用于按 target 回填 session 字段）
   * ；平台内部完成 `QueryRequest` 构造与 `submitQuery`。
   *
   * 返回 `{ success: false, error }` 且 error 匹配 `already has a running query`
   * 时，drain helper 把 items 退回 queue（瞬态 race 防御 3）。
   */
  runTurn(context: NotificationDrainContext): Promise<{ success: boolean; error?: string }>
  logger: NotificationIdleDrainLogger
  /** 日志前缀（区分 host，例：`Electron` / `Daemon`）。可选。 */
  logPrefix?: string
}

export class NotificationIdleDrain {
  constructor(private readonly deps: NotificationIdleDrainDeps) {}

  /**
   * 排一个 microtask 异步 drain。同步路径上先让 `isBusy` add 完成，避免 user
   * query 跟 push drain 同 tick 撞车（三道 race 防御的第 1 道，详见双端旧
   * JSDoc §17.5/§17.6）。
   */
  schedule(threadId: string): void {
    queueMicrotask(() => {
      void this.tryDrain(threadId)
    })
  }

  /**
   * idle 时另起 push turn 的实际实现。
   *
   * 契约 = 两端旧 `_tryDrain` 逐字节对齐（含日志文案 / error 级别）：
   *   - session 不存在（稳态丢失）→ log.error + drop（不退回）；
   *   - "already has a running query"（瞬态 busy race）→ log.info + requeue。
   */
  async tryDrain(threadId: string): Promise<void> {
    if (this.deps.isBusy(threadId)) return

    const queue = this.resolveQueue(threadId, 'drain')
    if (!queue) return

    if (queue.peekByThreadId(threadId) === 0) return

    const items = queue.drainByThreadId(threadId)
    if (items.length === 0) return

    const promptText = composeNotificationPrompt(items, {
      onUnknownKind: (kinds, count) => {
        this.deps.logger.error(
          `${this.prefix()}[NotificationQueue] dropped ${count} notification(s) with unknown kind(s): ${kinds.join(', ')}`,
        )
      },
    })
    if (promptText.length === 0) return

    if (!this.deps.hasSession(threadId)) {
      // §17.5 修复方案 2 双端对称：session 不在 map = LLM 上下文已丢失，
      // **不退回**（退回会触发 subscribe → schedule → tryDrain 死循环，饿死
      // IPC handler）。文案与错误级别（error，不是 warn）跟双端旧实现严格一致。
      this.deps.logger.error(
        `${this.prefix()}[NotificationQueue] thread ${shortId(threadId)} not found, `
          + `dropping ${items.length} push notification(s). `
          + `This indicates a thread id mismatch or session lifecycle bug — `
          + `the message is NOT requeued to prevent microtask starvation loop.`,
      )
      return
    }

    let result: { success: boolean; error?: string }
    try {
      result = await this.deps.runTurn({ threadId, items, promptText })
    } catch (err) {
      // 平台 submitQuery 内部应该返 { success: false, error } 而非 throw；
      // 万一 throw 也兜底退回 queue（与双端旧 catch 分支一致）。
      this.deps.logger.warn(
        `${this.prefix()}[NotificationQueue] drain runTurn threw: ${errMessage(err)}`,
      )
      for (const env of items) queue.enqueue(env)
      return
    }

    if (!result.success && /already has a running query/i.test(result.error ?? '')) {
      // §17.6.8 双轨策略：瞬态 busy race 可退回；跟 §17.5 稳态 session 不存在
      // 是两类不同 race，不要混淆——后者必须丢消息。
      this.deps.logger.info(
        `${this.prefix()}[NotificationQueue] drain race lost (thread busy), `
          + `requeuing ${items.length} notification(s) for thread ${shortId(threadId)}`,
      )
      for (const env of items) queue.enqueue(env)
    }
  }

  /**
   * 「turn 内注入」drain：当前 turn 还在跑时每轮 ReAct 迭代边界由 agent-runtime
   * 调用，拿出该 thread 已完成的通知拼成 injection 文本返回；不起新 query。
   *
   * 与 `tryDrain` **消费同一队列**，drain 同步出队 + 释放 dedup 让 `tryDrain`
   * 的 `peekByThreadId` 即 0，两条路互斥、零重复送达。
   *
   * session 缺失 / queue 不可用 / 无待 drain → 返回 null（no-op）。
   */
  drainText(threadId: string, options: NotificationDrainTextOptions = {}): string | null {
    const queue = this.resolveQueue(threadId, 'in-turn drain')
    if (!queue) return null

    if (queue.peekByThreadId(threadId) === 0) return null

    // session 不在 map = 不该注入。**不退回**（避免饿死），也不像 tryDrain 那样
    // log.error——in-turn 是 runtime 主动 peek，没就返 null 不奇怪。与双端旧
    // `drainThreadNotificationsText` 同款守门。
    if (!options.allowMissingSession && !this.deps.hasSession(threadId)) return null

    const items = queue.drainByThreadId(threadId)
    if (items.length === 0) return null

    const promptText = composeNotificationPrompt(items, {
      onUnknownKind: (kinds, count) => {
        this.deps.logger.error(
          `${this.prefix()}[NotificationQueue] (in-turn) dropped ${count} notification(s) with unknown kind(s): ${kinds.join(', ')}`,
        )
      },
    })
    if (promptText.length === 0) return null
    return promptText
  }

  private resolveQueue(
    threadId: string,
    phase: 'drain' | 'in-turn drain',
  ): NotificationQueue | undefined {
    // ：null-safe 解析——不同 host resolve 路径不同，此处只按 getQueue 契约
    // 兜底：抛错 → log.error；返 undefined → log.warn；两者都短路。
    try {
      const queue = this.deps.getQueue()
      if (!queue) {
        this.deps.logger.warn(
          `${this.prefix()}[NotificationQueue] ${phase} aborted: queue unavailable (thread=${threadId})`,
        )
        return undefined
      }
      return queue
    } catch (err) {
      this.deps.logger.error(
        `${this.prefix()}[NotificationQueue] ${phase} aborted: getQueue threw (thread=${threadId}): ${errMessage(err)}`,
      )
      return undefined
    }
  }

  private prefix(): string {
    return this.deps.logPrefix ? `[${this.deps.logPrefix}] ` : ''
  }
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
