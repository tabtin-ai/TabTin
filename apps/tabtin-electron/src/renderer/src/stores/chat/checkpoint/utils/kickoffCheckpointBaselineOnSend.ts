import * as checkpointIpc from '../../../../services/checkpointIpc'
import type { CheckpointPendingContext } from '../handlers/checkpointAnchor'

type KickoffLogger = {
  info?: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

/**
 * 启动 checkpoint baseline（init + write-tree），与消息流并行。
 * 同步写入 pending context，供 lifecycle.end 消费（避免 closure race）。
 *
 * ：即便 checkpoint bridge 暂不可用，也写入 degraded pending（baseline=undefined），
 * 让 lifecycle.end 继续尝试 createCheckpoint 并留下可归因日志，禁止静默跳过。
 */
export function kickoffCheckpointBaselineOnSend(params: {
  sessionId: string
  spaceId: string | undefined
  userLocalMessageId: string
  userClientMessageId: string
  /** 必须解析「本会话」执行根，避免 worktree 场景误落全局 Space 根。 */
  resolveSpacePath: (sessionId?: string | null) => Promise<string | null | undefined>
  setCheckpointPendingContext: (
    sessionId: string,
    ctx: CheckpointPendingContext,
  ) => void
  log: KickoffLogger
}): void {
  const sessionPrefix = params.sessionId.slice(0, 8)
  const bridgeAvailable = checkpointIpc.isAvailable()

  if (!bridgeAvailable) {
    params.log.warn('Checkpoint baseline kickoff: bridge unavailable, writing degraded pending', {
      sessionId: sessionPrefix,
      hasTabtin: typeof window !== 'undefined' && !!window.tabtin,
      hasCheckpointApi: typeof window !== 'undefined' && !!window.tabtin?.checkpoint,
    })
  }

  const baselineHashPromise = bridgeAvailable
    ? (async () => {
        const pp = await params.resolveSpacePath(params.sessionId)
        if (!pp) {
          params.log.warn('Checkpoint baseline skipped: no space path', {
            sessionId: sessionPrefix,
          })
          return undefined
        }
        try {
          await checkpointIpc.init(pp)
        } catch (err) {
          params.log.warn('Checkpoint repo init failed:', err, { sessionId: sessionPrefix, path: pp })
        }
        try {
          const { treeHash } = await checkpointIpc.writeTree(pp)
          params.log.info?.('Checkpoint baseline writeTree ok', {
            sessionId: sessionPrefix,
            path: pp,
            treeHash: treeHash?.slice(0, 8),
          })
          return treeHash
        } catch (err) {
          params.log.warn('Checkpoint baseline writeTree failed:', err, {
            sessionId: sessionPrefix,
            path: pp,
          })
          return undefined
        }
      })()
    : Promise.resolve(undefined)

  params.setCheckpointPendingContext(params.sessionId, {
    spaceId: params.spaceId,
    baselineHashPromise,
    userLocalMessageId: params.userLocalMessageId,
    userClientMessageId: params.userClientMessageId,
  })

  params.log.info?.('Checkpoint pending context enqueued', {
    sessionId: sessionPrefix,
    bridgeAvailable,
    userClientMessageId: params.userClientMessageId.slice(0, 8),
  })
}
