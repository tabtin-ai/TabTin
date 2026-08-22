/**
 * SubagentConversationForm — 子 Agent「对话内形态」探索（DEV 预览专用）
 *
 * 范式转变（2026-05-29 第三轮反馈）：
 *   之前不管怎么改，都还是「状态卡片」——一个带边框、带头部汇总、带计数器、
 *   带「取消全部」按钮、带计时器的 widget，是从对话里抠出来让你「盯」的面板。
 *
 *   这一版换思路：**子 Agent 不是一张卡，是 Agent 在对话里做的一个动作**。
 *   它和「思考了 6 秒」「读了个文件」「调了个工具」是同一类东西——transcript
 *   里的一个 step，顺着读就过去了。
 *
 *   - 汇总不是 UI 头部 → 是 Agent 自己的话（"我并行派 3 个去查"）
 *   - 分组不是边框 → 是上下文的连贯（步骤紧贴在引出它的那句话下面）
 *   - 状态不是计数器 → 跑的时候是"正在做的 step"，完了沉淀成"叙述记录"
 *   - 控制不是常驻按钮条 → 是 hover 才浮现的轻动作（像 thinking 的展开箭头）
 *
 *   没有边框、没有「N 个子任务」头、没有「取消全部」条、没有计时器仪表。
 *
 * 本组件渲染一段**模拟对话**（用户提问 → Agent 思考 → 引出子任务 → 子任务
 * 顺流而下 → Agent 继续说），让你判断「它作为对话的一段读起来对不对」，
 * 而不是又一张卡。
 */

import React, { useState } from 'react'
import {
  Loader2,
  Check,
  XCircle,
  Clock,
  Circle,
  Brain,
  ChevronRight,
  ChevronDown,
  X,
  ArrowUpRight,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

/* ─── demo 数据 ─────────────────────────────────────────────────────── */

type StepStatus = 'running' | 'queued' | 'completed' | 'failed'

interface DemoStep {
  id: string
  status: StepStatus
  /** 动词领头的子任务（Agent 派它去做什么） */
  task: string
  /** 谁去做的——退成次要灰字身份标签 */
  actor: string
  /** 运行中：当前在做什么（"网页搜索中…"） */
  live?: string
  /** 完成 / 失败后：一句话结果，沉淀进叙述 */
  result?: string
  /** 展开看的子对话片段（peek，不是另开一张卡） */
  transcript?: string[]
}

const STEPS_RUNNING: DemoStep[] = [
  {
    id: 's1',
    status: 'running',
    task: '查竞品 X 的定价',
    actor: '研究员',
    live: '网页搜索中…',
  },
  {
    id: 's2',
    status: 'running',
    task: '查竞品 Y 的功能',
    actor: '研究员',
    live: '读取竞品官网…',
  },
  {
    id: 's3',
    status: 'queued',
    task: '查竞品 Z 的 API',
    actor: '研究员',
  },
]

const STEPS_DONE: DemoStep[] = [
  {
    id: 's1',
    status: 'completed',
    task: '查竞品 X 的定价',
    actor: '研究员',
    result: '近期降价 8%，主打中端',
    transcript: [
      '网页搜索 “competitor X pricing 2026”',
      '读取 pricing 页 · 命中 3 档套餐',
      '结论：入门档从 ¥99 降到 ¥91，挤压中端',
    ],
  },
  {
    id: 's2',
    status: 'completed',
    task: '查竞品 Y 的功能',
    actor: '研究员',
    result: '本月补了三个协作功能',
    transcript: [
      '读取 Y 的 changelog',
      '结论：新增多人光标、评论、版本回溯',
    ],
  },
  {
    id: 's3',
    status: 'failed',
    task: '查竞品 Z 的 API',
    actor: '研究员',
    result: '超时，API 文档没取到',
    transcript: [
      '网页抓取 docs.z.com/api · 连接超时',
      '重试 1 次仍超时 → 放弃，建议换源',
    ],
  },
]

/* ─── 单色状态字形（沿用对话里其它 step 的视觉语言） ───────────────── */

function statusGlyph(status: StepStatus): {
  Icon: React.ComponentType<{ className?: string }>
  tone: string
  animate?: boolean
} {
  switch (status) {
    case 'running':
      return { Icon: Loader2, tone: 'text-muted-foreground/60', animate: true }
    case 'queued':
      return { Icon: Clock, tone: 'text-muted-foreground/40' }
    case 'completed':
      return { Icon: Check, tone: 'text-muted-foreground/40' }
    case 'failed':
      return { Icon: XCircle, tone: 'text-destructive/80' }
  }
}

/* ─── 子任务 step 行（对话里的一个动作，不是卡片的一行） ───────────── */

const SubagentStep: React.FC<{ step: DemoStep }> = ({ step }) => {
  const [open, setOpen] = useState(false)
  const glyph = statusGlyph(step.status)
  const meta = step.status === 'running' ? step.live : step.status === 'queued' ? '排队中…' : step.result
  const canExpand = !!step.transcript?.length

  return (
    <div className="my-0.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => canExpand && setOpen((p) => !p)}
        onKeyDown={(e) => {
          if (canExpand && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setOpen((p) => !p)
          }
        }}
        className={cn(
          'group flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-2 text-left transition-colors',
          canExpand && 'cursor-pointer hover:bg-muted/20',
        )}
      >
        <glyph.Icon className={cn('h-3.5 w-3.5 shrink-0', glyph.tone, glyph.animate && 'animate-spin')} />

        {/* 任务名最重；actor + 结果退成一句灰字，整行读下来像叙述 */}
        <span className="shrink-0 text-body text-foreground/90">{step.task}</span>
        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground/60">
          {step.actor}
          {meta ? ` · ${meta}` : ''}
        </span>

        {/* hover 才浮现的轻动作：运行中 → 取消；其它 → 打开完整对话 */}
        {step.status === 'running' || step.status === 'queued' ? (
          <ChatIconTooltip content="取消">
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted/40 hover:text-foreground group-hover:opacity-100"
              aria-label="取消"
            >
              <X className="h-3 w-3" />
            </button>
          </ChatIconTooltip>
        ) : (
          <ChatIconTooltip content="打开完整对话">
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted/40 hover:text-foreground group-hover:opacity-100"
              aria-label="打开完整对话"
            >
              <ArrowUpRight className="h-3 w-3" />
            </button>
          </ChatIconTooltip>
        )}

        {canExpand && (
          <span className="shrink-0 text-muted-foreground/40">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
        )}
      </div>

      {/* 展开 = 在对话里就地 peek 子对话几行（不另开卡 / 不切场所） */}
      {open && step.transcript && (
        <div className="mb-1 ml-5 mt-0.5 space-y-0.5">
          {step.transcript.map((line, i) => (
            <div key={i} className="text-caption text-muted-foreground/60">
              {line}
            </div>
          ))}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-caption text-muted-foreground/60 hover:text-foreground"
          >
            打开完整对话
            <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  )
}

/* ─── 模拟对话宿主 ───────────────────────────────────────────────────── */

const Thought: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex items-center gap-1.5 py-0.5 text-body text-muted-foreground/60">
    <Brain className="h-3 w-3 shrink-0 text-muted-foreground/40" />
    {text}
  </div>
)

const Prose: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-body leading-relaxed text-foreground/90">{children}</p>
)

const UserBubble: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex justify-end">
    <div className="max-w-[80%] rounded-2xl bg-muted/40 px-3.5 py-2 text-body text-foreground/90">
      {children}
    </div>
  </div>
)

export const SubagentConversationForm: React.FC<{ state: 'running' | 'done' }> = ({ state }) => {
  const steps = state === 'running' ? STEPS_RUNNING : STEPS_DONE
  return (
    <div className="space-y-3">
      {/* 用户气泡 */}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-muted/40 px-3.5 py-2 text-body text-foreground/90">
          评估一下我们和竞品 X / Y / Z 的差距
        </div>
      </div>

      {/* Agent 回复：思考 → 引出子任务 → 子任务顺流 → 继续说 */}
      <div className="space-y-2">
        <Thought text="思考 6 秒" />
        <Prose>先并行派几个子任务，分别去查三家竞品的一手信息，再下判断。</Prose>

        {/* 子任务：紧贴上面那句话，像对话里的一组动作，无边框无头部 */}
        <div className="my-1">
          {steps.map((step) => (
            <SubagentStep key={step.id} step={step} />
          ))}
        </div>

        {state === 'running' ? (
          <Thought text="等子任务回来…" />
        ) : (
          <Prose>
            X 和 Y 都回来了：X 最近降价 8% 抢中端，Y 这个月补了多人协作。Z 的 API
            文档超时没取到，我换个源再试一次，拿到再补完整对比。
          </Prose>
        )}
      </div>
    </div>
  )
}

SubagentConversationForm.displayName = 'SubagentConversationForm'

/* ═══════════════════════════════════════════════════════════════════════
 * 同一哲学（对话内、可读、单色）的不同形态
 * ═══════════════════════════════════════════════════════════════════════ */

/* ─── 变体甲：融进句子（结果即文本，工作消失在叙述里） ───────────────
 *
 * 哲学：子 Agent 的产出**就是 Agent 这句话本身**。不列表、不分行——三个
 * 结果直接织进一句话，竞品名是可点的"实体"（hover 才显出可点，点了 peek
 * 子对话）。可读性最高，代价是"有子 Agent 在跑"这件事最不显眼。
 */

const InlineEntity: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <button
    type="button"
    className="rounded px-0.5 font-medium text-foreground transition-colors hover:bg-muted/40"
    title="查看这条的子对话"
  >
    {children}
  </button>
)

export const SubagentFormInlineProse: React.FC<{ state: 'running' | 'done' }> = ({ state }) => (
  <div className="space-y-3">
    <UserBubble>评估一下我们和竞品 X / Y / Z 的差距</UserBubble>
    <div className="space-y-2">
      <Thought text="思考 6 秒" />
      {state === 'running' ? (
        <p className="text-body leading-relaxed text-foreground/90">
          正在让三个研究员分头查 <InlineEntity>竞品 X</InlineEntity>、
          <InlineEntity>竞品 Y</InlineEntity>、<InlineEntity>竞品 Z</InlineEntity>…
          <Loader2 className="ml-1 inline-block h-3 w-3 animate-spin align-text-bottom text-muted-foreground/60" />
        </p>
      ) : (
        <p className="text-body leading-relaxed text-foreground/90">
          我让三个研究员分头查了竞品：<InlineEntity>竞品 X</InlineEntity> 近期降价 8% 抢中端，
          <InlineEntity>竞品 Y</InlineEntity> 这个月补了多人协作，<InlineEntity>竞品 Z</InlineEntity>
          的 API 文档超时没取到——我换个源再试一次。
        </p>
      )}
    </div>
  </div>
)
SubagentFormInlineProse.displayName = 'SubagentFormInlineProse'

/* ─── 变体乙：自检清单（看着一个计划被完成） ─────────────────────────
 *
 * 哲学：把并行子任务当成 Agent 的一张计划——你看着它一项项打勾。行内**只有
 * 任务**（○ 待办 → ↻ 进行 → ✓ 完成 / ✗ 失败），结果不挤进列表，归到收口那
 * 句话。列表因此极干净，进度感最强。
 */

type ChecklistStatus = 'completed' | 'running' | 'queued' | 'failed'

function checklistGlyph(status: ChecklistStatus) {
  switch (status) {
    case 'completed':
      return { Icon: Check, tone: 'text-muted-foreground/40' as const, animate: false }
    case 'running':
      return { Icon: Loader2, tone: 'text-muted-foreground/60' as const, animate: true }
    case 'failed':
      return { Icon: XCircle, tone: 'text-destructive/80' as const, animate: false }
    default:
      return { Icon: Circle, tone: 'text-muted-foreground/40' as const, animate: false }
  }
}

const ChecklistRow: React.FC<{ task: string; status: ChecklistStatus }> = ({ task, status }) => {
  const g = checklistGlyph(status)
  return (
    <div className="group flex cursor-pointer items-center gap-2 rounded-md py-0.5 pr-2 transition-colors hover:bg-muted/20">
      <g.Icon className={cn('h-3.5 w-3.5 shrink-0', g.tone, g.animate && 'animate-spin')} />
      <span className="text-body text-foreground/90">{task}</span>
      <ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  )
}

export const SubagentFormChecklist: React.FC<{ state: 'running' | 'done' }> = ({ state }) => {
  const tasks: { task: string; status: ChecklistStatus }[] =
    state === 'running'
      ? [
          { task: '竞品 X 的定价', status: 'completed' },
          { task: '竞品 Y 的功能', status: 'running' },
          { task: '竞品 Z 的 API', status: 'queued' },
        ]
      : [
          { task: '竞品 X 的定价', status: 'completed' },
          { task: '竞品 Y 的功能', status: 'completed' },
          { task: '竞品 Z 的 API', status: 'failed' },
        ]
  return (
    <div className="space-y-3">
      <UserBubble>评估一下我们和竞品 X / Y / Z 的差距</UserBubble>
      <div className="space-y-2">
        <Thought text="思考 6 秒" />
        <Prose>分三步并行查竞品：</Prose>
        <div className="my-1">
          {tasks.map((t) => (
            <ChecklistRow key={t.task} task={t.task} status={t.status} />
          ))}
        </div>
        {state === 'running' ? (
          <Thought text="等子任务回来…" />
        ) : (
          <Prose>
            三项里两项拿到了：X 降价 8% 抢中端、Y 补了多人协作；Z 的 API 文档超时没取到，我换个源再试。
          </Prose>
        )}
      </div>
    </div>
  )
}
SubagentFormChecklist.displayName = 'SubagentFormChecklist'

/* ─── 变体丙：回执简报（谁查到了什么） ───────────────────────────────
 *
 * 哲学：子 Agent 是"分头去查的参与者"，回来各交一句简报。行内**以发现为
 * 主角**（foreground），actor 退成灰字前缀——读下来像一份精简回执，任务本身
 * 省略（你关心的是查到了什么，不是派了什么）。失败是唯一带色的信号。
 */

const ReportRow: React.FC<{ actor: string; finding: string; failed?: boolean }> = ({
  actor,
  finding,
  failed,
}) => (
  <div className="group flex cursor-pointer items-center gap-2 rounded-md py-0.5 pr-2 transition-colors hover:bg-muted/20">
    {failed ? (
      <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
    ) : (
      <span className="ml-1 mr-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
    )}
    <span className="shrink-0 text-caption text-muted-foreground/60">{actor}</span>
    <span className="min-w-0 truncate text-body text-foreground/90">{finding}</span>
    <ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100" />
  </div>
)

export const SubagentFormReportBack: React.FC<{ state: 'running' | 'done' }> = ({ state }) => {
  const reports =
    state === 'running'
      ? [
          { actor: '研究员', finding: '竞品 X 近期降价 8%，主打中端' },
          { actor: '研究员', finding: '正在读取竞品 Y 官网…', pending: true },
          { actor: '研究员', finding: '排队中…', pending: true },
        ]
      : [
          { actor: '研究员', finding: '竞品 X 近期降价 8%，主打中端' },
          { actor: '研究员', finding: '竞品 Y 本月补了多人协作' },
          { actor: '研究员', finding: '竞品 Z 没取到 —— API 文档超时', failed: true },
        ]
  return (
    <div className="space-y-3">
      <UserBubble>评估一下我们和竞品 X / Y / Z 的差距</UserBubble>
      <div className="space-y-2">
        <Thought text="思考 6 秒" />
        <Prose>{state === 'running' ? '派了三个研究员分头查，陆续在回：' : '派了三个研究员分头查，回来的简报：'}</Prose>
        <div className="my-1">
          {reports.map((r, i) => (
            <ReportRow
              key={i}
              actor={r.actor}
              finding={r.finding}
              failed={'failed' in r ? (r as { failed?: boolean }).failed : false}
            />
          ))}
        </div>
        {state === 'done' && (
          <Prose>综合看：X 在抢中端、Y 在补协作，Z 待补——我换个源把 Z 补上再给你完整对比。</Prose>
        )}
      </div>
    </div>
  )
}
SubagentFormReportBack.displayName = 'SubagentFormReportBack'

/* ─── 字段版：任务 · 当前动作 · 模型（按反馈定义的字段） ───────────────
 *
 * 每个子 Agent step 携带三个字段：
 *   1. 任务   —— 主 Agent 派发的任务名（行首主文本）
 *   2. 当前动作 —— 活的：正在思考 / 阅读 xxx / 运行 xxx / 搜索 xxx → 完成
 *   3. 模型   —— 子 Agent 用的模型名（行尾次要灰字）
 *
 * 状态靠字形（↻ 在跑 / ✓ 完成 / ✗ 失败 / ○ 排队），不再单列「状态」字。
 * 每条结果归到 Agent 收口那句话；行内只承载「在做什么」，跑完落到「完成」。
 */

interface FieldStep {
  id: string
  status: StepStatus
  task: string
  model: string
  /** 当前动作：运行中是活的动词短语；终态是「完成」/「失败 · 原因」 */
  action: string
}

// 当前动作 = latestTool + latestToolInput（确定性，非「正在思考」这种没数据源的文案）；
// 还没出第一个工具时只显示状态文案「启动中…」，不假装在思考。
const FIELDED_RUNNING: FieldStep[] = [
  { id: 'a', status: 'running', task: '分析昨天销售数据', model: 'claude-4-sonnet', action: '读取 sales_2026-05-28.csv' },
  { id: 'b', status: 'running', task: '查竞品 X 的定价', model: 'claude-4-sonnet', action: '网页搜索 “competitor X pricing”' },
  { id: 'c', status: 'running', task: '跑回归测试', model: 'gpt-5-mini', action: '运行 pnpm test' },
  { id: 'd', status: 'queued', task: '读取项目配置', model: 'claude-4-sonnet', action: '排队中…' },
]

const FIELDED_DONE: FieldStep[] = [
  { id: 'a', status: 'completed', task: '分析昨天销售数据', model: 'claude-4-sonnet', action: '完成' },
  { id: 'b', status: 'completed', task: '查竞品 X 的定价', model: 'claude-4-sonnet', action: '完成' },
  { id: 'c', status: 'failed', task: '跑回归测试', model: 'gpt-5-mini', action: '失败 · 3 个用例未过' },
  { id: 'd', status: 'completed', task: '读取项目配置', model: 'claude-4-sonnet', action: '完成' },
]

const FieldedRow: React.FC<{ step: FieldStep }> = ({ step }) => {
  const g = statusGlyph(step.status)
  const isActive = step.status === 'running' || step.status === 'queued'
  return (
    <div className="group flex cursor-pointer items-start gap-2 rounded-md py-1 pr-2 transition-colors hover:bg-muted/20">
      <g.Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', g.tone, g.animate && 'animate-spin')} />
      <div className="min-w-0 flex-1">
        {/* 行 1：任务（主文本） + 模型（行尾灰字） + hover 轻动作 */}
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-body text-foreground/90">{step.task}</span>
          <span className="ml-auto shrink-0 text-caption text-muted-foreground/60">{step.model}</span>
          {isActive ? (
            <ChatIconTooltip content="取消">
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted/40 hover:text-foreground group-hover:opacity-100"
                aria-label="取消"
              >
                <X className="h-3 w-3" />
              </button>
            </ChatIconTooltip>
          ) : (
            <ChatIconTooltip content="打开完整对话">
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted/40 hover:text-foreground group-hover:opacity-100"
                aria-label="打开完整对话"
              >
                <ArrowUpRight className="h-3 w-3" />
              </button>
            </ChatIconTooltip>
          )}
        </div>
        {/* 行 2：当前动作（活的，终态落到「完成」/「失败」） */}
        <div className="mt-0.5 text-caption text-muted-foreground/60">
          <span className={step.status === 'failed' ? 'text-destructive/80' : undefined}>{step.action}</span>
        </div>
      </div>
    </div>
  )
}

export const SubagentFormFielded: React.FC<{ state: 'running' | 'done' }> = ({ state }) => {
  const steps = state === 'running' ? FIELDED_RUNNING : FIELDED_DONE
  return (
    <div className="space-y-3">
      <UserBubble>看看昨天的盘子，顺便和竞品对一下、把回归跑一遍</UserBubble>
      <div className="space-y-2">
        <Thought text="思考 8 秒" />
        <Prose>我并行派 4 个子任务，分别去做这几件事：</Prose>
        <div className="my-1">
          {steps.map((step) => (
            <FieldedRow key={step.id} step={step} />
          ))}
        </div>
        {state === 'running' ? (
          <Thought text="等子任务回来…" />
        ) : (
          <Prose>
            三件做好了：销售 Top 10 出来了、竞品 X 近期降价 8%、配置也读完了；回归测试挂了 3 个用例，我去看一下再修。
          </Prose>
        )}
      </div>
    </div>
  )
}
SubagentFormFielded.displayName = 'SubagentFormFielded'
