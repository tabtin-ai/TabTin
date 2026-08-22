/**
 * observerSeqGap — WS 观察流 seq 缺口的**补拉执行侧**（：检测已收口主进程）。
 *
 * 背景：per-thread `_seq` 缺口检测（跳号 / 中途接入）需要纯 WS 序列单调可判——IPC 与
 * WS 两路 `_seq` 交错必然误报。来源区分下沉主进程后，检测在主进程
 * `ConversationStreamAggregator`（只吃纯 WS 观察流）完成，命中缺口即经 `agent-engine:
 * stream-event` 发一帧 `{ control: 'seq-gap' }`。渲染进程只保留本模块——收到控制帧后
 * 安排一次「从服务端补拉」，并沿用既有 busy-defer 与终态兜底。
 *
 * 补拉动作：`scheduleSeqGapSync`（2s debounce）→ `syncSessionMessagesFromServer`。
 * run 进行中（busy）不立即触发全量 sync——避免审批 / 长流期间叠加 merge + HITL 对账
 * 占满主线程（ Intel 审批卡死）；此时由 lifecycle 终态的
 * `scheduleTerminalMessageReconcile` 兜底对账。消息合并（mergeMessagesFromServer）
 * 幂等，streaming 中补拉不覆盖本地 in-flight 临时消息。
 */

import { scheduleSeqGapSync } from './seqTracker'
import { createLogger } from '@/utils/logger'
import { useChatStore } from '@stores/chat/useChatStore'
import { isSessionBusy } from '../../execution/sessionRunProjection'

const log = createLogger('ObserverSeqGap')

/**
 * 处理主进程发来的 `seq-gap` 控制帧：安排一次服务端补拉。
 *
 * busy（本地/远端 run 进行中）时 defer——不叠加全量 sync，交给 lifecycle 终态 reconcile。
 */
export function handleSeqGapControl(sessionId: string): void {
  if (isSessionBusy(sessionId)) {
    log.debug('seq gap deferred until terminal (session streaming)', {
      session: sessionId.slice(0, 8),
    })
    return
  }
  log.warn('seq gap (main-detected) → schedule catch-up sync', {
    session: sessionId.slice(0, 8),
  })
  scheduleSeqGapSync(sessionId, () => {
    void useChatStore.getState().syncSessionMessagesFromServer(sessionId)
  })
}
