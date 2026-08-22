/**
 * LLMSnapshotPanel — Debug Observability Phase 5
 *
 * 全屏检视面板：左侧树形导航 + 右侧连续平铺内容。
 * 替代 Phase 3 的小 Modal + Tab 切换方案。
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button, OVERLAY_SURFACE_CLASS, toast, useOverlayContainer } from '@tabtin/smartsheet-ui'
import { createLogger } from '@/utils/logger'
import {
  ChevronDown, ChevronRight, Download, Copy, Check, X,
  Braces, MessageSquare, Wrench, SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@tabtin/chat-client'
import type { LLMCallSnapshot } from '../../../stores/chat/shared/types'
import {
  TEXT, TEXT_COLOR, ICON_SIZE, BORDER, BG, CARD_RADIUS,
} from '../registry/chatDesignTokens'

/* ─── Props ────────────────────────────────────────────────────── */

type DebugDataSource = 'local' | 'cloud'

const log = createLogger('LLMSnapshotPanel')

type SaveExportIpcResult =
  | { success: true; absolutePath: string; bytes: number }
  | { success: false; error: string }

function buildExportFilename(
  dataSource: DebugDataSource,
  sessionId: string | null,
  snapshot: LLMCallSnapshot | undefined,
): string {
  if (dataSource === 'local' && snapshot) {
    return `llm-snapshot-${sessionId ?? snapshot.runId}-iter${snapshot.iteration}.json`
  }
  return `cloud-messages-${sessionId ?? 'session'}.json`
}

function fallbackBrowserDownload(jsonText: string, filename: string): void {
  const blob = new Blob([jsonText], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 静默落到 ~/Downloads/TabTin/exports/，再 showItemInFolder——与「导出诊断日志」同款。
 * IPC 不可用时降级为浏览器下载（无路径可 reveal）。
 */
async function saveAndRevealExportJson(jsonText: string, filename: string): Promise<void> {
  const invoke = window.electron?.ipcRenderer?.invoke
  const showItemInFolder = window.tabtin?.showItemInFolder

  if (!invoke) {
    fallbackBrowserDownload(jsonText, filename)
    return
  }

  let absolutePath: string
  try {
    const result = (await invoke('storage-manager:save-export', {
      filename,
      data: jsonText,
      encoding: 'utf-8',
      mimeType: 'application/json',
      bucketId: 'llm-snapshot',
    })) as SaveExportIpcResult

    if (!result?.success || !result.absolutePath) {
      throw new Error(
        !result || result.success
          ? '导出未返回路径'
          : result.error || '导出失败',
      )
    }
    absolutePath = result.absolutePath
  } catch (err) {
    log.warn('静默落盘失败，降级浏览器下载:', err)
    fallbackBrowserDownload(jsonText, filename)
    toast({
      title: '已降级为浏览器下载',
      description: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // reveal 失败不影响导出成功（与诊断包主进程 reveal 吞错同款）
  if (showItemInFolder) {
    try {
      await showItemInFolder(absolutePath)
    } catch (err) {
      log.warn('打开导出文件夹失败:', err)
    }
  }
}

interface LLMSnapshotPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 本机 agent-runtime 捕获的 LLM 调用快照（memory + snapshots.jsonl）。
   */
  snapshots: LLMCallSnapshot[]
  /** Django API 落库的 ChatMessage 列表（renderer store 缓存）。 */
  cloudMessages: ChatMessage[]
  localSnapshotCount: number
  cloudMessageCount: number
  /** 当前 session id——用于头部展示 + 与后端 chat_message 交叉核对。 */
  sessionId: string | null
  /**
   * ：可检视的 Agent 源（主 Agent + 各子 Agent）。>1 项时头部渲染
   * 「主/子 Agent」下拉；选中子 Agent 时上层把 `snapshots` 换成该子 Agent 的快照。
   * 省略 / 仅 1 项时不渲染下拉（行为不变）。
   */
  agentOptions?: Array<{ id: string; label: string }>
  selectedAgentId?: string
  onSelectAgent?: (id: string) => void
}

/* ─── Nav primitives ───────────────────────────────────────────── */

type NavId = string

const NavItem: React.FC<{
  id: NavId
  label: string
  active: boolean
  indent?: boolean
  badge?: string | number
  onClick: (id: NavId) => void
}> = ({ id, label, active, indent, badge, onClick }) => (
  <button
    type="button"
    className={cn(
      'flex w-full items-center gap-1.5 px-3 py-1 text-left rounded-md transition-colors',
      indent ? 'pl-8' : 'pl-3',
      active
        ? 'bg-accent/10 text-accent text-caption font-medium'
        : cn('text-caption', TEXT_COLOR.muted, 'hover:text-muted-foreground hover:bg-muted/20'),
    )}
    onClick={() => onClick(id)}
  >
    <span className="flex-1 min-w-0 truncate">{label}</span>
    {badge != null && (
      <span className={cn(
        'text-caption tabular-nums flex-shrink-0',
        active ? 'text-accent/60' : TEXT_COLOR.faint,
      )}>
        {badge}
      </span>
    )}
  </button>
)

const NavGroup: React.FC<{
  id: NavId
  label: string
  icon: React.ReactNode
  badge?: string | number
  isActiveGroup: boolean
  defaultExpanded?: boolean
  onNavigate: (id: NavId) => void
  children?: React.ReactNode
}> = ({ id, label, icon, badge, isActiveGroup, defaultExpanded = true, onNavigate, children }) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasChildren = React.Children.count(children) > 0

  return (
    <div>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            type="button"
            className={cn('p-1 rounded transition-colors', TEXT_COLOR.faint, 'hover:text-muted-foreground')}
            onClick={() => setExpanded(p => !p)}
          >
            {expanded
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-5" />
        )}
        <button
          type="button"
          className={cn(
            'flex flex-1 items-center gap-1.5 px-1.5 py-1.5 text-left rounded-md transition-colors min-w-0',
            isActiveGroup
              ? 'text-foreground font-medium'
              : cn(TEXT_COLOR.muted, 'hover:text-foreground hover:bg-muted/20'),
          )}
          onClick={() => {
            if (!expanded && hasChildren) setExpanded(true)
            onNavigate(id)
          }}
        >
          <span className="flex-shrink-0">{icon}</span>
          <span className="flex-1 min-w-0 truncate text-body">{label}</span>
          {badge != null && (
            <span className={cn('text-caption tabular-nums flex-shrink-0', TEXT_COLOR.faint)}>
              {badge}
            </span>
          )}
        </button>
      </div>
      {expanded && hasChildren && (
        <div className="mt-0.5 space-y-0.5">{children}</div>
      )}
    </div>
  )
}

/* ─── Content section header（右侧面板内） ──────────────────────── */

const ContentSectionHeader: React.FC<{
  navId: string
  title: string
  subtitle?: string
  registerRef: (id: string, el: HTMLElement | null) => void
}> = ({ navId, title, subtitle, registerRef }) => (
  <div
    ref={(el) => registerRef(navId, el)}
    data-nav-id={navId}
    className="pt-8 pb-3 first:pt-0"
  >
    <h2 className="text-subtitle font-semibold text-foreground">{title}</h2>
    {subtitle && (
      <p className={cn('text-caption mt-0.5', TEXT_COLOR.faint)}>{subtitle}</p>
    )}
    <div className={cn('mt-2 border-b', BORDER.subtle)} />
  </div>
)

/* ─── Badge 色彩映射 ───────────────────────────────────────────── */

const roleBadgeClass: Record<string, string> = {
  user: 'bg-primary/10 text-primary/80',
  assistant: 'bg-success/10 text-success/80',
}
const sourceBadgeClass: Record<string, string> = {
  user_input: 'bg-primary/10 text-primary/60',
  // eslint-disable-next-line tabtin/no-chat-design-violations -- DEBUG-only LLM 快照面板的来源色图例（user/tool/context/history 一套），整套保留才能辨识来源，非单点 UI 警示
  tool_result: 'bg-warning/10 text-warning/80',
  context_injection: 'bg-accent/10 text-accent/80',
  memory_recall: 'bg-accent/10 text-accent/60',
  project_rules: 'bg-primary/10 text-primary/80',
  active_todos: 'bg-accent/10 text-accent/80',
  todo_completion_nudge: 'bg-accent/10 text-accent/60',
  compaction_summary: 'bg-accent/10 text-accent/80',
  history: 'bg-muted/20 text-muted-foreground/60',
  model_output: 'bg-success/10 text-success/80',
}

/* ─── 消息 / schema 渲染（按用户要求：不结构化，直接原样显示 JSON） ─── */

const PRE_CLASS =
  'whitespace-pre-wrap break-words text-caption font-mono leading-relaxed'

const stringify = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// 消息内容用 JSON 缩进美化（contentPreview 多为 ContentBlock[] 的紧凑 JSON）；
// 纯文本（parse 失败）原样返回，不强行 JSON 化。
const prettyJson = (s: string): string => {
  const t = s.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return s
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

const ToolRow: React.FC<{
  tool: { name: string; description: string; inputSchema?: Record<string, unknown> }
  registerRef: (id: string, el: HTMLElement | null) => void
}> = ({ tool, registerRef }) => {
  const [expanded, setExpanded] = useState(false)
  const hasSchema = tool.inputSchema != null && Object.keys(tool.inputSchema).length > 0
  return (
    <div
      ref={(el) => registerRef(`nav-tool-${tool.name}`, el)}
      data-nav-id={`nav-tool-${tool.name}`}
      className={cn('border', BORDER.subtle, CARD_RADIUS, 'overflow-hidden')}
    >
      <button
        type="button"
        className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left', BG.card)}
        onClick={() => hasSchema && setExpanded(p => !p)}
      >
        {hasSchema
          ? (expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />)
          : <span className="w-3 flex-shrink-0" />}
        <span className={cn('font-mono text-body font-medium flex-shrink-0', TEXT_COLOR.secondary)}>
          {tool.name}
        </span>
        <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'flex-1 min-w-0 truncate')}>
          {tool.description}
        </span>
      </button>
      {expanded && hasSchema && (
        <div className={cn('px-3 py-2 border-t', BORDER.subtle)}>
          <pre className={cn(PRE_CLASS, TEXT_COLOR.secondary)}>{stringify(tool.inputSchema)}</pre>
        </div>
      )}
    </div>
  )
}

const MessageContentView: React.FC<{ msg: { contentPreview: string } }> = ({ msg }) => (
  <pre className={cn(PRE_CLASS, TEXT_COLOR.secondary)}>
    {msg.contentPreview ? prettyJson(msg.contentPreview) : '(empty)'}
  </pre>
)

const CloudMessageRow: React.FC<{ message: ChatMessage; index: number }> = ({ message, index }) => {
  const [expanded, setExpanded] = useState(false)
  const messageKind = message.message_kind ?? 'llm'
  const payload = {
    id: message.id,
    role: message.role,
    message_kind: messageKind,
    client_event_id: message.client_event_id ?? null,
    agent_run_id: message.agent_run_id ?? null,
    model_id: message.model_id ?? null,
    created_at: message.created_at,
    updated_at: message.updated_at ?? null,
    content: message.content,
    content_blocks_json: message.content_blocks_json ?? null,
    metadata: message.metadata ?? null,
    attachments_json: message.attachments_json ?? null,
    checkpoint_hash: message.checkpoint_hash ?? null,
    diff_summary: message.diff_summary ?? null,
    error_code: message.error_code ?? null,
  }
  const preview = message.content?.trim() || '(empty content)'
  return (
    <div className={cn('border', BORDER.subtle, CARD_RADIUS, 'overflow-hidden')}>
      <button
        type="button"
        className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left', BG.card)}
        onClick={() => setExpanded(p => !p)}
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
          : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'tabular-nums font-mono flex-shrink-0')}>
          #{index}
        </span>
        <span className={cn(
          'inline-flex px-1.5 py-0.5 rounded text-caption font-medium flex-shrink-0',
          roleBadgeClass[message.role] ?? 'bg-muted/20 text-muted-foreground/60',
        )}>
          {message.role}
        </span>
        <span className={cn('inline-flex px-1.5 py-0.5 rounded text-caption flex-shrink-0 bg-muted/20 text-muted-foreground/60')}>
          {messageKind}
        </span>
        <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'flex-1 min-w-0 truncate')}>
          {preview}
        </span>
      </button>
      {expanded && (
        <div className={cn('px-3 py-2 border-t', BORDER.subtle)}>
          <pre className={cn(PRE_CLASS, TEXT_COLOR.secondary)}>{stringify(payload)}</pre>
        </div>
      )}
    </div>
  )
}

const DebugSourceTabs: React.FC<{
  active: DebugDataSource
  localCount: number
  cloudCount: number
  onChange: (source: DebugDataSource) => void
}> = ({ active, localCount, cloudCount, onChange }) => (
  <div className={cn('inline-flex items-center rounded-lg border p-0.5', BORDER.subtle, BG.card)}>
    <button
      type="button"
      className={cn(
        'rounded-md px-2.5 py-1 text-caption transition-colors',
        active === 'local'
          ? 'bg-accent/10 text-accent font-medium'
          : cn(TEXT_COLOR.muted, 'hover:text-foreground'),
      )}
      onClick={() => onChange('local')}
    >
      本地快照 ({localCount})
    </button>
    <button
      type="button"
      className={cn(
        'rounded-md px-2.5 py-1 text-caption transition-colors',
        active === 'cloud'
          ? 'bg-accent/10 text-accent font-medium'
          : cn(TEXT_COLOR.muted, 'hover:text-foreground'),
      )}
      onClick={() => onChange('cloud')}
    >
      云端消息 ({cloudCount})
    </button>
  </div>
)

/* ─── 主组件 ───────────────────────────────────────────────────── */

export const LLMSnapshotPanel: React.FC<LLMSnapshotPanelProps> = ({
  open, onOpenChange, snapshots, cloudMessages, localSnapshotCount, cloudMessageCount, sessionId,
  agentOptions, selectedAgentId, onSelectAgent,
}) => {
  const { t } = useTranslation('chat')
  const [dataSource, setDataSource] = useState<DebugDataSource>(
    () => (localSnapshotCount > 0 ? 'local' : 'cloud'),
  )

  useEffect(() => {
    if (open) {
      setDataSource(localSnapshotCount > 0 ? 'local' : 'cloud')
    }
  }, [open, localSnapshotCount])

  // 按 run 分组成「轮」：用户每发一条消息 → AI 完整回复 = 一个 run（runId）= 一「轮」。
  // 同一 run 内部可能有多次 LLM 迭代（ReAct loop），其**末次迭代**的快照已累积该轮全部
  // 消息（所有中间 assistant / tool_result，按序）+ 末轮模型输出，故每轮只取末次迭代为代表。
  // 这样既符合用户对「轮」的认知，又消除 picker 把内部迭代误列成「轮」+ 跨 run 迭代号重复
  // （多个「第 0 轮」）的问题。runId 首次出现顺序即对话推进顺序。
  const turns = React.useMemo(() => {
    const lastByRun = new Map<string, LLMCallSnapshot>()
    const order: string[] = []
    for (const s of snapshots) {
      if (!lastByRun.has(s.runId)) order.push(s.runId)
      const prev = lastByRun.get(s.runId)
      if (!prev || s.iteration >= prev.iteration) lastByRun.set(s.runId, s)
    }
    return order.map(r => lastByRun.get(r)!)
  }, [snapshots])

  // 默认选中最后一轮（最新一次用户 turn）。open / 轮数变化时重置到最后一轮。
  const [selectedIdx, setSelectedIdx] = useState(() => Math.max(0, turns.length - 1))
  useEffect(() => {
    if (open) setSelectedIdx(Math.max(0, turns.length - 1))
  }, [open, turns.length])
  const snapshot = turns[selectedIdx] ?? turns[turns.length - 1] ?? null
  // Wave 6.3：modal 类——portal 走 OverlayContainer，切走 hot Space 时容器
  // `display:none` 自动让 modal 跟随消失（Activity hidden 沿 React 树 cleanup
  // effect、沿 DOM 树传 display:none），open state / activeNavId / scrollTop
  // 全部由 React 自然保留——子树**不 unmount**。Wave 4 时代用 isForeground
  // 卡 Portal mount 引发的"切回 scrollTop 重置 + nav 与内容左右不同步"问题
  // 不再存在，相应的 prevForegroundRef edge-of-foreground scroll-restore
  // effect 已删除（冗余）。Provider 之外 fallback 到 body，行为同 baseline。
  const overlayContainer = useOverlayContainer()

  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const contentRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map())
  const [activeNavId, setActiveNavId] = useState<NavId>('nav-system')
  const scrollingProgrammatically = useRef(false)

  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }
  }, [])

  useEffect(() => {
    if (open) {
      setActiveNavId('nav-system')
      sectionRefs.current.clear()
    }
  }, [open, snapshot])

  /* ── ref 注册 ── */

  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(id, el)
    else sectionRefs.current.delete(id)
  }, [])

  /* ── 导航点击 → 右侧滚动 ── */

  const scrollToSection = useCallback((id: NavId) => {
    const el = sectionRefs.current.get(id)
    if (!el || !contentRef.current) return
    scrollingProgrammatically.current = true
    setActiveNavId(id)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setTimeout(() => { scrollingProgrammatically.current = false }, 600)
  }, [])

  /* ── 右侧滚动 → 导航高亮跟随 ── */

  const handleContentScroll = useCallback(() => {
    if (scrollingProgrammatically.current) return
    const container = contentRef.current
    if (!container) return

    const containerRect = container.getBoundingClientRect()
    const threshold = containerRect.top + containerRect.height * 0.15
    let lastId = 'nav-system'

    const allSections = container.querySelectorAll<HTMLElement>('[data-nav-id]')
    for (const el of allSections) {
      if (el.getBoundingClientRect().top <= threshold) {
        lastId = el.getAttribute('data-nav-id') || lastId
      }
    }
    setActiveNavId(lastId)
  }, [])

  useEffect(() => {
    const container = contentRef.current
    if (!container || !open) return
    container.addEventListener('scroll', handleContentScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleContentScroll)
  }, [open, handleContentScroll])

  /* ── 导出 / 拷贝 ── */

  const handleExportJSON = useCallback(() => {
    const payload =
      dataSource === 'local' && snapshot
        ? snapshot
        : { sessionId, cloudMessages }
    const jsonText = JSON.stringify(payload, null, 2)
    const filename = buildExportFilename(dataSource, sessionId, snapshot)
    void saveAndRevealExportJson(jsonText, filename)
  }, [dataSource, snapshot, sessionId, cloudMessages])

  const handleCopyJSON = useCallback(async () => {
    const text = JSON.stringify(
      dataSource === 'local' && snapshot
        ? snapshot
        : { sessionId, cloudMessages },
      null,
      2,
    )
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked */ }
  }, [dataSource, snapshot, sessionId, cloudMessages])

  /* ── 派生数据 ── */

  const showLocalEmpty = dataSource === 'local' && !snapshot
  const showCloudEmpty = dataSource === 'cloud' && cloudMessages.length === 0

  const totalSystemChars = snapshot?.system.charCount ?? 0
  const activeGroupId =
    activeNavId.startsWith('nav-system') ? 'nav-system'
    : activeNavId.startsWith('nav-msg') ? 'nav-messages'
    : activeNavId.startsWith('nav-tool') ? 'nav-tools'
    : 'nav-params'

  const displayMessages: Array<{
    role: string
    source: string
    format?: 'text' | 'blocks'
    contentPreview: string
    charCount: number
  }> = snapshot
    ? (snapshot.response
        ? [
            ...snapshot.messages,
            {
              role: 'assistant',
              source: 'model_output',
              format: snapshot.response.format,
              contentPreview: snapshot.response.contentPreview,
              charCount: snapshot.response.charCount,
            },
          ]
        : snapshot.messages)
    : []

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {/* Wave 6.3：Portal 改走 OverlayContainer——切走 hot Space 时容器整体
          `display:none` 让 modal 跟随消失，子树**不 unmount**（Activity hidden
          仅 cleanup effect、不卸载 React state / DOM）。activeNavId / scrollTop
          全部保留，切回直接看到原视图。Provider 之外 fallback 到 body。 */}
      <DialogPrimitive.Portal container={overlayContainer ?? undefined}>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-modal overlay-backdrop-blur duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-3 z-modal flex flex-col rounded-xl overflow-hidden duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            OVERLAY_SURFACE_CLASS,
          )}
        >
          {/* ── Header ── */}
          <div className={cn(
            'flex items-center justify-between px-4 py-3 border-b shrink-0',
            BORDER.subtle,
          )}>
            <div className="min-w-0 space-y-2">
              <DialogPrimitive.Title className="text-subtitle font-medium">
                {t('llmSnapshot.debugTitle', { defaultValue: 'LLM 调试检视' })}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className={cn('text-caption flex items-center gap-2 flex-wrap', TEXT_COLOR.muted)}>
                {sessionId && (
                  <span className="font-mono">session {sessionId}</span>
                )}
                {dataSource === 'local' && snapshot && (
                  <>
                    <span>·</span>
                    <span>{snapshot.model}</span>
                    <span>·</span>
                    <span>{snapshot.timestampISO}</span>
                  </>
                )}
                {dataSource === 'cloud' && (
                  <>
                    <span>·</span>
                    <span>Django ChatMessage</span>
                  </>
                )}
              </DialogPrimitive.Description>
              <DebugSourceTabs
                active={dataSource}
                localCount={localSnapshotCount}
                cloudCount={cloudMessageCount}
                onChange={setDataSource}
              />
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {/* ：主/子 Agent 上下文切换——选子 Agent 时上层换 snapshots 源。 */}
              {agentOptions && agentOptions.length > 1 && (
                <select
                  value={selectedAgentId ?? 'main'}
                  onChange={(e) => onSelectAgent?.(e.target.value)}
                  className={cn(
                    'h-7 mr-1 rounded-md border bg-transparent px-2 text-caption max-w-[160px]',
                    BORDER.subtle, TEXT_COLOR.secondary,
                  )}
                  title={t('llmSnapshot.agentPicker', { defaultValue: '选择 Agent（主/子）' })}
                >
                  {agentOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
              )}
              {dataSource === 'local' && turns.length > 1 && snapshot && (
                <select
                  value={selectedIdx}
                  onChange={(e) => setSelectedIdx(Number(e.target.value))}
                  className={cn(
                    'h-7 mr-1 rounded-md border bg-transparent px-2 text-caption',
                    BORDER.subtle, TEXT_COLOR.secondary,
                  )}
                  title={t('llmSnapshot.turnPicker', { defaultValue: '选择对话轮次' })}
                >
                  {turns.map((s, i) => {
                    const count = s.messageCount + (s.response ? 1 : 0)
                    return (
                      <option key={i} value={i}>
                        {t('llmSnapshot.turnOption', {
                          defaultValue: `第 ${i + 1} 轮 · ${count} 条消息`,
                          turn: i + 1,
                          count,
                        })}
                      </option>
                    )
                  })}
                </select>
              )}
              <Button variant="ghost" size="sm" onClick={handleCopyJSON} className="gap-1.5 h-7">
                {copied
                  ? <Check className={ICON_SIZE.sm} />
                  : <Copy className={ICON_SIZE.sm} />}
                <span className="text-caption">
                  {copied
                    ? t('llmSnapshot.copied', { defaultValue: 'Copied' })
                    : t('llmSnapshot.copyJSON', { defaultValue: 'Copy JSON' })}
                </span>
              </Button>
              <Button variant="ghost" size="sm" onClick={handleExportJSON} className="gap-1.5 h-7">
                <Download className={ICON_SIZE.sm} />
                <span className="text-caption">
                  {t('llmSnapshot.exportJSON', { defaultValue: 'Export JSON' })}
                </span>
              </Button>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 ml-1">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>

          {dataSource === 'cloud' ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
              <p className={cn(TEXT.meta, TEXT_COLOR.muted, 'mb-4')}>
                来源：Django API / renderer store（`messagesBySessionId`）。与本地 LLM 快照独立存储，条数不一致通常表示执行端未落盘或跨设备执行。
              </p>
              {showCloudEmpty ? (
                <p className={cn(TEXT.meta, TEXT_COLOR.faint, 'py-8 text-center')}>
                  {t('llmSnapshot.noCloudMessages', { defaultValue: '当前会话无云端消息缓存' })}
                </p>
              ) : (
                <div className="space-y-2">
                  {cloudMessages.map((message, i) => (
                    <CloudMessageRow key={message.id} message={message} index={i} />
                  ))}
                </div>
              )}
            </div>
          ) : showLocalEmpty ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
              <p className={cn(TEXT.meta, TEXT_COLOR.muted, 'mb-4')}>
                来源：本机 `platform-data/.../snapshots.jsonl` + runtime 内存。当前会话在本机无 LLM 快照；可切到「云端消息」查看 Django 落库数据。
              </p>
              <p className={cn(TEXT.meta, TEXT_COLOR.faint, 'py-8 text-center')}>
                {t('llmSnapshot.noLocalSnapshots', { defaultValue: '本机无 LLM 调用快照' })}
              </p>
            </div>
          ) : null}

          {dataSource === 'local' && snapshot && (
          <div className="flex flex-col flex-1 min-h-0">
            <p className={cn('px-4 py-2 text-caption border-b shrink-0', BORDER.subtle, TEXT_COLOR.muted)}>
              来源：本机 agent-runtime LLM 入参快照 · 第 {selectedIdx + 1} 轮（共 {turns.length} 轮）
            </p>
          <div className="flex flex-1 min-h-0">
            {/* ── Left Nav ── */}
            <nav className={cn(
              'w-[220px] flex-shrink-0 border-r overflow-y-auto py-2 px-1.5 space-y-1',
              BORDER.subtle, BG.card,
            )}>
              <NavGroup
                id="nav-system"
                label="System Prompt"
                icon={<Braces className="h-3.5 w-3.5" />}
                badge={totalSystemChars > 0 ? `${(totalSystemChars / 1000).toFixed(1)}k` : undefined}
                isActiveGroup={activeGroupId === 'nav-system'}
                onNavigate={scrollToSection}
              >
                {snapshot.system.sections.map((section, i) => (
                  <NavItem
                    key={`${section.name}-${i}`}
                    id={`nav-system-${i}`}
                    label={section.name}
                    active={activeNavId === `nav-system-${i}`}
                    indent
                    badge={`${(section.charCount / 1000).toFixed(1)}k`}
                    onClick={scrollToSection}
                  />
                ))}
              </NavGroup>

              <NavGroup
                id="nav-messages"
                label="Messages"
                icon={<MessageSquare className="h-3.5 w-3.5" />}
                badge={displayMessages.length}
                isActiveGroup={activeGroupId === 'nav-messages'}
                defaultExpanded={displayMessages.length <= 20}
                onNavigate={scrollToSection}
              >
                {displayMessages.map((msg, i) => (
                  <NavItem
                    key={i}
                    id={`nav-msg-${i}`}
                    label={`#${i} ${msg.role} · ${msg.source}`}
                    active={activeNavId === `nav-msg-${i}`}
                    indent
                    badge={msg.charCount > 999 ? `${(msg.charCount / 1000).toFixed(1)}k` : msg.charCount}
                    onClick={scrollToSection}
                  />
                ))}
              </NavGroup>

              <NavGroup
                id="nav-tools"
                label="Tools"
                icon={<Wrench className="h-3.5 w-3.5" />}
                badge={snapshot.toolCount}
                isActiveGroup={activeGroupId === 'nav-tools'}
                defaultExpanded={false}
                onNavigate={scrollToSection}
              >
                {snapshot.tools.map((tool) => (
                  <NavItem
                    key={tool.name}
                    id={`nav-tool-${tool.name}`}
                    label={tool.name}
                    active={activeNavId === `nav-tool-${tool.name}`}
                    indent
                    onClick={scrollToSection}
                  />
                ))}
              </NavGroup>

              <NavGroup
                id="nav-params"
                label="Params"
                icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
                isActiveGroup={activeGroupId === 'nav-params'}
                onNavigate={scrollToSection}
              />
            </nav>

            {/* ── Right Content ── */}
            <div ref={contentRef} className="flex-1 min-w-0 overflow-y-auto px-6 py-4">

              {/* ━━ System Prompt ━━ */}
              <ContentSectionHeader
                navId="nav-system"
                title="System Prompt"
                subtitle={totalSystemChars > 0
                  ? `${totalSystemChars.toLocaleString()} chars total`
                  : undefined}
                registerRef={registerRef}
              />
              {totalSystemChars > 10000 && (
                <div className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-full mb-3 border border-warning/30',
                  TEXT.meta, 'text-warning/80',
                )}>
                  ⚠ Large: {(totalSystemChars / 1000).toFixed(1)}k chars
                </div>
              )}
              {snapshot.system.sections.length === 0 ? (
                <p className={cn(TEXT.meta, TEXT_COLOR.faint, 'py-4')}>
                  {t('llmSnapshot.noSections', { defaultValue: 'No sections available' })}
                </p>
              ) : (
                <div className="space-y-3">
                  {snapshot.system.sections.map((section, i) => (
                    <div
                      key={`${section.name}-${i}`}
                      ref={(el) => registerRef(`nav-system-${i}`, el)}
                      data-nav-id={`nav-system-${i}`}
                      className={cn('border', BORDER.subtle, CARD_RADIUS, 'overflow-hidden')}
                    >
                      <div className={cn(
                        'flex items-center justify-between px-3 py-2',
                        BG.card,
                      )}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn(
                            'font-mono text-body font-medium',
                            TEXT_COLOR.secondary,
                          )}>
                            {section.name}
                          </span>
                          <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>
                            from {section.source}
                          </span>
                        </div>
                        <span className={cn(
                          TEXT.meta, TEXT_COLOR.faint,
                          'tabular-nums flex-shrink-0',
                        )}>
                          {section.charCount.toLocaleString()} chars
                        </span>
                      </div>
                      <div className={cn('px-3 py-2 border-t', BORDER.subtle)}>
                        <pre className={cn(
                          'whitespace-pre-wrap break-words text-caption font-mono leading-relaxed',
                          TEXT_COLOR.secondary,
                        )}>
                          {section.contentPreview || '(empty)'}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ━━ Messages ━━ */}
              <ContentSectionHeader
                navId="nav-messages"
                title="Messages"
                subtitle={`${displayMessages.length} messages`}
                registerRef={registerRef}
              />
              {displayMessages.length === 0 ? (
                <p className={cn(TEXT.meta, TEXT_COLOR.faint, 'py-4')}>
                  {t('llmSnapshot.noMessages', { defaultValue: 'No messages' })}
                </p>
              ) : (
                <div className="space-y-2">
                  {displayMessages.map((msg, i) => (
                    <div
                      key={i}
                      ref={(el) => registerRef(`nav-msg-${i}`, el)}
                      data-nav-id={`nav-msg-${i}`}
                      className={cn('border', BORDER.subtle, CARD_RADIUS, 'overflow-hidden')}
                    >
                      <div className={cn(
                        'flex items-center gap-2 px-3 py-1.5',
                        BG.card,
                      )}>
                        <span className={cn(
                          TEXT.meta, TEXT_COLOR.faint, 'tabular-nums font-mono flex-shrink-0',
                        )}>
                          #{i}
                        </span>
                        <span className={cn(
                          'inline-flex px-1.5 py-0.5 rounded text-caption font-medium flex-shrink-0',
                          roleBadgeClass[msg.role] ?? 'bg-muted/20 text-muted-foreground/60',
                        )}>
                          {msg.role}
                        </span>
                        <span className={cn(
                          'inline-flex px-1.5 py-0.5 rounded text-caption flex-shrink-0',
                          sourceBadgeClass[msg.source] ?? 'bg-muted/20 text-muted-foreground/60',
                        )}>
                          {msg.source}
                        </span>
                        <span className="flex-1" />
                        <span className={cn(
                          TEXT.meta, TEXT_COLOR.faint,
                          'tabular-nums flex-shrink-0',
                        )}>
                          {msg.charCount.toLocaleString()} chars
                        </span>
                      </div>
                      <div className={cn('px-3 py-2 border-t', BORDER.subtle)}>
                        <MessageContentView msg={msg} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ━━ Tools ━━ */}
              <ContentSectionHeader
                navId="nav-tools"
                title="Tools"
                subtitle={`${snapshot.toolCount} tools`}
                registerRef={registerRef}
              />
              {snapshot.tools.length === 0 ? (
                <p className={cn(TEXT.meta, TEXT_COLOR.faint, 'py-4')}>
                  {t('llmSnapshot.noTools', { defaultValue: 'No tools provided' })}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {snapshot.tools.map((tool) => (
                    <ToolRow key={tool.name} tool={tool} registerRef={registerRef} />
                  ))}
                </div>
              )}

              {/* ━━ Params ━━ */}
              <ContentSectionHeader
                navId="nav-params"
                title="Params"
                registerRef={registerRef}
              />
              <div className={cn('border', BORDER.subtle, CARD_RADIUS, 'px-3 py-2')}>
                {([
                  ['Session ID', sessionId ?? '—'],
                  ['Model', snapshot.model],
                  ['Max Tokens', snapshot.maxTokens],
                  ['Temperature', snapshot.temperature],
                  ['Request Source', snapshot.requestSource],
                  ['Iteration', snapshot.iteration],
                  ['Run ID', snapshot.runId],
                  ['Timestamp', snapshot.timestampISO],
                  ['System Chars', totalSystemChars.toLocaleString()],
                  ['Message Count', snapshot.messageCount],
                  ['Tool Count', snapshot.toolCount],
                ] as const).map(([label, value]) => (
                  <div key={label} className="flex items-center gap-3 py-1">
                    <span className={cn(
                      TEXT.meta, 'font-medium', TEXT_COLOR.muted,
                      'w-28 flex-shrink-0',
                    )}>
                      {label}
                    </span>
                    <span className={cn('font-mono text-body', TEXT_COLOR.secondary)}>
                      {value != null ? String(value) : '—'}
                    </span>
                  </div>
                ))}
              </div>

              <div className="h-16" />
            </div>
          </div>
          </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
