/**
 * ChatComponentPreview — DEV-only 子 Agent UI 组件展示页
 *
 * 访问方式：浏览器打开 http://localhost:<port>/?mode=component-preview
 * 锚点示例：#identity（进度卡片）/ #aggregate / #pane / #settings
 *
 * 覆盖子 Agent 相关全部可视组件：
 *   - SubagentProgressCard（W1 透明度卡片，含 queued / unknown 等新状态）
 *   - SubagentAggregateView（W3 并行聚合视图）
 *   - SubagentDetailPane（W6 工作台 Pane，替代旧抽屉）
 *   - SubAgentPanel 列表 / 编辑器（静态 mock，避免依赖后端 API）
 *   - SpeakerBadge（子 Agent 身份标识）
 */

import React, { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Bot, Pencil, Trash2 } from 'lucide-react'
import { Switch } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { SubagentProgressCard } from '../subagent/SubagentProgressCard'
import { SubagentAggregateView } from '../subagent/SubagentAggregateView'
import {
  SubagentRedesignMinimalRow,
  SubagentRedesignTwoLine,
  SubagentRedesignFoldSummary,
} from '../subagent/SubagentCardRedesigns'
import {
  SubagentConversationForm,
  SubagentFormFielded,
  SubagentFormInlineProse,
  SubagentFormChecklist,
  SubagentFormReportBack,
} from '../subagent/SubagentConversationForm'
import { FullConversationFlowPreview } from './FullConversationFlowPreview'
import { SubagentDetailPane } from '../subagent/SubagentDetailPane'
import { SpeakerBadge } from '../message'
import { TurnAgentBadge } from '../message'
import { useChatRuntimeStore } from '../../../stores/useChatRuntimeStore'
import { useSubagentSessionStore } from '../../../stores/subagentSession'
import { useSpeakerRegistryStore } from '../../../stores/useSpeakerRegistryStore'
import { useSpaceStore } from '../../../stores/useSpaceStore'
import {
  MOCK_AGGREGATE_RUNS,
  MOCK_AGGREGATE_RUNS_ALL_DONE,
  MOCK_AGGREGATE_RUNS_TWO_DONE,
  MOCK_DRAWER_EVENTS,
  MOCK_DRAWER_MESSAGES,
  MOCK_DRAWER_SNAPSHOTS,
  MOCK_SPEAKERS,
  MOCK_TOOL_HISTORY,
  PREVIEW_RUN_ERROR_ID,
  PREVIEW_RUN_ID,
  PREVIEW_SESSION_ID,
} from '../subagent/subagentPreviewMocks'

/* ─── Layout primitives ─────────────────────────────────────────── */

const Section: React.FC<{ title: string; desc: string; children: React.ReactNode }> = ({
  title,
  desc,
  children,
}) => (
  <section className="space-y-3">
    <div>
      <h2 className="text-subtitle font-semibold text-foreground">{title}</h2>
      <p className="text-caption text-muted-foreground/60 mt-0.5">{desc}</p>
    </div>
    <div className="rounded-xl border border-border/20 bg-background p-4">{children}</div>
  </section>
)

const Tag: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-caption font-medium text-muted-foreground/60 uppercase tracking-wider mb-1.5">
    {children}
  </div>
)

const Group: React.FC<{
  id: string
  label: string
  count: number
  children: React.ReactNode
  open: boolean
  onToggle: () => void
}> = ({ id, label, count, children, open, onToggle }) => (
  <div id={id} className="scroll-mt-20">
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-2 w-full text-left py-2 group/grp"
    >
      {open
        ? <ChevronDown className="h-4 w-4 text-muted-foreground/60 shrink-0" />
        : <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
      <span className="text-title font-semibold text-foreground">{label}</span>
      <span className="text-caption text-muted-foreground/40 tabular-nums">{count}</span>
    </button>
    {open && <div className="space-y-8 pt-2">{children}</div>}
  </div>
)

const GROUPS = [
  { id: 'flow', label: '◆ 整段对话体验（模拟 · 全组件走查）', count: 1 },
  { id: 'conversation', label: '★★ 对话内形态（非卡片 · 推荐方向）', count: 6 },
  { id: 'redesign', label: '★ 聚合卡重设计候选（仍是卡片思路 · 留作对比）', count: 3 },
  { id: 'identity', label: 'A. 进度卡片 SubagentProgressCard（已退出主流程 · 仅留档）', count: 8 },
  { id: 'aggregate', label: 'B. 聚合视图 SubagentAggregateView（已上线对话内 step 形态）', count: 4 },
  { id: 'pane', label: 'C. 详情 Pane SubagentDetailPane', count: 3 },
  { id: 'settings', label: 'D. 模板配置 SubAgentPanel', count: 2 },
  { id: 'speaker', label: 'E. 身份徽章 SpeakerBadge / TurnAgentBadge', count: 3 },
] as const

/* ─── Preview store bootstrap ───────────────────────────────────── */

function seedPreviewStores(): void {
  useSpeakerRegistryStore.setState({
    speakersBySessionId: MOCK_SPEAKERS,
  })

  // TurnAgentBadge 预览用：seed agentCache，避免触发真实 loadAgent 请求
  const now = new Date().toISOString()
  const mockAgent = (id: string, name: string) => ({
    id,
    organization_id: 'org-preview',
    name,
    type: 'bot' as const,
    is_active: true,
    created_at: now,
    updated_at: now,
  })
  useSpaceStore.setState(state => ({
    agentCache: {
      ...state.agentCache,
      'agent-preview-titan': mockAgent('agent-preview-titan', '小钛'),
      'agent-preview-charing': mockAgent('agent-preview-charing', '查令'),
      'agent-preview-tablebro': mockAgent('agent-preview-tablebro', '表哥'),
      'agent-preview-ada': mockAgent('agent-preview-ada', 'Ada'),
    },
  }))

  const loadedAt = Date.now()
  useChatRuntimeStore.setState({
    subagentCancellingByRunId: { 'run-cancel-demo': true },
  })
  // PRD §4.11：jsonl 三件套缓存已迁到独立 store
  useSubagentSessionStore.setState({
    subagentSessionDataBySubId: {
      [PREVIEW_RUN_ID]: {
        messages: { lines: MOCK_DRAWER_MESSAGES, loadedAt },
        snapshots: { lines: MOCK_DRAWER_SNAPSHOTS, loadedAt },
        events: { lines: MOCK_DRAWER_EVENTS, loadedAt },
        parentSessionId: PREVIEW_SESSION_ID,
      },
      [PREVIEW_RUN_ERROR_ID]: {
        error: { messages: 'subagent_not_found' },
        parentSessionId: PREVIEW_SESSION_ID,
      },
      'run-preview-truncated': {
        messages: {
          lines: MOCK_DRAWER_MESSAGES.slice(0, 2),
          truncated: true,
          loadedAt,
        },
        parentSessionId: PREVIEW_SESSION_ID,
      },
    },
  })
}

/* ─── SubAgentPanel 静态 mock（TemplateCard 视觉对齐） ──────────── */

const SubAgentTemplateCardMock: React.FC<{
  icon?: string
  name: string
  typeLabel: string
  description: string
  meta?: string
  enabled?: boolean
}> = ({ icon, name, typeLabel, description, meta, enabled = true }) => (
  <div
    className={cn(
      'group flex items-start gap-3 p-3 rounded-lg border border-border/30 transition-colors',
      'hover:border-border/60 hover:bg-muted/10',
      !enabled && 'opacity-50',
    )}
  >
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        {icon
          ? <span className="text-body leading-none shrink-0">{icon}</span>
          : <Bot className="h-4 w-4 text-accent/60 shrink-0" />}
        <span className="text-body font-medium truncate">{name}</span>
        <span className="text-caption px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground/60 shrink-0">
          {typeLabel}
        </span>
      </div>
      <p className="text-body text-muted-foreground/60 mt-0.5 line-clamp-2">{description}</p>
      {meta && (
        <p className="text-caption text-muted-foreground/45 mt-0.5">{meta}</p>
      )}
    </div>
    <div className="flex items-center gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
      <Switch checked={enabled} className="scale-75" />
      <button type="button" className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-foreground hover:bg-muted/30">
        <Pencil className="h-3 w-3" />
      </button>
      <button type="button" className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-destructive hover:bg-muted/30">
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  </div>
)

const SubAgentEditorMock: React.FC = () => (
  <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
    <div className="flex items-center justify-between">
      <span className="text-body font-medium text-foreground">新建子 Agent</span>
      <span className="text-caption text-muted-foreground/60">静态预览 · 不提交</span>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">名称</label>
        <div className="h-9 rounded-md border border-border/40 bg-background px-3 flex items-center text-body text-muted-foreground/60">
          代码审查专家
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">任务角色</label>
        <div className="h-9 rounded-md border border-border/40 bg-background px-3 flex items-center text-body">
          执行型
        </div>
      </div>
    </div>
    <div className="space-y-1">
      <label className="text-body text-muted-foreground">角色设定</label>
      <div className="min-h-[80px] rounded-md border border-border/40 bg-background px-3 py-2 text-body text-muted-foreground/80">
        你是严格的代码审查员，关注安全性、边界条件和可维护性…
      </div>
    </div>
    <div className="flex flex-wrap gap-1">
      {['file_read', 'code_grep', 'diff'].map(tool => (
        <span key={tool} className="text-caption px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground/80 font-mono">
          {tool}
        </span>
      ))}
    </div>
  </div>
)

/* ─── Pane preview host（替代旧 Drawer host） ───────────────────── */

const PanePreviewHost: React.FC<{
  parentSessionId: string
  subagentRunId: string
  label: string
}> = ({ parentSessionId, subagentRunId, label }) => {
  return (
    <div className="space-y-2">
      <Tag>{label}</Tag>
      <div className="relative h-[480px] overflow-hidden rounded-xl border border-border/20 bg-background">
        <SubagentDetailPane
          parentSessionId={parentSessionId}
          subagentRunId={subagentRunId}
          isPaneActive={true}
        />
      </div>
    </div>
  )
}

/* ─── Main preview ──────────────────────────────────────────────── */

export const ChatComponentPreview: React.FC = () => {
  const [expandAll, setExpandAll] = useState(false)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : ''
    if (hash && GROUPS.some(g => g.id === hash)) {
      return { [hash]: true }
    }
    // 整段对话体验是当前主角，进来就直接走查
    return { flow: true }
  })
  const handleExpandAll = useCallback(() => {
    setExpandAll(true)
    setOpenGroups(Object.fromEntries(GROUPS.map(g => [g.id, true])))
  }, [])
  const handleCollapseAll = useCallback(() => {
    setExpandAll(false)
    setOpenGroups({})
  }, [])
  const toggleGroup = useCallback((id: string) => {
    setOpenGroups(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  useEffect(() => {
    seedPreviewStores()
  }, [])

  useEffect(() => {
    const hash = window.location.hash.replace('#', '')
    if (!hash) return
    setOpenGroups(prev => ({ ...prev, [hash]: true }))
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  const noopCancel = useCallback((_id: string) => {
    /* preview only */
  }, [])

  return (
    <div className="h-screen overflow-auto bg-background">
      <div className="mx-auto max-w-2xl px-6 py-12 space-y-10">
        <header>
          <h1 className="text-display font-semibold text-foreground">子 Agent UI 预览</h1>
          <p className="text-body text-muted-foreground/60 mt-1">
            W1 进度卡片 · W2 检视抽屉 · W3 聚合视图 · Space 模板配置。中性底色 + 小面积语义色。
          </p>
        </header>

        <nav className="rounded-xl border border-border/20 bg-muted/5 px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-body font-semibold text-foreground">目录 · 子 Agent 组件</h2>
            <div className="flex items-center gap-2 text-caption">
              <button type="button" onClick={handleExpandAll} className="text-accent hover:underline">
                全部展开
              </button>
              <span className="text-muted-foreground/30">|</span>
              <button type="button" onClick={handleCollapseAll} className="text-accent hover:underline">
                全部折叠
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
            {GROUPS.map(g => (
              <a
                key={g.id}
                href={`#${g.id}`}
                className="flex items-center justify-between py-1 text-body text-foreground/80 hover:text-accent transition-colors"
              >
                <span>{g.label}</span>
                <span className="text-caption text-muted-foreground/40 tabular-nums">{g.count}</span>
              </a>
            ))}
          </div>
        </nav>

        {/* ◆ 整段对话体验（模拟 · 全组件走查） */}
        <Group
          id="flow"
          label="◆ 整段对话体验（模拟 · 全组件走查）"
          count={1}
          open={expandAll || !!openGroups.flow}
          onToggle={() => toggleGroup('flow')}
        >
          <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
            <p className="text-body text-foreground/80">
              一次完整任务从头到尾走一遍：思考 · 文本 · 搜索 / 阅读 / 运行 / 改动+diff ·
              子 Agent（任务·当前动作·模型）· 待办清单 · 高风险确认 · 失败→修复 · 最终回答。
            </p>
            <p className="text-caption text-muted-foreground/60 mt-1.5">
              全部是「对话里的同一种 step」——顺着读，没有边框卡片、没有计数器，单色，失败才标红。
              体感整段读下来顺不顺、乱不乱。
            </p>
          </div>

          <div className="rounded-xl bg-background px-5 py-5">
            <FullConversationFlowPreview />
          </div>
        </Group>

        {/* ★★ 对话内形态（非卡片 · 推荐方向） */}
        <Group
          id="conversation"
          label="★★ 对话内形态（非卡片 · 推荐方向）"
          count={6}
          open={expandAll || !!openGroups.conversation}
          onToggle={() => toggleGroup('conversation')}
        >
          <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
            <p className="text-body text-foreground/80">
              不再是「卡片」：子 Agent 就是 Agent 在对话里做的一个动作，和「思考」「读文件」
              「调工具」同一类——transcript 里的一个 step，顺着读就过去了。
            </p>
            <ul className="text-caption text-muted-foreground/60 mt-1.5 space-y-0.5">
              <li>· 汇总 = Agent 自己的话（"我并行派 3 个去查"），不是 UI 头部</li>
              <li>· 分组 = 紧贴引出它的那句话，不是边框</li>
              <li>· 状态 = 跑时是「正在做的 step」，完了沉淀成「叙述记录」，不是计数器</li>
              <li>· 控制 = hover 才浮现的轻动作（取消 / 打开完整对话），不是常驻按钮条</li>
            </ul>
            <p className="text-caption text-muted-foreground/60 mt-1.5">
              下面用一段模拟对话演示「运行中 → 已完成」两态。点子任务行可就地 peek 子对话。
            </p>
          </div>

          <Section
            title="字段版 · 任务 · 当前动作 · 模型（按反馈定义）"
            desc="每条 3 个字段：任务（主文本）/ 当前动作（活的：正在思考→阅读 xxx→运行 xxx→完成）/ 模型名（行尾灰字）。状态靠字形 ↻✓✗○，结果归到 Agent 收口句"
          >
            <div className="space-y-4">
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormFielded state="running" />
              </div>
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormFielded state="done" />
              </div>
            </div>
          </Section>

          <Section
            title="基线 · 动作流 — 运行中"
            desc="任务 + 结果都在行内。子任务作为「正在做的 step」跟在 Agent 的话后面，spinner 在转"
          >
            <div className="rounded-lg bg-background px-4 py-4">
              <SubagentConversationForm state="running" />
            </div>
          </Section>

          <Section
            title="基线 · 动作流 — 已完成（点行展开看子对话）"
            desc="跑完后沉淀成叙述的一部分——失败是唯一带色的信号；Agent 用自己的话收口"
          >
            <div className="rounded-lg bg-background px-4 py-4">
              <SubagentConversationForm state="done" />
            </div>
          </Section>

          <Section
            title="变体甲 · 融进句子（结果即文本）"
            desc="不列表——三个结果直接织进 Agent 一句话，竞品名是可点的实体（hover 显可点）。最可读，代价是「有子 Agent 在跑」最不显眼"
          >
            <div className="space-y-4">
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormInlineProse state="running" />
              </div>
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormInlineProse state="done" />
              </div>
            </div>
          </Section>

          <Section
            title="变体乙 · 自检清单（看着计划被完成）"
            desc="行内只有任务（○ 待办 → ↻ 进行 → ✓/✗ 终态），结果归到收口那句话。列表极干净，进度感最强"
          >
            <div className="space-y-4">
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormChecklist state="running" />
              </div>
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormChecklist state="done" />
              </div>
            </div>
          </Section>

          <Section
            title="变体丙 · 回执简报（谁查到了什么）"
            desc="以「发现」为主角（任务名省略），actor 退成灰字前缀，读下来像一份精简回执。失败是唯一带色信号"
          >
            <div className="space-y-4">
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormReportBack state="running" />
              </div>
              <div className="rounded-lg bg-background px-4 py-4">
                <SubagentFormReportBack state="done" />
              </div>
            </div>
          </Section>
        </Group>

        {/* ★ 聚合卡重设计候选 */}
        <Group
          id="redesign"
          label="★ 聚合卡重设计候选（仍是卡片思路 · 留作对比）"
          count={3}
          open={expandAll || !!openGroups.redesign}
          onToggle={() => toggleGroup('redesign')}
        >
          <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
            <p className="text-body text-foreground/80">
              三个方向统一走「单色优先」：去掉逐行竖线、去掉身份彩色圆点，状态不再用红黄绿蓝
              一把抓——进行中 / 排队 / 完成 / 取消全部灰阶，靠图标形状 + 文案区分。
              整套卡片唯一的语义色是「失败」（需要你处理）。身份退成次要灰字标签，层次靠字号 / 透明度 / 留白，不靠颜色。
            </p>
            <p className="text-caption text-muted-foreground/60 mt-1.5">
              告诉我选哪个（A 极简单行 / B 双行 / C 折叠摘要），我再回填到正式组件并接上真实交互。
            </p>
          </div>

          <Section
            title="候选 A · 极简单行"
            desc="最紧凑——一行一个子任务，灰阶图标领头、任务名最重、身份与用时退次要灰。多并行也不喧闹"
          >
            <div className="space-y-5">
              <div>
                <Tag>5 个混合状态</Tag>
                <SubagentRedesignMinimalRow sessionId={PREVIEW_SESSION_ID} runs={MOCK_AGGREGATE_RUNS} />
              </div>
              <div>
                <Tag>2 个均完成</Tag>
                <SubagentRedesignMinimalRow sessionId={PREVIEW_SESSION_ID} runs={MOCK_AGGREGATE_RUNS_TWO_DONE} />
              </div>
            </div>
          </Section>

          <Section
            title="候选 B · 双行（标题 + 次要灰行）"
            desc="可读性最高——标题独占一行，身份 / 步数 / 工具 / 用时退到第二行灰字。"
          >
            <div className="space-y-5">
              <div>
                <Tag>5 个混合状态</Tag>
                <SubagentRedesignTwoLine sessionId={PREVIEW_SESSION_ID} runs={MOCK_AGGREGATE_RUNS} />
              </div>
              <div>
                <Tag>2 个均完成</Tag>
                <SubagentRedesignTwoLine sessionId={PREVIEW_SESSION_ID} runs={MOCK_AGGREGATE_RUNS_TWO_DONE} />
              </div>
            </div>
          </Section>

          <Section
            title="候选 C · 折叠摘要"
            desc="最克制——默认一行：完成态显 ✓、进行中显 spinner + 状态摘要，点开才铺开详情。多并行时不占满屏幕"
          >
            <div className="space-y-5">
              <div>
                <Tag>5 个混合状态（点标题行展开）</Tag>
                <SubagentRedesignFoldSummary sessionId={PREVIEW_SESSION_ID} runs={MOCK_AGGREGATE_RUNS} />
              </div>
              <div>
                <Tag>2 个均完成</Tag>
                <SubagentRedesignFoldSummary sessionId={PREVIEW_SESSION_ID} runs={MOCK_AGGREGATE_RUNS_TWO_DONE} />
              </div>
            </div>
          </Section>
        </Group>

        {/* A. SubagentProgressCard — #identity 锚点兼容旧 URL（已退出主流程，仅留档对比） */}
        <Group
          id="identity"
          label="A. 进度卡片 SubagentProgressCard（已退出主流程 · 仅留档）"
          count={8}
          open={expandAll || !!openGroups.identity}
          onToggle={() => toggleGroup('identity')}
        >
          <Section
            title="全部状态"
            desc="pending / queued / running / completed / failed / cancelled / unknown — 容器永远 bg-background + border-border/40"
          >
            <div className="space-y-2">
              <SubagentProgressCard
                subagentRunId="demo-completed"
                label="搜索相关代码"
                task="在 monorepo 中搜索 Subagent 相关组件并汇总"
                sessionId={PREVIEW_SESSION_ID}
                speakerId={PREVIEW_RUN_ID}
                status="completed"
                stepCount={5}
                latestTool="code_search"
                summary="找到 3 个核心组件：ProgressCard、AggregateView、DetailDrawer"
                elapsedMs={3200}
                stats={{ total_tokens: 4200, input_tokens: 3100, output_tokens: 1100, credits_consumed: 12 }}
                toolHistory={[...MOCK_TOOL_HISTORY]}
              />
              <SubagentProgressCard
                subagentRunId="demo-running"
                label="分析依赖关系"
                task="分析 packages/agent-runtime 对 chat 组件的依赖"
                sessionId={PREVIEW_SESSION_ID}
                speakerId="spk-analyst"
                status="running"
                stepCount={3}
                latestTool="file_read"
                latestToolStatus="pending"
                startedAt={Math.floor(Date.now() / 1000) - 45}
              />
              <SubagentProgressCard
                subagentRunId="demo-queued"
                label="等待槽位"
                task="生成季度汇总报告（BudgetTracker 排队中）"
                sessionId={PREVIEW_SESSION_ID}
                status="queued"
                onCancel={noopCancel}
              />
              <SubagentProgressCard
                subagentRunId="demo-failed"
                label="执行测试用例"
                task="运行 SubagentProgressCard 单测并修复失败用例"
                sessionId={PREVIEW_SESSION_ID}
                status="failed"
                error="执行失败 —— 可重试一次或调整任务描述"
                errorKind="failed"
                elapsedMs={1500}
                toolHistory={[...MOCK_TOOL_HISTORY]}
                onCancel={noopCancel}
              />
              <SubagentProgressCard
                subagentRunId="demo-timeout"
                label="超时任务"
                task="长时间 web 抓取任务"
                sessionId={PREVIEW_SESSION_ID}
                status="failed"
                errorKind="timeout"
                timeoutMs={300_000}
                error="执行超过 5 分钟自动停止"
              />
              <SubagentProgressCard
                subagentRunId="demo-pending"
                label="等待启动"
                status="pending"
              />
              <SubagentProgressCard
                subagentRunId="demo-cancelled"
                label="已取消的任务"
                status="cancelled"
                elapsedMs={800}
              />
              <SubagentProgressCard
                subagentRunId="demo-unknown"
                label="历史快照（状态未知）"
                status="unknown"
                stepCount={2}
              />
            </div>
          </Section>

          <Section title="取消中 / isCancelling" desc="W4c · 服务端 ACK 前显示「取消中…」而非 X 按钮">
            <SubagentProgressCard
              subagentRunId="run-cancel-demo"
              label="正在取消的子任务"
              status="running"
              stepCount={2}
              latestTool="bash"
              isCancelling
              onCancel={noopCancel}
            />
          </Section>
        </Group>

        {/* B. SubagentAggregateView */}
        <Group
          id="aggregate"
          label="B. 聚合视图 SubagentAggregateView（已上线对话内 step 形态）"
          count={4}
          open={expandAll || !!openGroups.aggregate}
          onToggle={() => toggleGroup('aggregate')}
        >
          <Section
            title="单个子 Agent（1 个 = 1 行 step · 与并行同款）"
            desc="2026-05-29 起单个子 Agent 也走此组件（runs.length=1），不再是 SubagentProgressCard 卡片——1 个和 ≥2 个视觉一致"
          >
            <SubagentAggregateView
              sessionId={PREVIEW_SESSION_ID}
              runs={MOCK_AGGREGATE_RUNS.slice(0, 1)}
              onCancel={noopCancel}
              expectedCount={1}
            />
          </Section>

          <Section
            title="多状态并行（≥2 自动聚合 · 已是对话内 step 形态）"
            desc="任务 · 当前动作带对象 · 角色·模型；单色、无竖线、无头部；hover 出取消/重试；drill-in 整行点"
          >
            <SubagentAggregateView
              sessionId={PREVIEW_SESSION_ID}
              runs={MOCK_AGGREGATE_RUNS}
              onCancel={noopCancel}
            />
          </Section>

          <Section title="默认折叠" desc="defaultCollapsed — 同 turn 多子任务不占满屏幕">
            <SubagentAggregateView
              sessionId={PREVIEW_SESSION_ID}
              runs={MOCK_AGGREGATE_RUNS.slice(0, 3)}
              onCancel={noopCancel}
              defaultCollapsed
            />
          </Section>

          <Section title="全终态 + skeleton 窗口期" desc="expectedCount 大于 runs.length 时补「连接中…」占位行">
            <SubagentAggregateView
              sessionId={PREVIEW_SESSION_ID}
              runs={MOCK_AGGREGATE_RUNS_ALL_DONE}
              expectedCount={5}
            />
          </Section>
        </Group>

        {/* C. SubagentDetailPane（替代旧抽屉） */}
        <Group
          id="pane"
          label="C. 详情 Pane SubagentDetailPane"
          count={3}
          open={expandAll || !!openGroups.pane}
          onToggle={() => toggleGroup('pane')}
        >
          <Section title="Messages / Snapshots / Events 三件套" desc="预填充 mock 数据，无需 IPC">
            <PanePreviewHost
              parentSessionId={PREVIEW_SESSION_ID}
              subagentRunId={PREVIEW_RUN_ID}
              label="正常态 · 三 tab 均有数据"
            />
          </Section>

          <Section title="错误态" desc="subagent_not_found → 中文人话 + 重试按钮">
            <PanePreviewHost
              parentSessionId={PREVIEW_SESSION_ID}
              subagentRunId={PREVIEW_RUN_ERROR_ID}
              label="错误态 · messages tab"
            />
          </Section>

          <Section title="截断横幅" desc="truncated=true 时显示「仅显示前 N 行」行动指引">
            <PanePreviewHost
              parentSessionId={PREVIEW_SESSION_ID}
              subagentRunId="run-preview-truncated"
              label="截断态 · messages 仅 2 行"
            />
          </Section>
        </Group>

        {/* D. SubAgentPanel mock */}
        <Group
          id="settings"
          label="D. 模板配置 SubAgentPanel"
          count={2}
          open={expandAll || !!openGroups.settings}
          onToggle={() => toggleGroup('settings')}
        >
          <Section title="模板列表 TemplateCard" desc="Space 设置 · workspace 专属 · 静态 mock（完整面板需后端 API）">
            <div className="space-y-2">
              <SubAgentTemplateCardMock
                icon="🔍"
                name="代码审查专家"
                typeLabel="执行型"
                description="专注安全性、边界条件和可维护性，适合 PR 审查和重构建议"
                meta="模型：claude-4-sonnet · 思维：medium · TabCode · v3"
              />
              <SubAgentTemplateCardMock
                icon="📊"
                name="数据分析师"
                typeLabel="探索型"
                description="快速探索 TabData 表结构和数据分布，输出洞察摘要"
                meta="模型：跟随系统默认 · TabData · v1"
              />
              <SubAgentTemplateCardMock
                name="已禁用模板"
                typeLabel="规划型"
                description="此模板已禁用，运行时不会被主 Agent 召唤"
                enabled={false}
              />
            </div>
          </Section>

          <Section title="编辑表单 TemplateEditor" desc="创建 / 编辑子 Agent 模板的核心字段">
            <SubAgentEditorMock />
          </Section>
        </Group>

        {/* E. SpeakerBadge */}
        <Group
          id="speaker"
          label="E. 身份徽章 SpeakerBadge / TurnAgentBadge"
          count={3}
          open={expandAll || !!openGroups.speaker}
          onToggle={() => toggleGroup('speaker')}
        >
          <Section title="模板来源 / 继承来源" desc="SubagentProgressCard 头部 + AggregateView 行首色条的数据源">
            <div className="flex flex-wrap items-center gap-3">
              <SpeakerBadge sessionId={PREVIEW_SESSION_ID} speakerId={PREVIEW_RUN_ID} />
              <SpeakerBadge sessionId={PREVIEW_SESSION_ID} speakerId="spk-analyst" />
              <SpeakerBadge sessionId={PREVIEW_SESSION_ID} speakerId="spk-researcher" />
            </div>
          </Section>

          <Section title="未注册 speaker" desc="speakerRegistry 查无记录 → 不渲染">
            <div className="flex items-center gap-2 text-body text-muted-foreground/60">
              <span>（空白 — 无 badge）</span>
              <SpeakerBadge sessionId={PREVIEW_SESSION_ID} speakerId="nonexistent-speaker" />
            </div>
          </Section>

          <Section title="轮次身份 TurnAgentBadge" desc="消息气泡顶部的 turn 级 Agent 身份（agentCache 已 seed）">
            <div className="flex flex-col items-start gap-2">
              <TurnAgentBadge agentId="agent-preview-titan" />
              <TurnAgentBadge agentId="agent-preview-charing" />
              <TurnAgentBadge agentId="agent-preview-tablebro" />
              <TurnAgentBadge agentId="agent-preview-ada" />
            </div>
          </Section>
        </Group>
      </div>
    </div>
  )
}
