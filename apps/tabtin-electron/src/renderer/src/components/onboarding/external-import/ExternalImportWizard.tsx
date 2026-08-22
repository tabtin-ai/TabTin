/**
 * 外部 Agent 数据导入——分层引导式向导（Layer D，PRD §4.2–§4.4）。
 *
 * "平台 → workspace(项目) → 对话(session)"三级引导，选择粒度到**单条对话**。
 *   步骤 1 平台   从哪些工具导入；卡片显示全时段项目/对话数 + 最近活跃 +（有濒危数据时）加急。
 *   步骤 2 内容   分平台 Tab + 工作目录树；底部安全 / 工作空间说明。
 *   步骤 3 导入   进度与结果（无单独确认页）。
 *
 * 契约不变：run 输入 = jobId + 分源 sessionRefs + options{since,redact,targetOrganizationId,
 * agentId,deviceId}；勾到 session 级就传显式 sessionRefs。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DownloadCloud,
  Loader2,
  FolderGit2,
  FolderPlus,
  AlertTriangle,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  ChevronRight,
  ChevronDown,
  RotateCcw,
  Check,
  Minus,
  Search,
  Clock,
  Terminal,
  Code2,
  MousePointer2,
  Bot,
  MessageSquare,
  Ban,
} from 'lucide-react'
import {
  Button,
  Checkbox,
  toast,
} from '@components/ui'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import type {
  ImportDetectResult,
  ImportRunInput,
  ImportSessionRef,
  ImportSourceId,
} from '@tabtin/cli-server-core'
import { cn } from '@utils/cn'
import { useImportIdentity, type ExistingWorkspaceMatch } from './useImportIdentity'
import { useImportJobStore, type ImportJobUiState } from './useImportJobStore'
import { IMPORT_SOURCE_LABELS } from './useExternalImportDetection'
import { ImportSourceIcon } from './ImportSourceIcon'
import { ImportReadOnlyDiagram } from './ImportReadOnlyDiagram'
import { compareWorkspacesByLatestDesc } from './importWorkspaceSort'

type WizardStep = 'platform' | 'content' | 'progress' | 'result'

/** 根据 job 终态/进行中态决定重开向导时应落在哪一步（避免回到 platform 丢失进度/结果）。 */
function stepForJobState(state: ImportJobUiState): WizardStep {
  switch (state) {
    case 'running':
      return 'progress'
    case 'completed':
    case 'cancelled':
    case 'error':
      return 'result'
    default:
      return 'platform'
  }
}
type RangeKey = '7d' | '30d' | '90d' | 'all'

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: '90d', label: '90 天' },
  { key: 'all', label: '全部' },
]

const ORPHAN_CWD = '__orphan__'
const SESSION_PAGE = 60

/** 各平台展示元信息：图标 + 品牌色调（用于卡片与树的平台识别）。 */
const SOURCE_META: Record<
  ImportSourceId,
  { label: string; Icon: React.ComponentType<{ className?: string }>; tint: string; chip: string }
> = {
  claude_code: { label: 'Claude Code', Icon: Terminal, tint: 'text-orange-500', chip: 'bg-orange-500/10 text-orange-600 dark:text-orange-400' },
  codex: { label: 'Codex', Icon: Code2, tint: 'text-emerald-500', chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  cursor: { label: 'Cursor', Icon: MousePointer2, tint: 'text-sky-500', chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  workbuddy: { label: 'WorkBuddy', Icon: Bot, tint: 'text-violet-500', chip: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
}

function sourceLabel(source: ImportSourceId): string {
  return SOURCE_META[source]?.label ?? IMPORT_SOURCE_LABELS[source] ?? source
}

// ─── 数据模型：平台 → workspace → 对话 ──────────────────────────────────────

interface WsNode {
  key: string
  source: ImportSourceId
  cwd: string
  cwdExists: boolean
  isOrphan: boolean
  sessions: ImportSessionRef[] // 已按 updatedAt 倒序
}

interface PlatformNode {
  source: ImportSourceId
  detect: ImportDetectResult | null
  workspaces: WsNode[]
  /** 范围内对话/项目数（树用）。 */
  sessionCount: number
  workspaceCount: number
  /** 全时段（detect，卡片用，避免被范围裁剪低报）。 */
  allTimeSessionCount: number
  allTimeWorkspaceCount: number
}

function sessionKey(ref: ImportSessionRef): string {
  return `${ref.source}::${ref.sourceSessionId}`
}

/** 零散会话可归入默认工作空间；有明确 cwd 但目录失效的工作空间不可导入。 */
function isWorkspaceImportable(ws: WsNode): boolean {
  return ws.isOrphan || ws.cwdExists
}

function rangeToSince(range: RangeKey): string | undefined {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : null
  if (days === null) return undefined
  return new Date(Date.now() - days * 864e5).toISOString()
}

function lexicalNormalize(p: string): string {
  if (!p) return ''
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

function basename(p: string): string {
  const norm = lexicalNormalize(p)
  const seg = norm.split('/')
  return seg[seg.length - 1] || norm || '未命名目录'
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon} 个月前`
  return `${Math.floor(mon / 12)} 年前`
}

function byUpdatedDesc(a: ImportSessionRef, b: ImportSessionRef): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
}

type SelState = 'all' | 'some' | 'none'

function wsMatchesSearch(ws: WsNode, filter: string): boolean {
  if (!filter) return true
  if (!ws.isOrphan && (basename(ws.cwd).toLowerCase().includes(filter) || ws.cwd.toLowerCase().includes(filter))) {
    return true
  }
  return ws.sessions.some((s) => (s.title || '').toLowerCase().includes(filter))
}

function wsNameMatches(ws: WsNode, filter: string): boolean {
  if (!filter || ws.isOrphan) return false
  return basename(ws.cwd).toLowerCase().includes(filter) || ws.cwd.toLowerCase().includes(filter)
}

// ─── 三态复选框 ──────────────────────────────────────────────────────────────

const TriCheckbox: React.FC<{
  state: SelState
  onChange?: () => void
  /** 纯展示（不可点，用于外层已是可点容器时避免嵌套交互元素）。 */
  presentational?: boolean
  disabled?: boolean
  className?: string
  'aria-label'?: string
}> = ({ state, onChange, presentational, disabled = false, className, ...rest }) => {
  const visual = (
    <>
      {state === 'all' && <Check className="h-3 w-3" strokeWidth={3} />}
      {state === 'some' && <Minus className="h-3 w-3" strokeWidth={3} />}
    </>
  )
  const cls = cn(
    'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
    state === 'none'
      ? 'border-primary/60 bg-transparent'
      : 'border-accent bg-accent text-accent-foreground',
    disabled && 'cursor-not-allowed border-muted-foreground/25 bg-muted/30 text-muted-foreground/40',
    !disabled && !presentational && state === 'none' && 'hover:border-primary',
    className,
  )
  if (presentational) {
    return (
      <span className={cls} aria-hidden {...rest}>
        {visual}
      </span>
    )
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onChange?.()
      }}
      className={cls}
      {...rest}
    >
      {visual}
    </button>
  )
}

const IMPORT_FLOW_STEPS = [
  { id: 'platform', label: '选择来源' },
  { id: 'content', label: '选择对话' },
  { id: 'import', label: '导入' },
] as const

function ImportStepper({ step }: { step: WizardStep }) {
  const activeIndex = step === 'platform' ? 0 : step === 'content' ? 1 : 2

  return (
    <nav
      aria-label="导入步骤"
      className="mb-4 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/30 pb-4"
      data-testid="external-import-stepper"
    >
      {IMPORT_FLOW_STEPS.map((item, index) => {
        const done = index < activeIndex
        const active = index === activeIndex
        const isImportStep = index === 2
        const label =
          isImportStep && step === 'progress'
            ? '正在导入'
            : isImportStep && step === 'result'
              ? '导入结果'
              : item.label
        return (
          <React.Fragment key={item.id}>
            {index > 0 ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
            ) : null}
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption',
                active && 'bg-accent/10 font-medium text-accent',
                done && !active && 'text-muted-foreground',
                !active && !done && 'text-muted-foreground/60',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold',
                  active && 'bg-accent text-accent-foreground',
                  done && !active && 'bg-muted/40 text-foreground',
                  !active && !done && 'bg-muted/20 text-muted-foreground',
                )}
              >
                {done && !active ? (
                  <Check className="h-3 w-3" />
                ) : isImportStep && step === 'progress' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : isImportStep && step === 'result' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  index + 1
                )}
              </span>
              {label}
            </span>
          </React.Fragment>
        )
      })}
    </nav>
  )
}

const ImportFlowFooter: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="mt-4 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/30 pt-4"
    data-testid="external-import-footer"
  >
    {children}
  </div>
)

export const ExternalImportFlow: React.FC = () => {
  const identity = useImportIdentity()
  const job = useImportJobStore()
  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const targetOrgId = selectedOrganizationId ?? identity.defaultOrganizationId

  const [step, setStep] = useState<WizardStep>('platform')
  const [range, setRange] = useState<RangeKey>('30d')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [platforms, setPlatforms] = useState<PlatformNode[]>([])
  /** 本机有痕迹但 sessionCount=0（或索引打不开）——步骤 1 灰显，避免「装了却看不见」 */
  const [presentEmpty, setPresentEmpty] = useState<ImportDetectResult[]>([])
  const [selectedSources, setSelectedSources] = useState<Set<ImportSourceId>>(new Set())
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [redact, setRedact] = useState(true)
  const [starting, setStarting] = useState(false)
  const [confirmingRollback, setConfirmingRollback] = useState(false)

  const scanToken = useRef(0)
  const firstLoadRef = useRef(true)

  // key → session ref（构造 run 载荷）+ key → 归一 cwd（工作空间计数/映射）。
  const keyIndex = useMemo(() => {
    const m = new Map<string, { ref: ImportSessionRef; normCwd: string | null }>()
    for (const p of platforms) {
      for (const ws of p.workspaces) {
        for (const s of ws.sessions) {
          m.set(sessionKey(s), { ref: s, normCwd: ws.isOrphan ? null : lexicalNormalize(ws.cwd) })
        }
      }
    }
    return m
  }, [platforms])

  // 进入导入页：idle → 新导入从 platform 开始；进行中/终态 → 恢复到对应步骤。
  useEffect(() => {
    if (job.state === 'idle') {
      firstLoadRef.current = true
      setStep('platform')
    } else {
      setStep(stepForJobState(job.state))
    }
  }, [job.state])

  useEffect(() => {
    if (!targetOrgId) return
    void identity.ensureSpacesLoaded(targetOrgId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetOrgId])

  const loadPreview = useCallback(
    async (rangeKey: RangeKey) => {
      const api = window.tabtin?.import
      if (!api) {
        setScanError('导入服务尚未就绪，请稍后重试')
        return
      }
      const token = ++scanToken.current
      setScanning(true)
      setScanError(null)
      try {
        const detectOut = await api.detect()
        const allDetected = detectOut.sources ?? []
        const activeSources = allDetected.filter(
          (s: ImportDetectResult) => s.installed && s.sessionCount > 0,
        )
        // 装了/有库但无可导入：带「有痕迹」类 note（排除「目录/DB 不存在」未安装提示）
        setPresentEmpty(
          allDetected.filter((s: ImportDetectResult) => {
            if (activeSources.some((a) => a.source === s.source)) return false
            const note = s.note ?? ''
            if (!note || /不存在/.test(note)) return false
            // WorkBuddy 等：note 用「尚无可导入」；其它源可能用「暂无可导入」
            return /[暂尚]无可导入|无可导入的历史|计数为 0|读取失败|超时|版本不兼容/.test(note)
          }),
        )
        const since = rangeToSince(rangeKey)
        const nextPlatforms: PlatformNode[] = []

        for (const src of activeSources) {
          const scan = await api.scan({
            source: src.source,
            ...(since ? { since } : {}),
            includeArchived: true,
          })
          if (token !== scanToken.current) return

          // header_only / 无正文层：导入只会得到空档案，预览里直接隐掉
          const withContent = (sessions: typeof scan.workspaces[number]['sessions']) =>
            sessions.filter((s) => s.layer !== 'header_only')

          const workspaces: WsNode[] = scan.workspaces
            .map((ws) => ({
              key: `${src.source}::${lexicalNormalize(ws.cwd)}`,
              source: src.source,
              cwd: ws.cwd,
              cwdExists: ws.cwdExists,
              isOrphan: false,
              sessions: withContent(ws.sessions).sort(byUpdatedDesc),
            }))
            .filter((ws) => ws.sessions.length > 0)
            .sort(compareWorkspacesByLatestDesc)

          const orphanSessions = withContent(scan.orphanSessions)
          if (orphanSessions.length > 0) {
            workspaces.push({
              key: `${src.source}::${ORPHAN_CWD}`,
              source: src.source,
              cwd: '',
              cwdExists: false,
              isOrphan: true,
              sessions: [...orphanSessions].sort(byUpdatedDesc),
            })
          }

          const allSessions = workspaces.flatMap((w) => w.sessions)

          // 保留该平台即使范围内无会话——卡片用全时段计数，用户可在步骤2放宽范围。
          nextPlatforms.push({
            source: src.source,
            detect: src,
            workspaces,
            sessionCount: allSessions.length,
            workspaceCount: workspaces.filter((w) => !w.isOrphan).length,
            allTimeSessionCount: src.sessionCount,
            allTimeWorkspaceCount: src.workspaceCount,
          })
        }

        setPlatforms(nextPlatforms)

        const validKeys = new Set(
          nextPlatforms.flatMap((p) =>
            p.workspaces.flatMap((ws) => isWorkspaceImportable(ws) ? ws.sessions.map(sessionKey) : []),
          ),
        )
        const availSources = new Set(nextPlatforms.map((p) => p.source))

        if (firstLoadRef.current) {
          // 首次：平台入选，会话不预勾——避免「只勾一个目录」时其它平台默认全选虚高。
          // 勾选靠步骤 2 的目录树 / 全选 / 「只导一个试试」。
          firstLoadRef.current = false
          setSelectedSources(new Set(nextPlatforms.map((p) => p.source)))
          setSelectedKeys(new Set())
        } else {
          // 切范围重扫：保留用户既有选择（对新结果求交集），不覆盖平台层、不重置勾选。
          setSelectedSources((prev) => new Set([...prev].filter((s) => availSources.has(s))))
          setSelectedKeys((prev) => new Set([...prev].filter((k) => validKeys.has(k))))
        }
      } catch (err) {
        if (token !== scanToken.current) return
        setScanError(err instanceof Error ? err.message : String(err))
      } finally {
        if (token === scanToken.current) setScanning(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (step !== 'platform' && step !== 'content') return
    void loadPreview(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  useEffect(() => {
    if (step !== 'progress') return
    if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'error') {
      setStep('result')
    }
  }, [job.state, step])

  const visiblePlatforms = useMemo(
    () => platforms.filter((p) => selectedSources.has(p.source)),
    [platforms, selectedSources],
  )

  // 搜索时把命中的 workspace 自动展开（加入 expanded；用户仍可手动收起——收起=从
  // expanded 删除，本 effect 仅在 search/platforms 变化时补齐，不会与手动收起打架）。
  useEffect(() => {
    const f = search.trim().toLowerCase()
    if (!f) return
    const keys: string[] = []
    for (const p of visiblePlatforms) for (const ws of p.workspaces) if (wsMatchesSearch(ws, f)) keys.push(ws.key)
    if (keys.length) setExpanded((prev) => new Set([...prev, ...keys]))
  }, [search, visiblePlatforms])

  const selectableKeys = useMemo(
    () => new Set(
      platforms.flatMap((p) =>
        p.workspaces.flatMap((ws) => isWorkspaceImportable(ws) ? ws.sessions.map(sessionKey) : []),
      ),
    ),
    [platforms],
  )
  const selectedCount = useMemo(
    () => [...selectedKeys].filter((key) => selectableKeys.has(key)).length,
    [selectedKeys, selectableKeys],
  )

  // 预算三态：随 platforms/selectedKeys 变化才重算，渲染时 O(1) 查。
  const wsStateMap = useMemo(() => {
    const m = new Map<string, SelState>()
    for (const p of platforms) {
      for (const ws of p.workspaces) {
        if (!isWorkspaceImportable(ws)) {
          m.set(ws.key, 'none')
          continue
        }
        let sel = 0
        for (const s of ws.sessions) if (selectedKeys.has(sessionKey(s))) sel++
        m.set(ws.key, sel === 0 ? 'none' : sel === ws.sessions.length ? 'all' : 'some')
      }
    }
    return m
  }, [platforms, selectedKeys])

  const platformStateMap = useMemo(() => {
    const m = new Map<ImportSourceId, SelState>()
    for (const p of platforms) {
      let total = 0
      let sel = 0
      for (const ws of p.workspaces) {
        if (!isWorkspaceImportable(ws)) continue
        for (const s of ws.sessions) {
          total++
          if (selectedKeys.has(sessionKey(s))) sel++
        }
      }
      m.set(p.source, sel === 0 ? 'none' : total > 0 && sel === total ? 'all' : 'some')
    }
    return m
  }, [platforms, selectedKeys])

  // 预算已有工作空间匹配：随 platforms / spaces / 目标组织变化才重算。
  const matchMap = useMemo(() => {
    const m = new Map<string, ExistingWorkspaceMatch>()
    for (const p of platforms) {
      for (const ws of p.workspaces) {
        if (!ws.isOrphan) m.set(ws.key, identity.matchExistingWorkspace(ws.cwd, targetOrgId))
      }
    }
    return m
  }, [platforms, identity, targetOrgId])

  // 确认页：真实落地工作空间数（exact/prefix 按目标去重，new 按 normCwd 去重，
  // orphan 归"默认工作空间"——已存在，不计新建）。
  const { selectedWorkspaceCount, newWorkspaceCount } = useMemo(() => {
    const targets = new Set<string>()
    let newCount = 0
    let hasOrphan = false
    const cwdSeen = new Set<string>()
    for (const key of selectedKeys) {
      if (!selectableKeys.has(key)) continue
      const meta = keyIndex.get(key)
      if (!meta) continue
      if (meta.normCwd === null) {
        hasOrphan = true
        continue
      }
      if (cwdSeen.has(meta.normCwd)) continue
      cwdSeen.add(meta.normCwd)
      const match = identity.matchExistingWorkspace(meta.normCwd, targetOrgId)
      if (match.kind === 'new') {
        if (!targets.has('new:' + meta.normCwd)) {
          targets.add('new:' + meta.normCwd)
          newCount++
        }
      } else {
        targets.add('exist:' + (match.name ?? meta.normCwd))
      }
    }
    return {
      selectedWorkspaceCount: targets.size + (hasOrphan ? 1 : 0),
      newWorkspaceCount: newCount,
    }
  }, [selectedKeys, selectableKeys, keyIndex, identity, targetOrgId])

  // ── 选择操作 ────────────────────────────────────────────────────────────

  const toggleSource = useCallback(
    (source: ImportSourceId) => {
      const p = platforms.find((x) => x.source === source)
      const turningOn = !selectedSources.has(source)
      setSelectedSources((prev) => {
        const next = new Set(prev)
        if (turningOn) next.add(source)
        else next.delete(source)
        return next
      })
      if (!p || turningOn) return
      // 取消平台时清掉该平台已勾会话；重新勾选平台不自动全选（步骤 2 显式勾选）。
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        for (const ws of p.workspaces) for (const s of ws.sessions) next.delete(sessionKey(s))
        return next
      })
    },
    [platforms, selectedSources],
  )

  const toggleWorkspace = useCallback(
    (ws: WsNode) => {
      if (!isWorkspaceImportable(ws)) return
      const state = wsStateMap.get(ws.key) ?? 'none'
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        if (state === 'all') for (const s of ws.sessions) next.delete(sessionKey(s))
        else for (const s of ws.sessions) next.add(sessionKey(s))
        return next
      })
    },
    [wsStateMap],
  )

  const togglePlatformAll = useCallback(
    (p: PlatformNode) => {
      const state = platformStateMap.get(p.source) ?? 'none'
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        const allKeys = p.workspaces.flatMap((ws) =>
          isWorkspaceImportable(ws) ? ws.sessions.map(sessionKey) : [],
        )
        if (state === 'all') for (const k of allKeys) next.delete(k)
        else for (const k of allKeys) next.add(k)
        return next
      })
    },
    [platformStateMap],
  )

  const toggleSessionKey = useCallback((key: string) => {
    if (!selectableKeys.has(key)) return
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [selectableKeys])

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const selectAllForPlatform = useCallback((platform: PlatformNode, on: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      for (const ws of platform.workspaces) {
        if (!isWorkspaceImportable(ws)) continue
        for (const s of ws.sessions) {
          if (on) next.add(sessionKey(s))
          else next.delete(sessionKey(s))
        }
      }
      return next
    })
  }, [])

  /** 只导一个试试：清空全部平台勾选，只留当前平台最近活跃的一个工作目录。 */
  const handleTryOneForPlatform = useCallback((platform: PlatformNode) => {
    let best: WsNode | null = null
    let bestTs = -1
    for (const ws of platform.workspaces) {
      if (ws.isOrphan || !ws.cwdExists) continue
      const ts = Date.parse(ws.sessions[0]?.updatedAt ?? '') || 0
      if (ts > bestTs) {
        bestTs = ts
        best = ws
      }
    }
    best = best ?? platform.workspaces.find(isWorkspaceImportable) ?? null
    if (!best) return
    const next = new Set<string>()
    for (const s of best.sessions) {
      if (!s.archived) next.add(sessionKey(s))
    }
    setSelectedKeys(next)
    setExpanded((prev) => new Set([...prev, best.key]))
  }, [])

  const handleStart = useCallback(async () => {
    if (!targetOrgId) {
      toast({ title: '未识别到目标组织，请稍后重试', variant: 'destructive' })
      return
    }
    const deviceId = identity.deviceId
    if (!deviceId) {
      toast({ title: '正在识别本机执行设备，请稍后再试', variant: 'destructive' })
      return
    }
    const agentId = identity.resolveAgentId(targetOrgId)
    if (!agentId) {
      toast({
        title: '未能识别执行 Agent（小Tin），请先在该组织创建一个工作空间后重试',
        variant: 'destructive',
      })
      return
    }

    const bySource = new Map<ImportSourceId, ImportSessionRef[]>()
    for (const key of selectedKeys) {
      if (!selectableKeys.has(key)) continue
      const meta = keyIndex.get(key)
      if (!meta) continue
      const arr = bySource.get(meta.ref.source) ?? []
      arr.push(meta.ref)
      bySource.set(meta.ref.source, arr)
    }
    if (bySource.size === 0) {
      toast({ title: '请至少勾选一条对话', variant: 'destructive' })
      return
    }

    const input: ImportRunInput = {
      jobId:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `import-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sources: [...bySource.entries()].map(([source, sessionRefs]) => ({ source, sessionRefs })),
      options: {
        ...(rangeToSince(range) ? { since: rangeToSince(range) } : {}),
        redact,
        targetOrganizationId: targetOrgId,
        agentId,
        deviceId,
      },
    }

    setStarting(true)
    try {
      setStep('progress')
      await job.startJob(input)
    } finally {
      setStarting(false)
    }
  }, [targetOrgId, identity, selectedKeys, selectableKeys, keyIndex, range, redact, job])

  const leaveImportPage = useCallback(() => {
    setConfirmingRollback(false)
    // 后台导入中：离开页面不 reset，右下角进度面板继续。
    if (job.state === 'running') {
      useAppPageStore.getState().closeAppPage()
      return
    }
    // 终态（完成/取消/失败）：保留 job 供重进看结果 / rollback；仅 idle 时清步骤。
    if (job.state === 'idle') setStep('platform')
    useAppPageStore.getState().closeAppPage()
  }, [job.state])

  const handleFinish = useCallback(() => {
    job.reset()
    setStep('platform')
    setConfirmingRollback(false)
    useAppPageStore.getState().closeAppPage()
  }, [job])

  const handleRollback = useCallback(async () => {
    setConfirmingRollback(false)
    try {
      const res = await job.rollbackLast()
      if (res) {
        toast({
          title: `已移除本次导入：删除 ${res.deletedSessions} 个会话、${res.deletedMessages} 条消息`,
        })
      }
    } catch (err) {
      toast({
        title: `移除失败：${err instanceof Error ? err.message : String(err)}`,
        variant: 'destructive',
      })
    }
  }, [job])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="external-import-flow">
      <ImportStepper step={step} />

      {step === 'platform' && <ImportReadOnlyDiagram />}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === 'platform' && (
          <PlatformStep
            scanning={scanning}
            scanError={scanError}
            platforms={platforms}
            presentEmpty={presentEmpty}
            selectedSources={selectedSources}
            onToggleSource={toggleSource}
          />
        )}

        {step === 'content' && (
          <ContentStep
            range={range}
            onRangeChange={setRange}
            scanning={scanning}
            platforms={visiblePlatforms}
            search={search}
            onSearchChange={setSearch}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            selectedKeys={selectedKeys}
            wsStateMap={wsStateMap}
            platformStateMap={platformStateMap}
            matchMap={matchMap}
            onToggleWorkspace={toggleWorkspace}
            onTogglePlatformAll={togglePlatformAll}
            onToggleSessionKey={toggleSessionKey}
            onSelectAllForPlatform={selectAllForPlatform}
            onTryOneForPlatform={handleTryOneForPlatform}
            selectedCount={selectedCount}
            redact={redact}
            onRedactChange={setRedact}
          />
        )}

        {(step === 'progress' || step === 'result') && <ProgressResult step={step} />}
      </div>

      <ImportFlowFooter>
        {step === 'platform' && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={leaveImportPage}>
              返回
            </Button>
            <Button
              onClick={() => setStep('content')}
              disabled={scanning || selectedSources.size === 0}
              className="bg-accent hover:bg-accent/90"
            >
              下一步
            </Button>
          </div>
        )}
        {step === 'content' && (
          <>
            <ImportWorkspaceFooterSummary
              selectedWorkspaceCount={selectedWorkspaceCount}
              newWorkspaceCount={newWorkspaceCount}
              className="mr-auto min-w-0 flex-1 basis-full sm:basis-auto sm:max-w-lg"
            />
            <Button variant="outline" onClick={() => setStep('platform')}>
              上一步
            </Button>
            <Button
              onClick={handleStart}
              disabled={scanning || selectedCount === 0 || starting}
              className="gap-1.5 bg-accent hover:bg-accent/90"
            >
              {starting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <DownloadCloud className="h-4 w-4" />
              )}
              开始导入（{selectedCount} 条对话）
            </Button>
          </>
        )}
        {step === 'progress' && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={leaveImportPage}>
              后台继续
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void job.cancel()
              }}
              disabled={job.state !== 'running'}
            >
              取消导入
            </Button>
          </div>
        )}
        {step === 'result' &&
          (confirmingRollback ? (
            <>
              <span className="mr-auto text-caption text-muted-foreground/80">
                将永久删除本次导入的对话及其消息，不可恢复。
              </span>
              <Button variant="outline" onClick={() => setConfirmingRollback(false)}>
                取消
              </Button>
              <Button
                onClick={handleRollback}
                className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                <RotateCcw className="h-4 w-4" />
                确认移除
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => setConfirmingRollback(true)}
                disabled={job.rolledBack || !job.jobId}
                className="gap-1.5 text-destructive hover:text-destructive"
              >
                <RotateCcw className="h-4 w-4" />
                {job.rolledBack ? '已移除本次导入' : '移除本次导入'}
              </Button>
              <Button onClick={handleFinish} className="bg-accent hover:bg-accent/90">
                完成
              </Button>
            </>
          ))}
      </ImportFlowFooter>
    </div>
  )
}

/** @deprecated 使用 ExternalImportFlow + ExternalImportPanel */
export const ExternalImportWizard = ExternalImportFlow

// ─── 步骤 1：选择来源平台 ────────────────────────────────────────────────────

const PlatformStep: React.FC<{
  scanning: boolean
  scanError: string | null
  platforms: PlatformNode[]
  presentEmpty: ImportDetectResult[]
  selectedSources: Set<ImportSourceId>
  onToggleSource: (s: ImportSourceId) => void
}> = ({ scanning, scanError, platforms, presentEmpty, selectedSources, onToggleSource }) => (
  <div className="space-y-3 py-2">
    {scanning && platforms.length === 0 && presentEmpty.length === 0 && (
      <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在扫描本地会话…
      </div>
    )}

    {scanError && (
      <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-caption text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>扫描失败：{scanError}</span>
      </div>
    )}

    {!scanning && !scanError && platforms.length === 0 && presentEmpty.length === 0 && (
      <div className="py-10 text-center text-caption text-muted-foreground/80">
        没有检测到可导入的历史会话。
      </div>
    )}

    <div className="space-y-2">
      {platforms.map((p) => {
        const meta = SOURCE_META[p.source]
        const Icon = meta?.Icon ?? MessageSquare
        const active = selectedSources.has(p.source)
        return (
          <div
            key={p.source}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            onClick={() => onToggleSource(p.source)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggleSource(p.source)
              }
            }}
            className={cn(
              'flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              active ? 'border-accent/60 bg-accent/5' : 'border-border/60 hover:border-border hover:bg-muted/20',
            )}
          >
            <ImportSourceIcon
              source={p.source}
              FallbackIcon={Icon}
              fallbackTint={meta?.tint}
              fallbackChip={meta?.chip}
              className="h-9 w-9 shrink-0 rounded-lg"
              iconClassName="h-5 w-5"
            />
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-foreground">{sourceLabel(p.source)}</div>
              <div className="mt-0.5 text-caption text-muted-foreground/80">
                {p.allTimeWorkspaceCount} 个工作目录 · {p.allTimeSessionCount} 条对话
                {p.detect?.newestActivityAt ? ` · 最近活跃 ${relativeTime(p.detect.newestActivityAt)}` : ''}
              </div>
            </div>
            <TriCheckbox state={active ? 'all' : 'none'} presentational className="shrink-0" />
          </div>
        )
      })}

      {presentEmpty.map((s) => {
        const meta = SOURCE_META[s.source]
        const Icon = meta?.Icon ?? MessageSquare
        return (
          <div
            key={s.source}
            aria-disabled
            className="flex w-full items-center gap-3 rounded-xl border border-border/40 bg-muted/10 px-3.5 py-3 text-left opacity-70"
          >
            <ImportSourceIcon
              source={s.source}
              FallbackIcon={Icon}
              fallbackTint={meta?.tint}
              fallbackChip={meta?.chip}
              className="h-9 w-9 shrink-0 rounded-lg grayscale"
              iconClassName="h-5 w-5"
            />
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-muted-foreground">{sourceLabel(s.source)}</div>
              <div className="mt-0.5 text-caption text-muted-foreground/70">
                {s.note ?? '已检测到安装痕迹，但暂无可导入的历史对话'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  </div>
)

// ─── 步骤 2：内容树（workspace → 对话）──────────────────────────────────────

const WorkspaceMatchLabel: React.FC<{ match: ExistingWorkspaceMatch }> = ({ match }) => {
  if (match.kind === 'new') {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-muted-foreground/80">
        <FolderPlus className="h-3 w-3" />
        将新建工作空间
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-caption text-accent/90"
      title={match.kind === 'prefix' ? '外部目录是该工作空间的子目录，会合流进去' : undefined}
    >
      <FolderGit2 className="h-3 w-3" />
      合流到「{match.name}」
      {match.kind === 'prefix' ? '（子目录）' : ''}
    </span>
  )
}

const SessionRow = React.memo<{
  sessionKey: string
  title: string
  subagent: boolean
  archived: boolean
  updatedAt: string
  checked: boolean
  disabled?: boolean
  onToggle: (key: string) => void
}>(({ sessionKey: sk, title, subagent, archived, updatedAt, checked, disabled = false, onToggle }) => {
  return (
    <div className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 pl-9', disabled ? 'text-muted-foreground/60' : 'hover:bg-muted/20')}>
      <TriCheckbox
        state={checked ? 'all' : 'none'}
        disabled={disabled}
        onChange={() => onToggle(sk)}
        aria-label={disabled ? `${title || '未命名会话'}，目录已不存在，无法导入` : title || '未命名会话'}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle(sk)}
        className={cn('min-w-0 flex-1 truncate text-left text-caption', disabled ? 'cursor-not-allowed text-muted-foreground/60' : 'text-foreground/90')}
        title={title}
      >
        {title || '（无标题会话）'}
        {subagent && <span className="ml-1.5 text-caption text-muted-foreground/60">子会话</span>}
        {archived && <span className="ml-1.5 text-caption text-muted-foreground/60">已归档</span>}
      </button>
      <span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted-foreground/60">
        <Clock className="h-3 w-3" />
        {relativeTime(updatedAt)}
      </span>
    </div>
  )
})
SessionRow.displayName = 'SessionRow'

const WorkspaceTreeRow: React.FC<{
  ws: WsNode
  state: SelState
  expanded: boolean
  nameMatched: boolean
  filter: string
  selectedKeys: Set<string>
  onToggleExpand: (key: string) => void
  onToggleWorkspace: (ws: WsNode) => void
  onToggleSessionKey: (key: string) => void
  match: ExistingWorkspaceMatch
}> = ({ ws, state, expanded, nameMatched, filter, selectedKeys, onToggleExpand, onToggleWorkspace, onToggleSessionKey, match }) => {
  const [showAll, setShowAll] = useState(false)
  const importable = isWorkspaceImportable(ws)
  // 项目名命中搜索时展示全部会话；否则按标题过滤（修：搜项目名不再"无匹配对话"）。
  const filtered = filter && !nameMatched ? ws.sessions.filter((s) => (s.title || '').toLowerCase().includes(filter)) : ws.sessions
  const shown = showAll ? filtered : filtered.slice(0, SESSION_PAGE)
  const label = ws.isOrphan ? '目录已不存在的零散会话' : basename(ws.cwd)

  return (
    <div>
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-muted/15">
        <button
          type="button"
          onClick={() => onToggleExpand(ws.key)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted/40 hover:text-foreground"
          aria-label={expanded ? '收起' : '展开'}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <TriCheckbox
          state={state}
          disabled={!importable}
          onChange={() => onToggleWorkspace(ws)}
          aria-label={!importable ? `${label}，目录已不存在，无法导入` : `选择项目 ${label}`}
        />
        <button type="button" onClick={() => onToggleExpand(ws.key)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className={cn('truncate text-caption', ws.isOrphan ? 'text-foreground/90' : 'font-medium text-foreground')} title={ws.cwd || label}>
              {label}
            </span>
            {!ws.isOrphan && !ws.cwdExists && (
              <span className="shrink-0 rounded bg-muted/40 px-1.5 py-0.5 text-caption text-muted-foreground">
                目录已不存在，无法导入
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="text-caption text-muted-foreground/80">{ws.sessions.length} 条对话</span>
            {ws.sessions[0]?.updatedAt ? (
              <span className="inline-flex items-center gap-1 text-caption text-muted-foreground/60">
                <Clock className="h-3 w-3" />
                {relativeTime(ws.sessions[0].updatedAt)}
              </span>
            ) : null}
            {ws.isOrphan ? (
              <span className="inline-flex items-center gap-1 text-caption text-muted-foreground/60">
                <FolderPlus className="h-3 w-3" />
                归入「默认工作空间」
              </span>
            ) : ws.cwdExists ? (
              <WorkspaceMatchLabel match={match} />
            ) : null}
          </div>
        </button>
      </div>

      {expanded && (
        <div className="mb-1">
          {shown.map((s) => (
            <SessionRow
              key={sessionKey(s)}
              sessionKey={sessionKey(s)}
              title={s.title}
              subagent={s.subagent}
              archived={s.archived}
              updatedAt={s.updatedAt}
              checked={importable && selectedKeys.has(sessionKey(s))}
              disabled={!importable}
              onToggle={onToggleSessionKey}
            />
          ))}
          {filtered.length > shown.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="pl-9 py-1 text-caption text-accent hover:text-accent/80"
            >
              显示全部 {filtered.length} 条
            </button>
          )}
          {filtered.length === 0 && <div className="pl-9 py-1 text-caption text-muted-foreground/60">无匹配对话</div>}
        </div>
      )}
    </div>
  )
}

function countSelectedForPlatform(platform: PlatformNode, selectedKeys: Set<string>): number {
  let count = 0
  for (const ws of platform.workspaces) {
    if (!isWorkspaceImportable(ws)) continue
    for (const s of ws.sessions) {
      if (selectedKeys.has(sessionKey(s))) count++
    }
  }
  return count
}

const ImportSecurityOption: React.FC<{
  redact: boolean
  onRedactChange: (v: boolean) => void
}> = ({ redact, onRedactChange }) => (
  <section className="mt-3 shrink-0 rounded-lg border border-border/50 bg-muted/5 px-3 py-2.5 space-y-2">
    <div className="flex items-center gap-1.5 text-caption font-medium text-foreground">
      <ShieldCheck className="h-3.5 w-3.5 text-success" />
      安全
    </div>
    <label className="flex cursor-pointer items-start gap-2">
      <Checkbox
        checked={redact}
        onCheckedChange={(v) => onRedactChange(v === true)}
        className="mt-0.5"
      />
      <span className="text-caption leading-snug text-foreground/90">对疑似密钥 / 凭据默认打码</span>
    </label>
    <p className="text-[11px] leading-snug text-muted-foreground/70">
      登录凭据类文件（token、cookie、密钥文件）一律不读取。
    </p>
  </section>
)

const ImportWorkspaceFooterSummary: React.FC<{
  selectedWorkspaceCount: number
  newWorkspaceCount: number
  className?: string
}> = ({ selectedWorkspaceCount, newWorkspaceCount, className }) => {
  const mergeCount = Math.max(0, selectedWorkspaceCount - newWorkspaceCount)
  const detail =
    selectedWorkspaceCount > 0 && (newWorkspaceCount > 0 || mergeCount > 0)
      ? `（${[newWorkspaceCount > 0 ? `${newWorkspaceCount} 个新建` : null, mergeCount > 0 ? `${mergeCount} 个合流` : null]
          .filter(Boolean)
          .join('，')}）`
      : ''

  return (
    <div className={cn('min-w-0 text-left', className)} data-testid="import-workspace-footer-summary">
      <p className="flex items-start gap-1.5 text-caption leading-snug text-muted-foreground/85">
        <FolderPlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          {selectedWorkspaceCount === 0 ? (
            '勾选下方工作目录或对话后，将显示会归入几个工作空间'
          ) : (
            <>
              所选对话将归入 <span className="text-foreground/90">{selectedWorkspaceCount}</span> 个工作空间
              {detail}
            </>
          )}
        </span>
      </p>
      <p className="mt-0.5 pl-5 text-[11px] leading-snug text-muted-foreground/60">
        本次导入不授予 Agent 目录执行权限，开始干活时再单独确认信任。数字含所有已选平台，不只看当前列表。
      </p>
    </div>
  )
}

const ContentStep: React.FC<{
  range: RangeKey
  onRangeChange: (r: RangeKey) => void
  scanning: boolean
  platforms: PlatformNode[]
  search: string
  onSearchChange: (v: string) => void
  expanded: Set<string>
  onToggleExpand: (key: string) => void
  selectedKeys: Set<string>
  wsStateMap: Map<string, SelState>
  platformStateMap: Map<ImportSourceId, SelState>
  matchMap: Map<string, ExistingWorkspaceMatch>
  onToggleWorkspace: (ws: WsNode) => void
  onTogglePlatformAll: (p: PlatformNode) => void
  onToggleSessionKey: (key: string) => void
  onSelectAllForPlatform: (platform: PlatformNode, on: boolean) => void
  onTryOneForPlatform: (platform: PlatformNode) => void
  selectedCount: number
  redact: boolean
  onRedactChange: (v: boolean) => void
}> = ({
  range,
  onRangeChange,
  scanning,
  platforms,
  search,
  onSearchChange,
  expanded,
  onToggleExpand,
  selectedKeys,
  wsStateMap,
  platformStateMap,
  matchMap,
  onToggleWorkspace,
  onTogglePlatformAll,
  onToggleSessionKey,
  onSelectAllForPlatform,
  onTryOneForPlatform,
  selectedCount,
  redact,
  onRedactChange,
}) => {
  const filter = search.trim().toLowerCase()
  const [activeSource, setActiveSource] = useState<ImportSourceId | null>(null)

  useEffect(() => {
    if (platforms.length === 0) {
      setActiveSource(null)
      return
    }
    if (!activeSource || !platforms.some((p) => p.source === activeSource)) {
      setActiveSource(platforms[0]?.source ?? null)
    }
  }, [platforms, activeSource])

  const activePlatform = useMemo(
    () => platforms.find((p) => p.source === activeSource) ?? platforms[0] ?? null,
    [platforms, activeSource],
  )

  const activeWorkspaces = useMemo(
    () => (activePlatform ? activePlatform.workspaces.filter((ws) => wsMatchesSearch(ws, filter)) : []),
    [activePlatform, filter],
  )

  const activePlatformSelected = activePlatform
    ? countSelectedForPlatform(activePlatform, selectedKeys)
    : 0

  return (
    <div className="flex min-h-[420px] flex-col gap-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <span className="text-caption text-muted-foreground/80">范围</span>
          {RANGE_OPTIONS.map((opt) => {
            const active = range === opt.key
            return (
              <button
                key={opt.key}
                type="button"
                aria-pressed={active}
                onClick={() => onRangeChange(opt.key)}
                className={cn(
                  'rounded-md px-2 py-0.5 text-caption transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground/80 hover:bg-muted/40',
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        <div className="relative ml-auto min-w-[160px] flex-1 sm:flex-none">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索工作目录 / 对话标题"
            aria-label="搜索工作目录或对话标题"
            className="w-full rounded-md border border-border/60 bg-background py-1 pl-7 pr-2 text-caption text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-accent/60"
          />
        </div>
      </div>

      {scanning && (
        <div className="flex flex-1 items-center justify-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在扫描本地会话…
        </div>
      )}

      {!scanning && platforms.length === 0 && (
        <div className="flex flex-1 items-center justify-center py-8 text-center text-caption text-muted-foreground/80">
          没有可导入的对话。回上一步确认已选择来源平台。
        </div>
      )}

      {!scanning && platforms.length > 0 && activePlatform && (
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60">
          <nav
            className="flex w-[148px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/40 bg-muted/10 p-1.5 sm:w-[160px]"
            role="tablist"
            aria-label="导入来源平台"
          >
            {platforms.map((p) => {
              const meta = SOURCE_META[p.source]
              const Icon = meta?.Icon ?? MessageSquare
              const active = p.source === activePlatform.source
              const selectedInPlatform = countSelectedForPlatform(p, selectedKeys)
              const pState = platformStateMap.get(p.source) ?? 'none'
              return (
                <button
                  key={p.source}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveSource(p.source)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                    active
                      ? 'bg-background shadow-sm ring-1 ring-border/50'
                      : 'text-muted-foreground/85 hover:bg-background/50 hover:text-foreground',
                  )}
                >
                  <ImportSourceIcon
                    source={p.source}
                    FallbackIcon={Icon}
                    fallbackTint={meta?.tint}
                    fallbackChip={meta?.chip}
                    className="h-7 w-7 shrink-0 rounded-md"
                    iconClassName="h-4 w-4"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-caption font-medium leading-tight text-foreground">
                      {sourceLabel(p.source)}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground/70">
                      {selectedInPlatform > 0 ? `已选 ${selectedInPlatform}` : `${p.sessionCount} 条`}
                    </span>
                  </span>
                  {pState !== 'none' ? (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        pState === 'all' ? 'bg-accent' : 'bg-accent/50',
                      )}
                      aria-hidden
                    />
                  ) : null}
                </button>
              )
            })}
          </nav>

          <div
            className="flex min-w-0 flex-1 flex-col"
            role="tabpanel"
            aria-label={sourceLabel(activePlatform.source)}
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-border/40 bg-muted/5 px-3 py-2">
              <TriCheckbox
                state={platformStateMap.get(activePlatform.source) ?? 'none'}
                onChange={() => onTogglePlatformAll(activePlatform)}
                aria-label={`选择全部 ${sourceLabel(activePlatform.source)}`}
              />
              <ImportSourceIcon
                source={activePlatform.source}
                FallbackIcon={SOURCE_META[activePlatform.source]?.Icon ?? MessageSquare}
                fallbackTint={SOURCE_META[activePlatform.source]?.tint}
                fallbackChip={SOURCE_META[activePlatform.source]?.chip}
                className="h-5 w-5 rounded"
                iconClassName="h-4 w-4"
              />
              <span className="text-caption font-medium text-foreground">{sourceLabel(activePlatform.source)}</span>
              <span className="text-caption text-muted-foreground/60">
                {activePlatform.workspaceCount} 个工作目录 · {activePlatform.sessionCount} 条对话
              </span>
              <div className="ml-auto flex items-center gap-2 text-caption">
                <button
                  type="button"
                  onClick={() => onSelectAllForPlatform(activePlatform, true)}
                  className="text-accent hover:text-accent/80"
                >
                  全选
                </button>
                <button
                  type="button"
                  onClick={() => onSelectAllForPlatform(activePlatform, false)}
                  className="text-muted-foreground/80 hover:text-foreground"
                >
                  全不选
                </button>
                <button
                  type="button"
                  onClick={() => onTryOneForPlatform(activePlatform)}
                  className="text-muted-foreground/80 hover:text-foreground"
                  title="选中该平台最近活跃的一个工作目录"
                >
                  只导一个试试
                </button>
                <span className="text-muted-foreground/60">
                  本平台 {activePlatformSelected} · 共 {selectedCount}
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {activePlatform.sessionCount === 0 ? (
                <div className="px-3 py-6 text-center text-caption text-muted-foreground/60">
                  该范围内无对话，试试放宽上方时间范围。
                </div>
              ) : activeWorkspaces.length === 0 ? (
                <div className="px-3 py-6 text-center text-caption text-muted-foreground/60">无匹配工作目录</div>
              ) : (
                activeWorkspaces.map((ws) => (
                  <WorkspaceTreeRow
                    key={ws.key}
                    ws={ws}
                    state={wsStateMap.get(ws.key) ?? 'none'}
                    expanded={expanded.has(ws.key)}
                    nameMatched={wsNameMatches(ws, filter)}
                    filter={filter}
                    selectedKeys={selectedKeys}
                    onToggleExpand={onToggleExpand}
                    onToggleWorkspace={onToggleWorkspace}
                    onToggleSessionKey={onToggleSessionKey}
                    match={
                      ws.isOrphan
                        ? { name: null, kind: 'new' }
                        : matchMap.get(ws.key) ?? { name: null, kind: 'new' }
                    }
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {!scanning && platforms.length > 0 && (
        <ImportSecurityOption redact={redact} onRedactChange={onRedactChange} />
      )}
    </div>
  )
}

// ─── 步骤 3：进度 + 结果 ──────────────────────────────────────────────────────

const ProgressResult: React.FC<{ step: WizardStep }> = ({ step }) => {
  const job = useImportJobStore()
  const pct = job.overall.total > 0 ? Math.round((job.overall.done / job.overall.total) * 100) : 0

  if (step === 'progress') {
    return (
      <div className="space-y-3 py-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-caption text-muted-foreground/80">
            <span>
              {job.currentWorkspace ? `正在处理：${job.currentWorkspace}` : '正在准备导入…'}
              {job.phase ? `（${job.phase}）` : ''}
            </span>
            <span>
              {job.overall.done} / {job.overall.total}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted/30">
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
        {job.seenWorkspaces.length > 0 && (
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-muted/10 px-2 py-1.5">
            {job.seenWorkspaces.map((w) => (
              <div key={w} className="truncate font-mono text-caption text-muted-foreground/80">
                {w}
              </div>
            ))}
          </div>
        )}
        <p className="text-caption text-muted-foreground/60">
          导入在后台进行，你可以离开此页继续使用 TabTin，进度会保留在右下角面板。
        </p>
      </div>
    )
  }

  const report = job.report

  // 取消：中性态（非失败），展示已导入的部分。
  if (job.state === 'cancelled') {
    const done = report ? report.visible + report.archived + report.titleOnly : job.overall.done
    return (
      <div className="space-y-3 py-4">
        <div className="flex items-start gap-2 rounded-md bg-muted/25 px-3 py-2.5 text-caption text-foreground/90">
          <Ban className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
          <span>
            已取消导入。取消前已写入本机档案约 {done} 条对话（不上云）；如不需要，可用下方「移除本次导入」清除本机档案。
          </span>
        </div>
        {report && done > 0 && (
          <p className="text-caption text-muted-foreground/80">取消前已写入本机档案约 {done} 条。</p>
        )}
      </div>
    )
  }

  if (job.state === 'error' || !report) {
    return (
      <div className="py-6">
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2.5 text-caption text-destructive">
          <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>导入未能完成{job.error ? `：${job.error}` : ''}。你可以稍后从侧栏「导入数据」重试。</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 py-3">
      <div className="flex items-center gap-2 text-body font-medium text-foreground">
        <CheckCircle2 className="h-5 w-5 text-success" />
        已写入本机档案 {report.visible + report.archived + report.titleOnly} 条外部对话
        （特化只读展示，不进普通会话列表；工作空间按常态创建）
      </div>
      <p className="text-caption text-muted-foreground/80">
        外部历史挂在对应工作空间下：点开即以特殊新对话展开（注入全部消息）。
        本地目录与已有工作空间相同时，会合流到该工作空间；同源会话不会重复导入。
      </p>
      {report.failures.length > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-caption text-destructive">查看 {report.failures.length} 条失败明细</summary>
          <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
            {report.failures.map((f, i) => (
              <div key={`${f.source}-${f.sourceSessionId}-${i}`} className="text-caption text-muted-foreground/80">
                <span className="font-medium">{sourceLabel(f.source)}</span> {f.sourceSessionId}：{f.error}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
