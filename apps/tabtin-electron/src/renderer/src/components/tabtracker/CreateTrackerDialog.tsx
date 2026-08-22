/**
 * CreateTrackerDialog — Wave 4 三入口之一(UI 表单)
 *
 * charter v1.8 §4.1 / §6.4：表单不暴露工程术语(cron 表达式/per_run/session_mode/origin)
 * 只暴露 5 档预设 schedule:manual / hourly / daily / weekdays / weekly + --at HH:MM
 *
 * 字段(极简化后):
 *   - Name * (必填)
 *   - Instructions (textarea,任务主体——给 Agent 的详细提示)
 *   - 执行 Space（下拉一项 = 一个 Space；提交时映射 agent_id）
 *   - Schedule (频率 Select + 内联参数：HH:MM / 间隔分钟 / 一次性日期时间；默认 daily)
 *   - 更多选项：列表备注 / 错过策略（默认收起）
 *
 * 布局：名称与执行指令必须拆成两个带标签的独立字段——composer 一体卡
 * 曾让用户误以为只需填一块。调度参数仍用底部 chips（频率 / 时刻 / 执行 Space）。
 * 列表备注 / 错过策略收在「更多选项」。
 *   - 权限：固定底部提示，不是可选项
 *   - 创建后始终启用（后端在同一事务内完成创建与启用，不暴露草稿中间态）
 *
 * 产品决策(2026-06 / 2026-07)：表单不再要求用户填「关联 Skill」，也不暴露「表格触发器」。
 * Tracker 只需 名称 + 指令；执行时指令作为任务派给 Agent。
 * 面板只保留列表视图；对话创建是一等入口（顶栏 + 空态）。
 *
 * 描述(description)：可选、可编辑，收在「更多选项」。详情页只读展示该字段，后端 PUT/POST 均支持；
 *  修复恢复表单输入（ 曾整段删除），创建/编辑均回填并提交。
 *
 * 提交:走 trackerApi.createTask(...) → POST /api/tracker/events
 * 错误:友好提示(无技术术语)
 *
 * Wave 3 schedulePresets 同步:
 *   manual → trigger_type=manual,trigger_config={}
 *   hourly → trigger_type=cron,cron="0 * * * *"
 *   daily → trigger_type=cron,cron="M H * * *"
 *   weekdays → trigger_type=cron,cron="M H * * 1-5"
 *   weekly → trigger_type=cron,cron="M H * * 1"
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, Clock, Folder, Lock } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogScrollBody,
  DialogTitle,
  Button,
  DatePicker,
  Input,
  Label,
  OverlayContainerContext,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TimeSelect,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useTrackerStore } from '@/stores/useTrackerStore'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import type { TrackerTask } from '@/services/trackerApi'
import { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from '@/lib/duplicateNameError'
import { describeTriggerFrequency } from './triggerFrequency'
import {
  buildTrackerCreateViaAgentPrompt,
  requestAgentForTracker,
} from '../context-space/tabtracker/requestAgentForTracker'
import { AgentApiService } from '@tabtin/app-shell'

/**
 * 调度/触发预设。
 *  - manual/hourly/daily/weekdays/weekly：cron 5 档，与 CLI schedulePresets 对齐
 *  - interval：每隔 N 分钟（TS-3）
 *  - at：指定日期时间执行一次（TS-3）
 *
 * 注：table_event（表格触发器）后端仍由 Extension/EventBus 路径支持，但本表单
 * 不再作为创建入口暴露（产品决策 2026-06）。
 */
export type SchedulePreset =
  | 'manual'
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'interval'
  | 'at'

/**
 * 创建弹窗预填值（Cmd+K / 模板画廊共用）。
 * source='template' 时写入 intent_snapshot.template_id / template_version。
 */
export interface CreateTrackerInitialValues {
  name?: string
  instructions?: string
  schedulePreset?: SchedulePreset
  atTime?: string
  timezone?: string
  templateId?: string
  templateVersion?: string
  source?: 'template'
}

export interface CreateTrackerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
  editTracker?: TrackerTask | null
  onCreated?: () => void
  /**
   * 由命令面板/对话快捷预填(Wave 4 Cmd+K 直敲模式)或模板画廊预填。
   * 不传则使用默认值。
   */
  initialValues?: CreateTrackerInitialValues
}

const SCHEDULE_PRESETS: SchedulePreset[] = [
  'manual',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'interval',
  'at',
]

/** 错过策略（离线韧性 M3）：设备关机/服务暂停导致错过原定时间后的行为。 */
type CatchupPolicy = 'run_once' | 'skip'
type CreationSource = 'ui' | 'command_palette' | 'template'

interface TriggerFormState {
  atTime: string
  intervalMinutes: number
  onceAtDateTime: string
  catchupPolicy: CatchupPolicy
  timezone?: string
}

/** 全表单唯一的标签样式：所有字段同一层级、同一节奏，不再区分「区块标题 / 字段标签」两套。 */
function FieldLabel({
  htmlFor,
  children,
  required,
}: {
  htmlFor?: string
  children: React.ReactNode
  required?: boolean
}) {
  return (
    <Label
      htmlFor={htmlFor}
      className="shrink-0 whitespace-nowrap text-body font-medium text-foreground-secondary"
    >
      {children}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </Label>
  )
}

/** 字段块：标签 + 控件 + 可选提示，统一垂直节奏。 */
function FieldBlock({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>
}

/**
 * 弹窗内中性灰：
 *  - 面（SURFACE）：任务卡、备注/Agent 输入井 —— `bg-muted/40`
 *  - 分段控件：对齐侧栏「任务/应用」——轨道 `sidebar-segment-track`（`--muted`），
 *    选中 `sidebar-segment-active`（亮色回 background；深色用 foreground/12% 凸起，
 *    避免 bg-background 与弹窗底糊成一片）
 *  - 小控件 chips：`bg-foreground/[0.05]`
 */
const CONTROL_TRACK_BG = 'bg-foreground/[0.05] dark:bg-foreground/[0.08]'

const SURFACE_FIELD = 'bg-muted/40 focus-visible:bg-muted/60'

/**
 * 任务卡底部参数 chip：Select 触发器与时刻/间隔/日期时间控件统一成
 * 胶囊小控件（h-7 + rounded-full + 控件级中性灰底），与聊天 composer 工具位同语言。
 */
const CHIP_CONTROL = `h-7 rounded-full ${CONTROL_TRACK_BG} px-2.5 py-0 text-body hover:bg-foreground/[0.08] focus:bg-foreground/[0.08] focus:ring-0 focus-visible:bg-foreground/[0.08] focus-visible:ring-0`

/** 分段选项：未选 / 选中（深色对比度对齐侧栏 SidebarTabSwitcher） */
const SEGMENT_OPTION =
  'rounded-md px-2 py-1.5 text-body font-medium transition-colors'
const SEGMENT_OPTION_ACTIVE = 'sidebar-segment-active text-foreground'
const SEGMENT_OPTION_IDLE = 'text-muted-foreground/60 hover:text-foreground'

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className={CANVAS_TEXT_META}>{children}</p>
}

function parseHHMM(s: string): [number, number] {
  const trimmed = s.trim()
  const [hStr, mStr] = trimmed.split(':')
  const h = parseInt(hStr, 10)
  const m = parseInt(mStr, 10)
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return [9, 0] // fallback to 09:00
  }
  return [h, m]
}

/**
 * 每天/工作日/每周的 HH:mm 选择：复用 smartsheet-ui TimeSelect（与 DatePicker 底部时分同款）。
 */
function ScheduleTimePicker({
  id,
  value,
  onChange,
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string
  onChange: (next: string) => void
  'aria-label'?: string
}) {
  const { t } = useTranslation('tabtracker')
  const [open, setOpen] = useState(false)
  const [hour, minute] = parseHHMM(value)
  const [draftTime, setDraftTime] = useState(
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  )

  useEffect(() => {
    if (!open) return
    const [h, m] = parseHHMM(value)
    setDraftTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }, [open, value])

  const display = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label={ariaLabel}
          data-testid="tracker-at"
          className={cn(CHIP_CONTROL, 'inline-flex w-24 items-center justify-center text-foreground')}
        >
          {display}
        </button>
      </PopoverTrigger>
      <PopoverContent
        // 与 DialogContent container={null} 对齐：强制挂 body，避免被 Space Overlay 容器压在表单下
        container={null}
        className="w-auto p-0 z-dropdown"
        align="start"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <TimeSelect
            value={draftTime}
            onChange={setDraftTime}
            portalContainer={null}
          />
          <Button
            type="button"
            size="sm"
            data-testid="tracker-at-confirm"
            onClick={() => {
              onChange(draftTime)
              setOpen(false)
            }}
          >
            {t('createDialog.confirmTime', { defaultValue: '确认' })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * 用户本地 IANA 时区（如 Asia/Shanghai）。
 * 后端 compute_next_run_at 对 cron 缺省按 UTC 解析（utils.py），而表单的
 * HH:MM 语义是用户本地时间——不写 timezone 会导致「每天 9 点」按 UTC 9 点跑
 * （东八区偏移 8 小时）。取不到时返回 undefined，由后端保持 UTC 兜底。
 */
function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** 使用平台 Intl 校验时区；不维护前端 IANA 名单，非法/空值交回本地时区兜底。 */
function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const timezone = value.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return timezone
  } catch {
    return undefined
  }
}

/**
 * 把预设 + 表单状态转成 trigger_type / trigger_config。
 * cron 5 档与 Wave 3 CLI translateSchedule 保持等价；interval/at
 * 与 CLI resolveTrackerTrigger / 后端 compute_next_run_at 的 config key 对齐。
 * cron 档位额外写入 timezone，让后端按用户本地时区解析 HH:MM。
 */
function presetToTrigger(
  preset: SchedulePreset,
  state: TriggerFormState,
): { trigger_type: string; trigger_config: Record<string, unknown> } {
  if (preset === 'manual') {
    return { trigger_type: 'manual', trigger_config: {} }
  }
  const tz = normalizeTimeZone(state.timezone) ?? localTimeZone()
  const tzField = tz ? { timezone: tz } : {}
  // 错过策略（离线韧性 M3）：仅周期性调度（cron/interval）有意义；显式写入两种取值，
  // 编辑往返（skip → run_once）也能覆盖旧值。后端 scan_due_trackers 消费。
  const catchupField = { catchup_policy: state.catchupPolicy }
  if (preset === 'hourly') {
    return { trigger_type: 'cron', trigger_config: { cron_expression: '0 * * * *', ...tzField, ...catchupField } }
  }
  if (preset === 'interval') {
    const minutes = Number.isFinite(state.intervalMinutes) ? Math.floor(state.intervalMinutes) : 0
    return { trigger_type: 'interval', trigger_config: { interval_seconds: minutes * 60, ...catchupField } }
  }
  if (preset === 'at') {
    // DatePicker 存 ISO（带 Z）；再经 Date 规范化，后端 parse_datetime 视为 aware
    const iso = state.onceAtDateTime ? new Date(state.onceAtDateTime).toISOString() : ''
    return { trigger_type: 'at', trigger_config: { at: iso } }
  }
  // daily / weekdays / weekly 都需要 HH:MM
  const [hh, mm] = parseHHMM(state.atTime)
  let cronExpr = ''
  if (preset === 'daily') {
    cronExpr = `${mm} ${hh} * * *`
  } else if (preset === 'weekdays') {
    cronExpr = `${mm} ${hh} * * 1-5`
  } else if (preset === 'weekly') {
    cronExpr = `${mm} ${hh} * * 1`
  }
  return { trigger_type: 'cron', trigger_config: { cron_expression: cronExpr, ...tzField, ...catchupField } }
}

/** 规范化一次性调度时间：非法值回空串，合法 ISO 原样返回（供 DatePicker / 提交校验）。 */
function normalizeOnceAtIso(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString()
}

/**
 * 反向:从 cron_expression 推断 preset(用于编辑模式回填)。
 *
 * 返回 null 表示该 cron 无法用表单的 5 档预设忠实表达（如「每周二」「每月 15 号」
 * 或任意步进/列表语法）。此前的实现会把这类表达式降级成 daily/manual，用户点保存
 * 就会静默改写调度规则——现在改为「锁定触发配置」只读保留（见 lockedTrigger）。
 */
function cronToPreset(cron: string | undefined, triggerType: string): { preset: SchedulePreset; atTime: string } | null {
  if (triggerType === 'manual') {
    return { preset: 'manual', atTime: '09:00' }
  }
  if (!cron) return null
  const trimmed = cron.trim()
  if (trimmed === '0 * * * *') return { preset: 'hourly', atTime: '09:00' }
  // 仅识别 M H * * <dow ∈ {*, 1-5, 1}> —— 与 presetToTrigger 严格互逆
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts
  if (dom !== '*' || mon !== '*') return null
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return null
  const mNum = parseInt(m, 10)
  const hNum = parseInt(h, 10)
  if (mNum < 0 || mNum > 59 || hNum < 0 || hNum > 23) return null
  const atTime = `${String(hNum).padStart(2, '0')}:${String(mNum).padStart(2, '0')}`
  if (dow === '1-5') return { preset: 'weekdays', atTime }
  if (dow === '1') return { preset: 'weekly', atTime }
  if (dow === '*') return { preset: 'daily', atTime }
  return null
}

/** 表单可编辑的 trigger 类型；其余（webhook/table_event/extension_event/tracker_completed 等）走锁定只读。 */
const FORM_EDITABLE_TRIGGER_TYPES = new Set(['manual', 'cron', 'interval', 'at'])

export const CreateTrackerDialog: React.FC<CreateTrackerDialogProps> = ({
  open,
  onOpenChange,
  spaceId,
  editTracker,
  onCreated,
  initialValues,
}) => {
  const { t } = useTranslation('tabtracker')
  const spaces = useSpaceStore(s => s.spaces)
  const createTask = useTrackerStore(s => s.createTask)
  const updateTask = useTrackerStore(s => s.updateTask)

  const isEditMode = !!editTracker
  const currentSpace = useMemo(
    () => spaces.find(sp => sp.id === spaceId) ?? null,
    [spaces, spaceId],
  )
  // 弹窗 spaceId 偶发找不到时，仍用组织内其它 Space 撑起下拉，避免「选择 Agent」空壳
  const organizationId = currentSpace?.organization_id
    ?? spaces.find(sp => sp.id === spaceId)?.organization_id
    ?? spaces.find(sp => !sp.is_archived && sp.type !== 'team_space')?.organization_id
    ?? ''
  // ── 表单状态 ──
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  // 选中的执行 Space（新建默认当前 spaceId）；提交时再映射成 agent_id
  const [selectedExecutionSpaceId, setSelectedExecutionSpaceId] = useState<string>('')
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string; name: string }>>([])
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('daily')
  const [atTime, setAtTime] = useState('09:00')
  // TS-3 新增触发入口状态
  const [intervalMinutes, setIntervalMinutes] = useState(30)
  const [onceAtDateTime, setOnceAtDateTime] = useState('')
  /**
   * cron 时区单一真相：编辑回填原值 / 模板透传合法值 / 空非法与普通新建回落浏览器本地。
   * interval/at/manual 提交时不消费此字段（见 presetToTrigger）。
   */
  const [timezone, setTimezone] = useState<string | undefined>(() => localTimeZone())
  // 错过策略（离线韧性 M3）：run_once=错过后恢复时补跑一次（默认，报表类），
  // skip=错过就跳过等下次（提醒类）。仅周期性预设（hourly/daily/weekdays/weekly/interval）展示。
  const [catchupPolicy, setCatchupPolicy] = useState<CatchupPolicy>('run_once')
  /** 更多选项：列表备注 / 错过策略，默认收起降低主路径负担 */
  const [showMoreOptions, setShowMoreOptions] = useState(false)
  // 编辑模式回填的原始 at 值：时间已过去的一次性任务，只要用户没改时间，
  // 保存其他字段时跳过「必须在未来」校验（否则任务等于只读）。
  const [initialOnceAt, setInitialOnceAt] = useState('')
  // 编辑模式下表单无法忠实表达的触发配置（高级 trigger 类型 / 自定义 cron）：
  // 锁定只读展示，保存时不回传 trigger_type/trigger_config（后端 PUT 仅更新
  // 提供的字段），避免静默覆盖原有调度。
  const [lockedTrigger, setLockedTrigger] = useState<{ type: string; cron?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [creationSource, setCreationSource] = useState<CreationSource>('ui')
  /** 新建：手动填写（默认）/ Agent 创建；编辑态不展示页签 */
  const [createMode, setCreateMode] = useState<'manual' | 'agent'>('manual')
  const [agentRequest, setAgentRequest] = useState('')
  const [agentSubmitting, setAgentSubmitting] = useState(false)

  const workspaceOptions = useMemo(() => {
    if (!organizationId) return []
    return spaces.filter(sp =>
      sp.organization_id === organizationId
      && !sp.is_archived
      && sp.type !== 'team_space',
    )
  }, [spaces, organizationId])

  const selectedWorkspaceLabel = useMemo(() => {
    if (!selectedExecutionSpaceId) return undefined
    return spaces.find(sp => sp.id === selectedExecutionSpaceId)?.name?.trim()
      || selectedExecutionSpaceId
  }, [selectedExecutionSpaceId, spaces])

  useEffect(() => {
    if (!open || !organizationId) return
    let cancelled = false
    AgentApiService.listAgents(organizationId)
      .then(agents => {
        if (!cancelled) {
          setAvailableAgents(agents.map(agent => ({ id: agent.id, name: agent.name })))
        }
      })
      .catch(() => {
        if (!cancelled) setSubmitError(t('createDialog.errors.loadAgents'))
      })
    return () => {
      cancelled = true
    }
  }, [open, organizationId, t])

  useEffect(() => {
    if (!open || editTracker || selectedAgentId || availableAgents.length === 0) return
    setSelectedAgentId(availableAgents[0].id)
  }, [open, editTracker, selectedAgentId, availableAgents])

  // 新建打开 / 切 spaceId：始终默认当前 Space（不依赖 agent 是否已绑定）
  useEffect(() => {
    if (!open || editTracker) return
    if (!spaceId) return
    setSelectedExecutionSpaceId(spaceId)
  }, [open, editTracker, spaceId])

  // ── 表单初始化 ──
  const resetForm = useCallback(() => {
    if (editTracker) {
      setCreationSource('ui')
      setName(editTracker.name ?? '')
      setDescription(editTracker.description ?? '')
      setInstructions((editTracker.skill_params?.instructions as string) ?? '')
      setSelectedAgentId(editTracker.agent_id ?? '')
      setSelectedExecutionSpaceId(editTracker.workspace_id ?? spaceId)
      setShowMoreOptions(Boolean(editTracker.description?.trim()))
      // 反推 schedule preset / 触发配置
      const cfg = editTracker.trigger_config ?? {}
      const tt = editTracker.trigger_type
      // 先把新增入口的状态重置为默认，再按 trigger_type 回填
      setIntervalMinutes(30)
      setOnceAtDateTime('')
      setInitialOnceAt('')
      setLockedTrigger(null)
      // 错过策略回填：仅识别显式 skip，其余（缺失/run_once/异常值）按默认补跑。
      setCatchupPolicy(cfg.catchup_policy === 'skip' ? 'skip' : 'run_once')
      // 合法原时区原样保留；缺失/非法回落浏览器本地（提交 cron 时再写入）。
      setTimezone(normalizeTimeZone(cfg.timezone) ?? localTimeZone())
      if (!FORM_EDITABLE_TRIGGER_TYPES.has(tt)) {
        // 高级触发类型（webhook / table_event / extension_event / tracker_completed）：
        // 表单没有对应入口，锁定只读、保存时保持原配置不变。
        setLockedTrigger({ type: tt })
        setSchedulePreset('manual')
        setAtTime('09:00')
      } else if (tt === 'interval') {
        setSchedulePreset('interval')
        const secs = Number(cfg.interval_seconds ?? cfg.seconds ?? 1800)
        setIntervalMinutes(secs > 0 ? Math.max(1, Math.round(secs / 60)) : 30)
        setAtTime('09:00')
      } else if (tt === 'at') {
        setSchedulePreset('at')
        const onceAtIso = normalizeOnceAtIso(cfg.at as string | undefined)
        setOnceAtDateTime(onceAtIso)
        setInitialOnceAt(onceAtIso)
        setAtTime('09:00')
      } else {
        // 后端 compute_next_run_at 同时接受 cron_expression / expression 两个 key
        const cron = (cfg.cron_expression as string) ?? (cfg.expression as string) ?? ''
        const mapped = cronToPreset(cron, tt)
        if (mapped) {
          setSchedulePreset(mapped.preset)
          setAtTime(mapped.atTime)
        } else {
          // CLI/API 写入的非预设 cron（如「每周二」）：锁定只读，避免降级成
          // daily 后保存改写调度语义。
          setLockedTrigger({ type: tt, cron })
          setSchedulePreset('manual')
          setAtTime('09:00')
        }
      }
    } else {
      // 模板预填与 Cmd+K storage 是两个独立入口：模板打开时完全不读取/消费
      // Cmd+K 待处理值，留给下一次普通创建；非模板入口才一次性消费。
      const fromTemplate = initialValues?.source === 'template'
      let cliPreset: SchedulePreset | undefined
      let cliAt: string | undefined
      let cliName: string | undefined
      let consumedCommandPaletteValues = false
      if (!fromTemplate) {
        try {
          const raw = sessionStorage.getItem('tabtin:tracker:cliInitialValues')
          if (raw) {
            const parsed = JSON.parse(raw) as { name?: string; schedulePreset?: SchedulePreset; atTime?: string }
            cliName = parsed.name
            cliPreset = parsed.schedulePreset
            cliAt = parsed.atTime
            consumedCommandPaletteValues = true
            // 一次性消费,避免下次打开重复预填
            sessionStorage.removeItem('tabtin:tracker:cliInitialValues')
          }
        } catch { /* ignore parse error */ }
      }

      setCreationSource(
        fromTemplate
          ? 'template'
          : consumedCommandPaletteValues
            ? 'command_palette'
            : 'ui',
      )
      setName(initialValues?.name ?? cliName ?? '')
      setDescription('')
      setInstructions(initialValues?.instructions ?? '')
      // 新建默认当前侧栏 Space（下拉 value = spaceId）
      setSelectedExecutionSpaceId(spaceId)
      setSchedulePreset(initialValues?.schedulePreset ?? cliPreset ?? 'daily')
      setAtTime(initialValues?.atTime ?? cliAt ?? '09:00')
      // 模板合法时区透传；空/非法与普通新建（含 Cmd+K）一律浏览器本地。
      setTimezone(normalizeTimeZone(initialValues?.timezone) ?? localTimeZone())
      setIntervalMinutes(30)
      setOnceAtDateTime('')
      setInitialOnceAt('')
      setLockedTrigger(null)
      setCatchupPolicy('run_once')
      setShowMoreOptions(false)
      setCreateMode('manual')
      setAgentRequest('')
      setAgentSubmitting(false)
    }
    setSubmitError(null)
  }, [editTracker, initialValues, spaceId])

  // 只在 open 从 false→true 时初始化一次。
  // 详情页会把 live detail 作为 editTracker 传入，后台 5s 轮询 / WS 刷新会换新对象引用；
  // 若把 resetForm（依赖 editTracker）放进 effect 依赖，弹窗开着时会被反复 reset，覆盖未保存修改。
  // 见 。
  const wasOpenRef = useRef(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      resetForm()
      // 名称框在页签之后；等 reset 落到手动页签后再 focus，避免被当成标题
      const focusId = window.setTimeout(() => {
        nameInputRef.current?.focus()
      }, 0)
      wasOpenRef.current = true
      return () => window.clearTimeout(focusId)
    }
    if (!open) {
      wasOpenRef.current = false
    }
  }, [open, resetForm])

  const handleSubmit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setSubmitError(t('createDialog.errors.nameRequired'))
      return
    }
    const trimmedInstructions = instructions.trim()
    if (!trimmedInstructions) {
      setSubmitError(t('createDialog.errors.instructionsRequired'))
      return
    }
    if (!organizationId) {
      setSubmitError(t('createDialog.errors.noOrganization'))
      return
    }
    if (!selectedAgentId || !selectedExecutionSpaceId) {
      setSubmitError(t('createDialog.errors.executionBindingRequired'))
      return
    }

    // 触发配置被锁定（高级类型 / 自定义 cron）时不做调度字段校验——保存不改动调度。
    const triggerLocked = isEditMode && !!lockedTrigger
    // TS-3：新增入口的必填校验（与后端 _validate_trigger_type_and_config 对齐）
    if (!triggerLocked && schedulePreset === 'interval' && (!Number.isFinite(intervalMinutes) || intervalMinutes < 1)) {
      setSubmitError(t('createDialog.errors.intervalRequired'))
      return
    }
    if (!triggerLocked && schedulePreset === 'at' && !onceAtDateTime) {
      setSubmitError(t('createDialog.errors.onceAtRequired'))
      return
    }
    // ：「定时一次」必须设在未来。提交期校验兜底——DatePicker 无原生 min，
    // 用户可能选到过去时间。1 秒容错吸收提交间隙，后端另有 60s 缓冲。
    // 编辑模式下时间未改动时跳过：已执行过（时间在过去）的一次性任务，
    // 用户只改名称/指令也不该被此校验拦成「只读」。
    const onceAtUnchanged = isEditMode && onceAtDateTime === initialOnceAt
    if (!triggerLocked && schedulePreset === 'at' && onceAtDateTime && !onceAtUnchanged) {
      const onceAtMs = new Date(onceAtDateTime).getTime()
      if (Number.isNaN(onceAtMs) || onceAtMs < Date.now() - 1000) {
        setSubmitError(t('createDialog.errors.onceAtMustBeFuture'))
        return
      }
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      // 锁定态：不回传 trigger 字段（后端 PUT 仅更新提供的字段，原调度保持不变）
      const triggerFields = triggerLocked
        ? {}
        : presetToTrigger(schedulePreset, {
            atTime,
            intervalMinutes,
            onceAtDateTime,
            catchupPolicy,
            timezone,
          })
      const skill_params: Record<string, unknown> = {
        instructions: trimmedInstructions,
      }

      // Wave 4 (charter §6.6) + ：写入 intent_snapshot.created_via
      // - 模板画廊 → 'ui' + template_id/template_version（可审计，不冒充 Cmd+K）
      // - 实际消费 Cmd+K sessionStorage → 'command_palette'
      // - 普通表单 → 'ui'
      const fromTemplate = creationSource === 'template'
      const intent_snapshot: Record<string, unknown> = {
        created_via: creationSource === 'command_palette' ? 'command_palette' : 'ui',
        final_values: {
          name: trimmedName,
          description: description.trim() || null,
          instructions: trimmedInstructions,
          schedule_preset: schedulePreset,
          at_time: atTime,
          agent_id: selectedAgentId,
          workspace_id: selectedExecutionSpaceId || null,
          activate_on_create: true,
        },
        ...(fromTemplate && initialValues?.templateId
          ? {
              template_id: initialValues.templateId,
              template_version: initialValues.templateVersion ?? null,
            }
          : {}),
      }

      const payload = {
        name: trimmedName,
        // ：描述为可选、可编辑。始终回传 trim 后的值（空串即清空），
        // 创建/编辑同一条路径，后端 PUT/POST 均支持 description 字段。
        description: description.trim(),
        ...triggerFields,
        // 纯 Agent 模式：不再要求用户关联 Skill，指令作为任务派给 Agent，
        // 由 Agent runtime 自助发现/调用合适 Skill（后端已放开 skill_key 必填）。
        skill_params,
        intent_snapshot: !isEditMode ? intent_snapshot : undefined,
        // charter v1.8 §7.1：agent_id 是顶层权威字段。
        // 后端 apps/tracker/api/trackers.py:create_tracker 直接读 payload.agent_id。
        agent_id: selectedAgentId,
        workspace_id: selectedExecutionSpaceId || undefined,
        // 新建时由后端原子完成创建 + 启用；编辑请求不携带该字段。
        activate_on_create: !isEditMode ? true : undefined,
      }

      if (isEditMode && editTracker) {
        const result = await updateTask(editTracker.id, payload)
        if (result) {
          onCreated?.()
          onOpenChange(false)
        }
      } else {
        const created = await createTask(organizationId, spaceId, payload)
        if (created) {
          const freq = describeTriggerFrequency(
            created.trigger_type,
            created.trigger_config,
            t,
          )
          if (freq.isHighFrequency) {
            toast.success(t('detail.highFrequencyToast', {
              summary: freq.summary,
              defaultValue: '已启用 · {{summary}}',
            }))
          } else {
            toast.success(t('toast.createdAndActivated'))
          }
          onCreated?.()
          onOpenChange(false)
        } else {
          // createTask 返回 null 时 Store 已 toast,但仍同步到表单错误区
          setSubmitError(t('createDialog.errors.submitFailed'))
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isDuplicateNameErrorMessage(msg)) {
        toast.error(DUPLICATE_NAME_ERROR_TITLE)
        setSubmitError(DUPLICATE_NAME_ERROR_TITLE)
      } else {
        setSubmitError(msg || t('createDialog.errors.submitFailed'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const isTriggerLocked = isEditMode && !!lockedTrigger
  // hourly 时不显示 at(用户都觉得无所谓时间)；manual 时不显示 at
  const showAtField = !isTriggerLocked
    && (schedulePreset === 'daily' || schedulePreset === 'weekdays' || schedulePreset === 'weekly')

  const handleAgentCreate = async () => {
    const body = agentRequest.trim()
    if (!body || !spaceId || agentSubmitting) return
    setAgentSubmitting(true)
    setSubmitError(null)
    try {
      const ok = await requestAgentForTracker(spaceId, buildTrackerCreateViaAgentPrompt(body))
      if (ok) {
        onOpenChange(false)
      } else {
        setSubmitError(t('createDialog.errors.agentCreateFailed'))
      }
    } catch {
      setSubmitError(t('createDialog.errors.agentCreateFailed'))
    } finally {
      setAgentSubmitting(false)
    }
  }

  const showAgentTab = !isEditMode
  const isAgentMode = showAgentTab && createMode === 'agent'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        container={null}
        // 默认会 focus 第一个可聚焦控件（创建方式页签）；改由打开后 focus 名称框
        onOpenAutoFocus={event => event.preventDefault()}
      >
        {/*
          Dialog 已挂 body，但子树仍处在 Space OverlayContainerProvider 下；
          若不覆盖，DatePicker / Select 会 portal 进 Space 容器，被表单压住。
        */}
        <OverlayContainerContext.Provider value={{ container: null }}>
        {/* 页头只放标题，辅助说明放在输入框下方（用户口径：页头不放辅助信息） */}
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('createDialog.editTitle') : t('createDialog.title')}</DialogTitle>
        </DialogHeader>

        {showAgentTab ? (
          <div
            className="grid grid-cols-2 gap-0.5 rounded-lg p-0.5 sidebar-segment-track"
            data-testid="tracker-create-mode-tabs"
            role="tablist"
            aria-label={t('createDialog.createModeLabel')}
          >
            {([
              ['manual', 'createDialog.tabs.manual'],
              ['agent', 'createDialog.tabs.agent'],
            ] as const).map(([mode, labelKey]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={createMode === mode}
                data-testid={`tracker-create-mode-${mode}`}
                onClick={() => {
                  setCreateMode(mode)
                  setSubmitError(null)
                }}
                className={cn(
                  SEGMENT_OPTION,
                  createMode === mode ? SEGMENT_OPTION_ACTIVE : SEGMENT_OPTION_IDLE,
                )}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        ) : null}

        {isAgentMode ? (
          <>
            <DialogScrollBody className="space-y-4">
              <div className="space-y-2">
                <FieldLabel htmlFor="tracker-agent-request" required>
                  {t('createDialog.agentTab.requestLabel')}
                </FieldLabel>
                <Textarea
                  id="tracker-agent-request"
                  value={agentRequest}
                  onChange={e => setAgentRequest(e.target.value)}
                  placeholder={t('createDialog.agentTab.placeholder')}
                  className={cn('min-h-[120px] text-body', SURFACE_FIELD)}
                  data-testid="tracker-agent-request"
                />
                <p className={CANVAS_TEXT_META}>
                  {t('createDialog.agentTab.hint')}
                </p>
              </div>
              {submitError && (
                <div
                  className="rounded-interactive bg-destructive/10 px-3 py-2 text-body text-destructive"
                  role="alert"
                >
                  {submitError}
                </div>
              )}
            </DialogScrollBody>
            <DialogFooter className="flex-row items-center justify-end gap-2 space-x-0">
              <Button
                type="button"
                variant="outline"
                className="text-body"
                onClick={() => onOpenChange(false)}
              >
                {t('createDialog.cancel')}
              </Button>
              <Button
                type="button"
                className="text-body"
                disabled={!agentRequest.trim() || agentSubmitting}
                onClick={() => void handleAgentCreate()}
                data-testid="tracker-agent-create-submit"
              >
                {agentSubmitting
                  ? t('createDialog.agentTab.submitting')
                  : t('createDialog.agentTab.submit')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
        <DialogScrollBody className="space-y-3">
          {/*
           * ：名称 / 执行指令拆成两个带标签字段，避免一体卡被当成「只填一块」。
           * 调度参数仍用 chips 行（频率 / 时刻 / 执行 Space）。
           */}
          <FieldBlock>
            <FieldLabel htmlFor="tracker-name" required>
              {t('createDialog.fields.name')}
            </FieldLabel>
            <Input
              ref={nameInputRef}
              id="tracker-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('createDialog.placeholders.name')}
              className={cn('h-9 text-body', SURFACE_FIELD)}
              data-testid="tracker-name"
            />
            <FieldHint>{t('createDialog.fields.nameHint')}</FieldHint>
          </FieldBlock>

          <FieldBlock>
            <FieldLabel htmlFor="tracker-instructions" required>
              {t('createDialog.fields.instructions')}
            </FieldLabel>
            <Textarea
              id="tracker-instructions"
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              placeholder={t('createDialog.placeholders.instructions')}
              className={cn('min-h-[110px] resize-none text-body', SURFACE_FIELD)}
              data-testid="tracker-instructions"
            />
            <FieldHint>{t('createDialog.fields.instructionsHint')}</FieldHint>
          </FieldBlock>

          <div
            className="flex flex-wrap items-center gap-1.5 rounded-[12px] bg-muted/40 px-3 py-2.5"
            data-testid="tracker-schedule-chips"
          >
              {isTriggerLocked && lockedTrigger ? (
                <div
                  className={cn('flex h-7 items-center gap-1.5 rounded-full px-2.5 text-body text-muted-foreground', CONTROL_TRACK_BG)}
                  aria-disabled="true"
                  data-testid="tracker-locked-trigger"
                >
                  <Lock className="h-[1em] w-[1em] shrink-0" />
                  <span className="max-w-56 truncate">
                    {lockedTrigger.cron
                      ? t('createDialog.lockedTrigger.cronValue', { expression: lockedTrigger.cron })
                      : t(`trigger.${lockedTrigger.type}`, { defaultValue: lockedTrigger.type })}
                  </span>
                </div>
              ) : (
                <>
                  <Select
                    value={schedulePreset}
                    onValueChange={v => {
                      setSchedulePreset(v as SchedulePreset)
                      setSubmitError(null)
                    }}
                  >
                    <SelectTrigger
                      id="tracker-schedule"
                      data-testid="tracker-schedule"
                      className={cn(CHIP_CONTROL, 'w-auto gap-1.5 text-foreground')}
                    >
                      <Clock className="h-[1em] w-[1em] shrink-0 text-muted-foreground/60" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent container={null} className="z-dropdown">
                      {SCHEDULE_PRESETS.map(preset => (
                        <SelectItem key={preset} value={preset} className="text-body">
                          {t(`createDialog.schedulePresets.${preset}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Input 自带 w-full wrapper，chip 化参数须套定宽容器 */}
                  {showAtField && (
                    <ScheduleTimePicker
                      id="tracker-at"
                      value={atTime}
                      onChange={next => {
                        setAtTime(next)
                        setSubmitError(null)
                      }}
                      aria-label={t('createDialog.fields.atTime')}
                    />
                  )}
                  {schedulePreset === 'interval' && (
                    <div className="flex items-center gap-1.5 text-body text-muted-foreground">
                      <span>{t('createDialog.fields.intervalPrefix')}</span>
                      <div className="w-16">
                        <Input
                          id="tracker-interval"
                          type="number"
                          min={1}
                          value={Number.isFinite(intervalMinutes) ? intervalMinutes : ''}
                          onChange={e => {
                            setIntervalMinutes(parseInt(e.target.value, 10))
                            setSubmitError(null)
                          }}
                          aria-label={t('createDialog.fields.intervalMinutes')}
                          className={CHIP_CONTROL}
                        />
                      </div>
                      <span>{t('createDialog.fields.intervalSuffix')}</span>
                    </div>
                  )}
                  {schedulePreset === 'at' && (
                    <div className="w-[220px]" data-testid="tracker-once-at">
                      <DatePicker
                        value={onceAtDateTime || null}
                        onChange={next => {
                          setOnceAtDateTime(next ?? '')
                          setSubmitError(null)
                        }}
                        options={{ formatting: { time: 'HH:mm' } }}
                        placeholder={t('createDialog.fields.onceAt')}
                        className={CHIP_CONTROL}
                      />
                    </div>
                  )}
                </>
              )}

              <Select
                value={selectedExecutionSpaceId || undefined}
                onValueChange={v => {
                  setSelectedExecutionSpaceId(v)
                  setSubmitError(null)
                }}
              >
                <SelectTrigger
                  id="tracker-workspace"
                  aria-label={t('createDialog.fields.workspace')}
                  className={cn(CHIP_CONTROL, 'w-auto gap-1.5 text-foreground')}
                  data-testid="tracker-workspace-select"
                >
                  <Folder className="h-[1em] w-[1em] shrink-0 text-muted-foreground/60" />
                  <SelectValue placeholder={t('createDialog.placeholders.workspace')}>
                    {selectedWorkspaceLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent container={null} className="z-dropdown">
                  {workspaceOptions.map(workspace => (
                    <SelectItem key={workspace.id} value={workspace.id} className="text-body">
                      {workspace.name?.trim() || workspace.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={selectedAgentId || undefined}
                onValueChange={value => {
                  setSelectedAgentId(value)
                  setSubmitError(null)
                }}
              >
                <SelectTrigger
                  id="tracker-agent"
                  aria-label={t('createDialog.fields.agent')}
                  className={cn(CHIP_CONTROL, 'w-auto gap-1.5 text-foreground')}
                  data-testid="tracker-agent-select"
                >
                  <Bot className="h-[1em] w-[1em] shrink-0 text-muted-foreground/60" />
                  <SelectValue placeholder={t('createDialog.placeholders.agent')} />
                </SelectTrigger>
                <SelectContent container={null} className="z-dropdown">
                  {availableAgents.map(agent => (
                    <SelectItem key={agent.id} value={agent.id} className="text-body">
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
          </div>

          {/* 更多选项：列表备注 / 错过策略 —— 默认收起。权限是固定提示，不算选项。 */}
          <div className="space-y-3 pt-1">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left text-body text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setShowMoreOptions(v => !v)}
              aria-expanded={showMoreOptions}
              data-testid="tracker-more-options"
            >
              <ChevronDown
                className={cn(
                  'h-[1em] w-[1em] shrink-0 transition-transform',
                  showMoreOptions ? 'rotate-0' : '-rotate-90',
                )}
              />
              {t('createDialog.moreOptions')}
            </button>

            {showMoreOptions && (
              <div className="space-y-4">
                <FieldBlock>
                  <FieldLabel htmlFor="tracker-description">
                    {t('createDialog.fields.description')}
                  </FieldLabel>
                  <Textarea
                    id="tracker-description"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder={t('createDialog.placeholders.description')}
                    className={cn('min-h-[56px] text-body', SURFACE_FIELD)}
                  />
                </FieldBlock>

                {!isTriggerLocked
                  && (schedulePreset === 'hourly' || schedulePreset === 'daily'
                    || schedulePreset === 'weekdays' || schedulePreset === 'weekly'
                    || schedulePreset === 'interval') && (
                  <FieldBlock>
                    <FieldLabel>
                      {t('createDialog.fields.catchup')}
                    </FieldLabel>
                    <div
                      className="grid grid-cols-2 gap-0.5 rounded-lg p-0.5 sidebar-segment-track"
                      data-testid="tracker-catchup-policy"
                      role="radiogroup"
                      aria-label={t('createDialog.fields.catchup')}
                    >
                      {(['run_once', 'skip'] as const).map(policy => (
                        <button
                          key={policy}
                          type="button"
                          role="radio"
                          aria-checked={catchupPolicy === policy}
                          onClick={() => setCatchupPolicy(policy)}
                          className={cn(
                            SEGMENT_OPTION,
                            catchupPolicy === policy
                              ? SEGMENT_OPTION_ACTIVE
                              : SEGMENT_OPTION_IDLE,
                          )}
                        >
                          {t(`createDialog.catchup.${policy}`)}
                        </button>
                      ))}
                    </div>
                    <FieldHint>{t(`createDialog.catchup.${catchupPolicy}Hint`)}</FieldHint>
                  </FieldBlock>
                )}
              </div>
            )}
          </div>

          {/* 权限：固定说明，不是可选项 */}
          <p
            className={cn('flex', 'items-start', 'gap-1.5', CANVAS_TEXT_META)}
            data-testid="tracker-permission-notice"
          >
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{t('createDialog.permissionNotice.hint')}</span>
          </p>

          {/* 错误提示(友好,非堆栈) */}
          {submitError && (
            <div
              className="rounded-interactive bg-destructive/10 px-3 py-2 text-body text-destructive"
              role="alert"
            >
              {submitError}
            </div>
          )}
        </DialogScrollBody>

        <DialogFooter className="flex-row items-center justify-end gap-2 space-x-0">
          <Button
            type="button"
            variant="outline"
            className="text-body"
            onClick={() => onOpenChange(false)}
          >
            {t('createDialog.cancel')}
          </Button>
          <Button
            type="button"
            className="text-body"
            disabled={!name.trim() || !instructions.trim() || !organizationId || submitting}
            onClick={() => void handleSubmit()}
          >
            {isEditMode ? t('createDialog.save') : t('createDialog.submit')}
          </Button>
        </DialogFooter>
          </>
        )}
        </OverlayContainerContext.Provider>
      </DialogContent>
    </Dialog>
  )
}

export default CreateTrackerDialog
