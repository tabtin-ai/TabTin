/**
 * ConversationSegmentPopover — 对话片段浮层
 *
 * 点击版本条目的"查看对话片段"时弹出。
 * 调用 conversation-segment API 获取目标消息前后的对话内容，
 * 在浮层中渲染消息列表，底部提供"在聊天面板中打开完整对话"跳转链接。
 *
 * Wave 14 QC-02 / PRD §3.4 US-3：在消息列表之后渲染子任务卡片
 * （来自 `checkpoint_context.sub_conversations`）。默认折叠，展开时懒加载
 * 子 session 的 conversation-segment。
 *
 * **层级语义**（Wave 14 技术 Review 澄清）：
 * - L0 = 浮层父 session 的消息 + 子任务卡片列表
 * - L1 = SubtaskCard 展开 = 子 session 消息 + "查看完整对话 →"跳转入口
 * - 想再深入追溯（子任务的子任务）→ 通过"查看完整对话 →"跳转到聊天面板
 *   查看完整 session，而不是在浮层内无限嵌套。
 *
 * PRD §3.4 US-3 "最多 2 层递归" = 浮层内至多展示 L0+L1 两层信息，
 * 不是让 SubtaskCard 真正递归渲染自身（后者会导致浮层 UI 无限挤压、首屏
 * 加载量爆炸，且后端 conversation-segment API 不返回嵌套 sub_conversations）。
 * 超出的层级统一通过聊天面板跳转处理。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConversationSegmentMessage,
  SubConversationRef,
  VersionPanelLabels,
} from './types'
import { fetchConversationSegment } from './previewApi'

export interface ConversationSegmentPopoverProps {
  chatApiBase: string
  token: string
  sessionId: string
  messageId: string
  /** Wave 14 QC-02：父 session 派生的子任务引用列表（来自 VersionPanel 的 checkpoint_context.sub_conversations）。 */
  subConversations?: SubConversationRef[] | null
  labels?: VersionPanelLabels
  onNavigateToChat: (sessionId: string, messageId: string) => void
  onClose: (opts?: { sessionArchived?: boolean }) => void
  triggerRef?: React.RefObject<HTMLElement | null>
}

export function ConversationSegmentPopover({
  chatApiBase,
  token,
  sessionId,
  messageId,
  subConversations,
  labels,
  onNavigateToChat,
  onClose,
  triggerRef,
}: ConversationSegmentPopoverProps) {
  const [messages, setMessages] = useState<ConversationSegmentMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionArchived, setSessionArchived] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [posStyle, setPosStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchConversationSegment(chatApiBase, sessionId, messageId, token)
      .then((data) => {
        if (cancelled) return
        if (data?.session_archived) {
          setSessionArchived(true)
        } else if (data?.messages) {
          setMessages(data.messages)
        } else {
          setError(labels?.conversationSegmentError ?? '无法加载对话片段')
        }
      })
      .catch(() => {
        if (!cancelled) setError(labels?.conversationSegmentError ?? '无法加载对话片段')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [chatApiBase, sessionId, messageId, token, labels?.conversationSegmentError])

  // Fixed positioning to escape overflow clipping
  useEffect(() => {
    if (!triggerRef?.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const popoverWidth = 360
    const popoverMaxHeight = 480
    const padding = 8

    let top = rect.bottom + 4
    let left = rect.left

    if (left + popoverWidth > window.innerWidth - padding) {
      left = Math.max(padding, window.innerWidth - popoverWidth - padding)
    }
    if (top + popoverMaxHeight > window.innerHeight - padding) {
      top = Math.max(padding, rect.top - popoverMaxHeight - 4)
    }

    setPosStyle({ position: 'fixed', top, left })
  }, [triggerRef])

  // Close on outside click
  useEffect(() => {
    const closeOpts = sessionArchived ? { sessionArchived: true } : undefined
    const onOutsideClick = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        (!triggerRef?.current || !triggerRef.current.contains(e.target as Node))
      ) {
        onClose(closeOpts)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(closeOpts)
    }
    document.addEventListener('mousedown', onOutsideClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onOutsideClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose, triggerRef, sessionArchived])

  const roleLabel = useCallback((role: string) => {
    if (role === 'user') return labels?.roleUser ?? '你'
    if (role === 'assistant') return labels?.roleAssistant ?? 'AI 助手'
    return role
  }, [labels?.roleUser, labels?.roleAssistant])

  const formatTime = useCallback((isoString: string | null) => {
    if (!isoString) return ''
    try {
      const d = new Date(isoString)
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }, [])

  const validSubConversations = (subConversations ?? []).filter(
    (s) => s && s.session_id && s.message_id,
  )
  const hasSubtasks = validSubConversations.length > 0

  return (
    <div
      ref={popoverRef}
      role="dialog"
      className="w-[360px] max-h-[480px] flex flex-col rounded-lg border border-border bg-card shadow-md overflow-hidden z-dropdown"
      style={posStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-body font-medium text-foreground">
          {labels?.conversationSegmentTitle ?? '对话片段'}
        </span>
        <button
          onClick={() => onClose(sessionArchived ? { sessionArchived: true } : undefined)}
          aria-label={labels?.cancel ?? '关闭'}
          className="flex items-center justify-center w-5 h-5 rounded hover:bg-muted text-muted-foreground transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
        {loading && (
          <div className="py-6 flex flex-col items-center gap-1.5">
            <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-accent rounded-full animate-spin motion-reduce:animate-none" />
            <span className="text-caption text-muted-foreground/60">
              {labels?.loading ?? '加载中...'}
            </span>
          </div>
        )}

        {!loading && sessionArchived && (
          <div className="py-6 flex flex-col items-center gap-2 text-muted-foreground">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <path d="m21 8-2-2H5L3 8" /><rect x="3" y="8" width="18" height="12" rx="1" /><path d="M10 12h4" />
            </svg>
            <span className="text-body">
              {labels?.conversationSessionArchived ?? '原始对话已归档'}
            </span>
          </div>
        )}

        {error && !sessionArchived && (
          <div className="py-4 text-center text-body text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && !sessionArchived && messages.length === 0 && !hasSubtasks && (
          <div className="py-4 text-center text-body text-muted-foreground">
            {labels?.conversationSegmentEmpty ?? '暂无对话消息'}
          </div>
        )}

        {!loading && !error && !sessionArchived && messages.map((msg) => (
          <div
            key={msg.id}
            className={`rounded-md px-2.5 py-2 ${
              msg.is_anchor ? 'bg-accent/[0.06] border-l-2 border-l-accent' : 'bg-muted/60'
            }`}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`text-caption font-medium ${
                msg.role === 'user' ? 'text-foreground' : 'text-type-agent'
              }`}>
                {msg.role === 'user' ? '🧑' : '🤖'} {roleLabel(msg.role)}
              </span>
              {msg.created_at && (
                <span className="text-caption text-muted-foreground/60">
                  {formatTime(msg.created_at)}
                </span>
              )}
            </div>
            <div className="text-body text-foreground/80 whitespace-pre-wrap break-words line-clamp-6">
              {msg.content}
            </div>
            {msg.content_truncated && (
              <span className="text-caption text-muted-foreground/60">…</span>
            )}
          </div>
        ))}

        {/* Wave 14 QC-02 / PRD §3.4 US-3：子任务卡片区块（默认折叠） */}
        {!loading && !sessionArchived && hasSubtasks && (
          <div className="pt-1 space-y-2">
            <div className="flex items-center gap-1.5">
              <div className="h-px flex-1 bg-border/60" />
              <span className="text-caption text-muted-foreground/60">
                {labels?.subTaskLabel ?? '子任务'}
              </span>
              <div className="h-px flex-1 bg-border/60" />
            </div>
            {validSubConversations.map((sub) => (
              <SubtaskCard
                key={`${sub.session_id}:${sub.message_id}`}
                subtask={sub}
                chatApiBase={chatApiBase}
                token={token}
                labels={labels}
                onNavigateToChat={onNavigateToChat}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer: navigate to full conversation.
          Wave 14 Review：只要有锚点可跳转（messages 非空或有子任务），
          就显示"查看完整对话 →"入口；避免 messages 为空但 hasSubtasks 时
          用户失去进入父 session 的直达链接。 */}
      {!loading && !error && !sessionArchived && (messages.length > 0 || hasSubtasks) && (
        <div className="px-3 py-2 border-t border-border">
          <button
            className="text-body text-accent hover:underline w-full text-right"
            onClick={() => onNavigateToChat(sessionId, messageId)}
          >
            {labels?.openFullConversation ?? '查看完整对话 →'}
          </button>
        </div>
      )}
    </div>
  )
}

/* ───────────────────────── Subtask Card ───────────────────────── */

interface SubtaskCardProps {
  subtask: SubConversationRef
  chatApiBase: string
  token: string
  labels?: VersionPanelLabels
  onNavigateToChat: (sessionId: string, messageId: string) => void
}

function SubtaskCard({
  subtask,
  chatApiBase,
  token,
  labels,
  onNavigateToChat,
}: SubtaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [sessionArchived, setSessionArchived] = useState(false)
  const [messages, setMessages] = useState<ConversationSegmentMessage[]>([])
  /**
   * 代数防抖（Wave 14 Review）：取消旧闭包，防止 Strict Mode 双挂载 + cleanup
   * 导致 `hasLoadedRef=true` 但 `loaded=false` 永久卡死的 bug。
   * 以当前 generation 识别 "这个闭包还是本次展开周期内的拥有者"，非拥有者的
   * 回调一律丢弃（包括 set state）。
   */
  const loadGenRef = useRef(0)

  // 懒加载子 session 的 conversation-segment；使用代数 generation 确保：
  //   - 同一展开周期内重复触发 effect 不重复请求（loaded=true 门控）
  //   - cleanup 时将 generation 递进，新旧闭包自然隔离
  //   - 失败时允许再展开/重试（loaded 仍为 false）
  useEffect(() => {
    if (!expanded || loaded) return
    loadGenRef.current += 1
    const myGen = loadGenRef.current
    setLoading(true)
    setLoadError(false)
    fetchConversationSegment(chatApiBase, subtask.session_id, subtask.message_id, token, {
      before: 2, after: 2,
    })
      .then((data) => {
        if (loadGenRef.current !== myGen) return
        if (data?.session_archived) {
          setSessionArchived(true)
        } else if (data?.messages) {
          setMessages(data.messages)
        } else {
          setLoadError(true)
        }
        setLoaded(true)
      })
      .catch(() => {
        if (loadGenRef.current !== myGen) return
        setLoadError(true)
        // 失败态不锁死 loaded：用户收起重开可重试
      })
      .finally(() => {
        if (loadGenRef.current === myGen) setLoading(false)
      })
    return () => {
      // 旧闭包的 then/catch/finally 到达时 generation 不匹配，会静默丢弃
      loadGenRef.current += 1
    }
  }, [expanded, loaded, chatApiBase, subtask.session_id, subtask.message_id, token])

  const roleLabel = useCallback((role: string) => {
    if (role === 'user') return labels?.roleUser ?? '你'
    if (role === 'assistant') return labels?.roleAssistant ?? 'AI 助手'
    return role
  }, [labels?.roleUser, labels?.roleAssistant])

  const formatTime = useCallback((isoString: string | null) => {
    if (!isoString) return ''
    try {
      const d = new Date(isoString)
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }, [])

  // Review 必修：label 为空时不要渲染"子任务: 子任务"重复文案，只显示 fallback 标题。
  const labelPrefix = labels?.subTaskLabel ?? '子任务'
  const trimmedLabel = subtask.label?.trim() || ''
  const displayTitle = trimmedLabel ? `${labelPrefix}: ${trimmedLabel}` : labelPrefix

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-1.5 min-w-0 flex-1">
          {/* Branch icon */}
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="mt-0.5 shrink-0 text-accent/80"
          >
            <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="text-caption font-medium text-foreground/80 truncate" title={displayTitle}>
              {displayTitle}
            </div>
          </div>
        </div>
        <button
          className="text-caption text-accent/80 hover:text-accent hover:underline shrink-0"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded
            ? (labels?.subTaskCollapse ?? '收起子任务对话 ↑')
            : (labels?.subTaskExpand ?? '展开子任务对话 ↓')}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5 border-l border-border/60 pl-2">
          {loading && (
            <div className="flex items-center gap-1.5 text-caption text-muted-foreground/60 py-1">
              <div className="w-3 h-3 border-2 border-muted-foreground/30 border-t-accent rounded-full animate-spin motion-reduce:animate-none" />
              {labels?.subTaskLoading ?? '加载子任务对话中…'}
            </div>
          )}
          {sessionArchived && (
            <div className="text-caption text-muted-foreground/60 py-1">
              {labels?.conversationSessionArchived ?? '原始对话已归档'}
            </div>
          )}
          {loadError && !sessionArchived && (
            <div className="text-caption text-destructive/80 py-1">
              {labels?.conversationSegmentError ?? '无法加载对话片段'}
            </div>
          )}
          {!loading && !loadError && !sessionArchived && messages.length === 0 && (
            <div className="text-caption text-muted-foreground/60 py-1">
              {labels?.subTaskEmpty ?? '子任务暂无对话内容'}
            </div>
          )}
          {!loading && !loadError && !sessionArchived && messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded px-2 py-1.5 ${
                msg.is_anchor ? 'bg-accent/[0.05] border-l-2 border-l-accent/60' : 'bg-muted/60'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`text-caption font-medium ${
                  msg.role === 'user' ? 'text-foreground/80' : 'text-type-agent'
                }`}>
                  {msg.role === 'user' ? '🧑' : '🤖'} {roleLabel(msg.role)}
                </span>
                {msg.created_at && (
                  <span className="text-caption text-muted-foreground/60">
                    {formatTime(msg.created_at)}
                  </span>
                )}
              </div>
              <div className="text-caption text-foreground/80 whitespace-pre-wrap break-words line-clamp-4">
                {msg.content}
              </div>
              {msg.content_truncated && (
                <span className="text-caption text-muted-foreground/60">…</span>
              )}
            </div>
          ))}
          {/* 跳转子 session 完整对话（展开态下提供入口；与最大深度降级链接互补） */}
          {!loading && !loadError && !sessionArchived && messages.length > 0 && (
            <div className="pt-1">
              <button
                className="text-caption text-accent/80 hover:text-accent hover:underline"
                onClick={() => onNavigateToChat(subtask.session_id, subtask.message_id)}
              >
                {labels?.openFullConversation ?? '查看完整对话 →'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
