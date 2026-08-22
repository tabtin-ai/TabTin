/**
 * useAgentTerminalSync
 *
 * 把 Agent 起的 PTY transcript session 同步到 renderer 侧隐藏索引。
 *
 * 两件事合并在同一个 useEffect 内，避免 IPC 事件在 zombie 清理异步窗口
 * 期到达时丢掉：
 *
 *   1. 监听 agent-session-created / agent-session-closed IPC 事件，把 session
 *      记录到隐藏 transcript registry。
 *   2. 启动 + 周期性清理 zombie Agent 会话（active 但 PTY 已不在、超 fresh 窗口，
 *      或 closed 超保留期）。**例外**：仍有可见 tab（itemsBySpace 里存在对应
 *      terminal item）的会话是用户特意点开回看快照的历史视图，豁免自动回收，
 *      像其它资源 tab 一样「手动关才关」，否则会「打开后过一会儿自动消失」。
 *
 *   - D3b：每次 Agent 命令独占一个 transcript session，但默认不占用
 *     Space 可见 tab；用户点击工具卡片打开时，才 materialize 成 terminal tab。
 *   - D5：`source: 'agent'` 仅作数据层标识 / 审计字段，**不驱动任何 UI
 *     差异**（Agent tab 与用户 tab 视觉一致）。
 *   - `agent-session-title` 事件已退役（agent-bridge.ts JSDoc L168-174）：
 *     每次新 session 后 title 在 created 时一次定死，不再需要事件更新；
 *     main 端 emit / preload 暴露 / 本 hook 订阅都不再消费。
 *
 * IPC 边界（agent-bridge.ts JSDoc L421-432）：
 *   - renderer 经 `window.tabtin?.pty.onAgentSessionCreated` 收到事件的
 *     时序受 IPC 延迟影响，可能晚于 ShellCap 命令本身 return 几 ms 到
 *     几十 ms。这是 Electron IPC 物理边界、不是 bug；本 hook 不尝试同步。
 *
 * 稳定性修复（保留）：
 *   - ER-6：useRef 间接调用稳定 callback，避免 IPC 重订阅时事件丢失窗口
 *   - ER-9：全局单点订阅 + 按 `info.spaceId` 路由（防止 N spaceId × 3
 *     channel 的 IPC subscribe 爆炸）
 */

import { useEffect, useRef, useCallback, useMemo } from 'react'
import { useAgentTerminalTranscriptStore, useTerminalSessionStore, deriveAgentTerminalSpaceId } from '@components/context-space/sources/terminal'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import i18n from '@/i18n'

const FRESH_WINDOW_MS = 10_000
const CLOSED_RETENTION_MS = 5 * 60 * 1000 // 5min — agent PTY closed 后无需长期保留

type LivePtySession = {
  id: string
  cwd: string
}

export function useAgentTerminalSync(): void {
  const selectedSpaceId = useSpaceStore((state) => state.selectedSpace?.id ?? null)
  const organizationSpaces = useSpaceStore((state) => state.spaces)
  const persistedSessionsBySpace = useTerminalSessionStore((state) => state.sessionsBySpace)

  // ER-9: 已知的 spaceId 集合仅用于事件 payload 校验（防止外部 spaceId 注入），
  // 不再用于按 spaceId 拆分订阅。订阅一次全局事件，hook 内按 info.spaceId 自己路由。
  // 修复前：N 个 spaceId × N channel = N² 次 IPC subscribe。
  // 修复后：固定 2 次（created / closed 各一次全局订阅）。
  const knownSpaceIds = useMemo(() => {
    const candidateIds = [
      ...organizationSpaces.map((space) => space.id),
      ...Object.keys(persistedSessionsBySpace),
      ...(selectedSpaceId ? [selectedSpaceId] : []),
    ]
    return new Set(candidateIds.filter((id): id is string => Boolean(id)))
  }, [persistedSessionsBySpace, selectedSpaceId, organizationSpaces])

  // ER-6: 使用 useRef 存储稳定的回调函数，避免 IPC 重订阅时事件丢失窗口。
  // 回调通过 ref 间接引用，IPC handler 始终调用最新的实现。
  //
  // payload 中 `description` / `command` 都是 optional：
  //   - description：LLM 调 run_terminal_command 时可能没显式传
  //   - command：bridge 路径必传，4 件套人控路径（PtyManager.spawnAgentSession）
  //     不传（无 LLM 命令上下文）
  // hook 内三级 fallback（L96-99）兜底两者全空的极端场景。
  const handleCreatedRef = useRef<(info: { sessionId: string; spaceId?: string; threadId: string | null; cwd: string; description?: string | null; command?: string | null }) => void>(() => {})
  const handleClosedRef = useRef<(info: { sessionId: string; spaceId?: string; reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout' }) => void>(() => {})

  // ER-9: 让 ref 跟随 knownSpaceIds 的变化，避免在 useEffect 重订阅；
  // 没订阅过的 spaceId 不应被路由（保持原有按 spaceId 隔离的语义）。
  const knownSpaceIdsRef = useRef<Set<string>>(knownSpaceIds)
  knownSpaceIdsRef.current = knownSpaceIds

  // D3b：每次 agent-session-created → 只登记隐藏 transcript，不自动打开 Space tab。
  // 不在已有 agent tab 内追加分屏 pane、不查找复用。多个并发 Agent session
  // 各自有独立 transcript；用户点击工具卡片时再 materialize 成可见 tab。
  //
  // Tab title 三级 fallback 链（agent-bridge.ts JSDoc 硬契约）：
  //   1. info.description?.trim()         — LLM 显式传时优先（语义最准）
  //   2. info.command 首行截断 60 chars   — bridge 路径必传，让 dogfood
  //      「连跑 3 条命令」能从 tab 标题分辨「ls /home」「pnpm test」
  //      「sleep 30」三个 tab 在跑啥（L-WP6-1 修复）
  //   3. `${i18n} · ${sessionId 后 6 位}` — 4 件套人控路径 emit 不带 command
  //      时的终极兜底
  //
  // 截断策略：取第一行 + trim + slice(0, 60)。dogfood 场景命令一般不超过 60；
  // 长命令（如 pnpm test --filter ...）截到 60 仍能保留命令名 + 关键参数前缀。
  // 60 不在 bridge 截，emit 出来是完整字符串，让审计 / 日志订阅者拿全文。
  handleCreatedRef.current = (info) => {
    const spaceId = info.spaceId
    if (!spaceId) return
    // ER-9: 全局订阅会收到所有 spaceId 事件，但只路由当前 hook 已知的 spaceId
    // —— 保持原"按 spaceId 隔离"语义。
    if (!knownSpaceIdsRef.current.has(spaceId)) return

    const baseLabel = i18n.t('label.agentTerminal', { ns: 'context' })
    const sessionSuffix = info.sessionId.slice(-6)
    // commandTitle 为 string | undefined：空串 / undefined / 纯空白 trim 后都 falsy → 走下一级
    const commandTitle = info.command?.split('\n')[0]?.trim().slice(0, 60)
    const title =
      info.description?.trim() ||
      commandTitle ||
      `${baseLabel} · ${sessionSuffix}`

    useAgentTerminalTranscriptStore.getState().upsertTranscript(
      spaceId,
      info.sessionId,
      title,
      info.cwd || undefined,
    )
  }

  handleClosedRef.current = (info) => {
    const spaceId = info.spaceId
    if (!spaceId) return
    if (!knownSpaceIdsRef.current.has(spaceId)) return
    useAgentTerminalTranscriptStore.getState().markTranscriptClosed(spaceId, info.sessionId)
    useTerminalSessionStore.getState().markSpaceSessionClosed(spaceId, info.sessionId)
  }

  // ER-6: 稳定的 IPC handler 代理——通过 ref 间接调用，避免因 knownSpaceIds 变化
  // 导致的取消/重订阅间隙丢失事件
  const stableHandleCreated = useCallback(
    (info: { sessionId: string; spaceId?: string; threadId: string | null; cwd: string; description?: string | null; command?: string | null }) =>
      handleCreatedRef.current(info),
    [],
  )
  const stableHandleClosed = useCallback(
    (info: { sessionId: string; spaceId?: string; reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout' }) =>
      handleClosedRef.current(info),
    [],
  )

  useEffect(() => {
    // ER-9: 始终用全局单点订阅。main 端 PtyEventRouter 的 getSubscriberIds
    // 会自动把全局订阅者合并到任何 scope 的事件 forward 列表，所以全局订阅
    // 本来就能收到所有 spaceId 的事件。事件 payload 自带 info.spaceId，
    // 路由由 handle*Ref 内的 knownSpaceIdsRef 校验完成。
    const pty = window.tabtin?.pty
    const unsubCreated = pty?.onAgentSessionCreated?.(stableHandleCreated)
    const unsubClosed = pty?.onAgentSessionClosed?.(stableHandleClosed)

    const syncFromMainProcess = async () => {
      if (!pty?.listWithStatus) return
      try {
        const { sessions: live = [] } = await pty.listWithStatus() as { sessions: LivePtySession[] }
        const liveIds = new Set(live.map(s => s.id))
        const cwdMap = new Map(live.map(s => [s.id, s.cwd]))
        const now = Date.now()
        const store = useTerminalSessionStore.getState()
        const all = store.sessionsBySpace

        // 用户显式打开的终端 tab 不参与「僵尸/保留」自动回收——它是特意点开来
        // 回看快照的历史命令视图，理应像其它资源 tab 一样「手动关才关」。
        // 依据 D3b：agent 会话默认只进隐藏 transcript，进 sessionsBySpace 的都是
        // 用户点过「查看终端」materialize 出来的；若还在 itemsBySpace 里有对应
        // tab，说明用户此刻正开着它，不能被 10s zombie-GC / 5min retention 清掉，
        // 否则「打开后过一会儿自动消失」。快照是静态渲染、不会重现「假运行」，
        // 总览侧的运行态另由 transcript 的 markTranscriptClosed 单独收敛。
        const openTerminalIds = new Set<string>()
        {
          const itemsBySpace = useSpaceContextTabsStore.getState().itemsBySpace
          for (const bucket of Object.values(itemsBySpace)) {
            for (const item of Object.values(bucket)) {
              if (item.type === 'terminal') openTerminalIds.add(item.id)
            }
          }
        }

        for (const [spaceId, sessions] of Object.entries(all)) {
          for (const s of sessions) {
            // 同步 cwd
            const liveCwd = cwdMap.get(s.id)
            if (liveCwd && liveCwd !== s.cwd) {
              store.updateSpaceSessionCwd(spaceId, s.id, liveCwd)
            }
            if (s.source !== 'agent') continue
            if (openTerminalIds.has(s.id)) continue
            if (s.status === 'closed') {
              if ((now - (s.closedAt ?? s.createdAt)) > CLOSED_RETENTION_MS) {
                store.removeSpaceSession(spaceId, s.id)
              }
            } else if (!liveIds.has(s.id) && (now - s.createdAt) > FRESH_WINDOW_MS) {
              store.removeSpaceSession(spaceId, s.id)
            }
          }
        }

        // B2 重载回填：内存态 transcriptsById 无 persist，重载后清空，但主进程
        // PtyManager 跨重载存活——一个 agent 起的 `pnpm dev` 仍活着却从总览消失，正是
        // PRD 要根治的「重载→看不见」换地方复发。这里遍历 live 会话，对 `agent-` 前缀
        // 且不在 transcriptsById 的，用 deriveAgentTerminalSpaceId 解析 spaceId 后回填。
        {
          const transcriptStore = useAgentTerminalTranscriptStore.getState()
          for (const s of live) {
            if (!s.id.startsWith('agent-')) continue
            if (transcriptStore.transcriptsById[s.id]) continue
            const derivedSpaceId = deriveAgentTerminalSpaceId(s.id)
            if (!derivedSpaceId) continue
            // P2 护栏：启发式正则反解可能 derive 出当前不认识的 spaceId（陈旧 sessionId /
            // 跨用户残留 / 正则误吃）。只回填已知 spaceId，避免冒出幻影「未知 Agent」
            // 分组（总览按 spaceMeta 找不到名字会退化成空 agentName 组）。
            if (!knownSpaceIdsRef.current.has(derivedSpaceId)) continue
            transcriptStore.upsertTranscript(derivedSpaceId, s.id, undefined, s.cwd || undefined)
          }
        }

        // 跨 Agent 终端总览防「假运行」：隐藏 agent transcript 的 PTY 已不在、
        // 且过了 fresh 窗口（排除刚创建还没进 PTY 列表的竞态），却仍标 active
        // ——说明 agent-session-closed 事件漏收（重载/IPC 抖动），主动标 closed，
        // 否则总览会一直显示「运行中」脉冲，与终端卡片同病。
        // 注意：回填刚 upsert 的会话都在 liveIds 里，不会被这里误标 closed。
        const transcriptStore = useAgentTerminalTranscriptStore.getState()
        for (const transcript of Object.values(transcriptStore.transcriptsById)) {
          if (transcript.status === 'closed') continue
          if (!transcript.spaceId) continue
          if (!liveIds.has(transcript.id) && (now - transcript.createdAt) > FRESH_WINDOW_MS) {
            transcriptStore.markTranscriptClosed(transcript.spaceId, transcript.id)
          }
        }
      } catch { /* pty API may not be ready yet */ }
    }
    syncFromMainProcess()

    const cwdSyncTimer = setInterval(syncFromMainProcess, 10_000)

    return () => {
      clearInterval(cwdSyncTimer)
      unsubCreated?.()
      unsubClosed?.()
    }
  }, [stableHandleCreated, stableHandleClosed])
}
