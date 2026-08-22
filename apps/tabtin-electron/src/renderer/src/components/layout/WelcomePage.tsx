/**
 * WelcomePage — 新用户引导页
 *
 * 两种状态：
 * 1. 未登录：以"看见 Agent 真的在做事"为核心的引导。
 *    - 主区域：hero 文案 + 一段会动的 Agent 工作演示（克制视觉）
 *    - CTA（登录 / 注册）由侧边栏 GuestSidebarCard 承载，不在主区域重复
 * 2. 已登录但无 Space：解释 Space 概念 + 创建引导
 *
 * 视觉遵循 docs/design-system.md：呼吸感、克制、温暖中性、彩色 ≤ 5%、
 * 阴影极轻、字号语义化、禁用 pulse/bounce 动画。
 */

import React, { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { Check, FolderOpen, MessageCircle, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useCreateSpaceFlow } from '@components/sidebar/NewSpaceButton'
import { CreateConversationDialog } from '@components/tabchat/CreateConversationDialog'
import { cn } from '@utils/cn'
import {
  CANVAS_TEXT_EYEBROW,
  CANVAS_TEXT_META,
  CANVAS_TEXT_MICRO,
  CANVAS_TEXT_SECONDARY,
} from './canvasUi'
import { CONTEXT_PAGE_SHELL } from '@components/context-space/constants'

export const WelcomePage: React.FC = () => {
  const isAuthenticated = useAuthStore(selectIsAuthenticated)

  return isAuthenticated ? <AuthenticatedWelcome /> : <GuestWelcome />
}

// ---------------------------------------------------------------------------
// 未登录：以 Agent 工作演示为核心的产品介绍（CTA 由侧边栏承载）
// ---------------------------------------------------------------------------

const GuestWelcome: React.FC = () => {
  const { t } = useTranslation('organization')

  return (
    <div className="h-full flex items-start sm:items-center justify-center overflow-y-auto select-none">
      <div className={cn(CONTEXT_PAGE_SHELL, 'w-full max-w-3xl xl:max-w-4xl space-y-10 sm:space-y-12')}>
        <Hook t={t} />
        <AgentLiveDemo t={t} />
        <FootNote t={t} />
      </div>
    </div>
  )
}

// ── Hook ────────────────────────────────────────────────────────────────────

const Hook: React.FC<{ t: TFunction<'organization'> }> = ({ t }) => (
  <div className="space-y-4">
    <h1 className="text-heading sm:text-display font-semibold text-foreground tracking-tight leading-[1.15]">
      {t('welcome.guest.hookLine1', 'AI 不再只是')}
      <br />
      <span className="text-accent">{t('welcome.guest.hookLine2', '一个聊天框')}</span>
    </h1>
    <p className="text-body sm:text-subtitle text-muted-foreground leading-relaxed">
      {t(
        'welcome.guest.subtitleLead',
        '在 TabTin，Agent 真的在做事——上网调研、抓数据、做表格、写报告、做 PPT。',
      )}
      <span className="text-foreground/80">
        {t('welcome.guest.subtitleEmphasis', '每一步，全程可见。')}
      </span>
    </p>
  </div>
)

// ── 脚注（替代厚重的 trust signal 行） ─────────────────────────────────────

const FootNote: React.FC<{ t: TFunction<'organization'> }> = ({ t }) => (
  <p className={CANVAS_TEXT_SECONDARY}>
    {t('welcome.guest.footnote', '统一接入主流大模型 · 38+ AI 工作场景')}
  </p>
)

// ── Agent Live Demo（克制版） ──────────────────────────────────────────────

const TICK_MS = 100
const TOTAL_FRAMES = 230 // ≈ 23s 一个完整循环
const FRAMES_PER_STEP = 16
const WRITING_START = FRAMES_PER_STEP * 3 // 第 4 步「撰写研报」触发右侧文档打字
const WRITING_FRAMES = 80 // 打字时长固定，与文案长度无关（中英文节奏一致）
const REPORT_STEP_IDX = 3 // 「撰写研报」对应右侧文档面板

function useAnimationTick(period: number, intervalMs: number) {
  const [tick, setTick] = useState(0)
  const tickRef = useRef(0)

  useEffect(() => {
    const id = setInterval(() => {
      tickRef.current = (tickRef.current + 1) % period
      setTick(tickRef.current)
    }, intervalMs)
    return () => clearInterval(id)
  }, [period, intervalMs])

  return tick
}

const AgentLiveDemo: React.FC<{ t: TFunction<'organization'> }> = ({ t }) => {
  const tick = useAnimationTick(TOTAL_FRAMES, TICK_MS)
  const steps = [
    {
      label: t('welcome.guest.demo.steps.browse.label', '调研最近融资的企业'),
      detail: t(
        'welcome.guest.demo.steps.browse.detail',
        'TabTin 浏览器 · 36氪 · IT桔子 · Crunchbase',
      ),
    },
    {
      label: t('welcome.guest.demo.steps.collect.label', '抓取轮次、金额、投资方'),
      detail: t('welcome.guest.demo.steps.collect.detail', '已收集 18 笔融资事件'),
    },
    {
      label: t('welcome.guest.demo.steps.writeData.label', '写入 融资数据.tabdata'),
      detail: t('welcome.guest.demo.steps.writeData.detail', '18 行已结构化入表'),
    },
    {
      label: t('welcome.guest.demo.steps.writeReport.label', '撰写 投融资研报.tabdoc'),
      detail: t('welcome.guest.demo.steps.writeReport.detail', '按赛道与轮次归类'),
    },
    {
      label: t('welcome.guest.demo.steps.makeSlides.label', '生成 融资周报.tabslide'),
      detail: t('welcome.guest.demo.steps.makeSlides.detail', '12 页 · 自动套用模板'),
    },
    {
      label: t('welcome.guest.demo.steps.schedule.label', '设定每周自动化任务'),
      detail: t('welcome.guest.demo.steps.schedule.detail', '每周一自动重跑整条流程'),
    },
  ] as const
  const reportText = t(
    'welcome.guest.demo.reportBody',
    '本周共追踪 18 笔融资事件，集中在 AI 基础设施、企业服务与新能源三条赛道。早期轮次（天使—A 轮）占比 61%，单笔金额中位数约 2,400 万元；B 轮及以后明显向头部项目集中。建议重点关注 AI Infra 赛道连续加注的 3 家标的，已在表格中标记并附投资方背景。',
  )

  // 时间轴：前 3 步依次完成 → 第 4 步触发右侧文档打字（定长，中英文节奏一致）
  // → 文档写完后，最后两步（PPT、自动化）依次点亮 → 停留 → 循环
  const isWriting = tick >= WRITING_START
  const writeProgress = isWriting ? Math.min(1, (tick - WRITING_START) / WRITING_FRAMES) : 0
  const charsTyped = Math.floor(reportText.length * writeProgress)
  const writingFinished = isWriting && writeProgress >= 1
  const writingDoneTick = WRITING_START + WRITING_FRAMES

  let completedSteps: number
  if (!isWriting) {
    completedSteps = Math.min(REPORT_STEP_IDX, Math.floor(tick / FRAMES_PER_STEP))
  } else if (!writingFinished) {
    completedSteps = REPORT_STEP_IDX
  } else {
    completedSteps = Math.min(
      steps.length,
      REPORT_STEP_IDX + 1 + Math.floor((tick - writingDoneTick) / FRAMES_PER_STEP),
    )
  }
  const progressPercent = Math.round(writeProgress * 100)
  const showCaret = isWriting && charsTyped < reportText.length

  return (
    <div className="rounded-lg border border-border/60 bg-background overflow-hidden shadow-[0_4px_20px_hsl(var(--foreground)/0.04)]">
      {/* Tab 栏（统一与 ContextTabs 风格相近的 light 设计） */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-muted/30">
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
          <DemoTab icon="🌐" label={t('welcome.guest.demo.tabs.browser', 'TabTin 浏览器')} />
          <DemoTab icon="📊" label={t('welcome.guest.demo.tabs.data', '融资数据.tabdata')} />
          <DemoTab icon="📝" label={t('welcome.guest.demo.tabs.report', '投融资研报.tabdoc')} active />
          <DemoTab icon="📑" label={t('welcome.guest.demo.tabs.slides', '融资周报.tabslide')} />
        </div>
      </div>

      {/* 主体：左 Agent 步骤流 / 右 文档面板 */}
      <div className="grid grid-cols-1 sm:grid-cols-12">
        {/* 左：Agent 任务流 */}
        <div className="sm:col-span-5 sm:border-r border-b sm:border-b-0 border-border/40 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-accent/[0.08] flex items-center justify-center">
              <span className={cn('font-semibold text-accent', CANVAS_TEXT_MICRO)}>A</span>
            </div>
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground truncate leading-tight">
                {t('welcome.guest.demo.agentTitle', 'Agent · 投融资研究')}
              </div>
              <div className={CANVAS_TEXT_META}>
                {t('welcome.guest.demo.agentModel', '每周一 09:00 定时运行')}
              </div>
            </div>
          </div>

          <ul className="space-y-3">
            {steps.map((step, idx) => {
              const status: 'done' | 'doing' | 'pending' =
                idx < completedSteps ? 'done' : idx === completedSteps ? 'doing' : 'pending'
              return <StepItem key={step.label} step={step} status={status} />
            })}
          </ul>
        </div>

        {/* 右：正在写的文档 */}
        <div className="sm:col-span-7 p-5 min-h-[260px] flex flex-col">
          <div className={cn('mb-3 flex items-center justify-between', CANVAS_TEXT_META)}>
            <span>📝 {t('welcome.guest.demo.tabs.report', '投融资研报.tabdoc')}</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{progressPercent}%</span>
              <span className="block h-1 w-14 rounded-full bg-muted overflow-hidden">
                <span
                  className="block h-full bg-accent transition-all duration-100"
                  style={{ width: `${progressPercent}%` }}
                />
              </span>
            </span>
          </div>

          <div className="space-y-3 flex-1">
            <h3 className="text-subtitle font-semibold text-foreground leading-tight">
              {t('welcome.guest.demo.reportTitle', '本周投融资市场观察')}
            </h3>
            <p className="text-body text-foreground/80 leading-[1.75] break-words">
              {reportText.slice(0, charsTyped)}
              {showCaret && (
                <span
                  aria-hidden
                  className="inline-block w-[2px] h-[14px] bg-accent/80 ml-0.5 align-middle"
                />
              )}
            </p>
          </div>
        </div>
      </div>

      {/* 底部状态栏（极轻） */}
      <div className={cn('flex items-center justify-between border-t border-border/40 px-4 py-2', CANVAS_TEXT_META)}>
        <span className="flex items-center gap-1.5">
          <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
          {t('welcome.guest.demo.status', 'Agent 正在工作')}
        </span>
        <span className="hidden sm:inline">
          {t('welcome.guest.demo.protection', '4 个 App 协同 · 每周自动重跑 · Checkpoint 已保护')}
        </span>
      </div>
    </div>
  )
}

// ── Tab ─────────────────────────────────────────────────────────────────────

const DemoTab: React.FC<{ icon: string; label: string; active?: boolean }> = ({
  icon,
  label,
  active = false,
}) => (
  <span
    className={cn(
      'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors',
      CANVAS_TEXT_META,
      active
        ? 'bg-background text-foreground border border-border/60'
        : 'text-muted-foreground/60',
    )}
  >
    <span>{icon}</span>
    <span className="font-medium">{label}</span>
  </span>
)

// ── 步骤项 ──────────────────────────────────────────────────────────────────

interface StepItemProps {
  step: { label: string; detail: string }
  status: 'done' | 'doing' | 'pending'
}

const StepItem: React.FC<StepItemProps> = ({ step, status }) => (
  <li className="flex items-start gap-2.5">
    <span className="mt-0.5 shrink-0">
      {status === 'done' && (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent/[0.10]">
          <Check className="h-2.5 w-2.5 text-accent" strokeWidth={3} />
        </span>
      )}
      {status === 'doing' && (
        <span
          className="block h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin"
          style={{ animationDuration: '900ms' }}
        />
      )}
      {status === 'pending' && (
        <span className="block h-4 w-4 rounded-full border-2 border-border" />
      )}
    </span>
    <div className={cn('flex-1 min-w-0', status === 'pending' && 'opacity-50')}>
      <div className="text-body text-foreground leading-tight">{step.label}</div>
      <div className={cn('mt-0.5 truncate', CANVAS_TEXT_SECONDARY)}>
        {step.detail}
      </div>
    </div>
  </li>
)

// ---------------------------------------------------------------------------
// 已登录但无 Agent：解释概念 + 创建引导
// ---------------------------------------------------------------------------

const AuthenticatedWelcome: React.FC = () => {
  const { t } = useTranslation('organization')
  const userId = useAuthStore(state => state.user?.id ?? null)
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const currentUserRole = useOrganizationStore(state => state.currentUserRole)
  // ：欢迎页创建第一个 Space 直接打开 CreateSpaceDialog，不再先弹 OS 选目录窗。
  // 目录是 dialog 里的可选高级项，不选则用默认沙箱（与 NewSpaceButton 同一套流程）。
  const { triggerCreate } = useCreateSpaceFlow()
  const [isCreateConversationOpen, setIsCreateConversationOpen] = useState(false)
  const isJoinedTeamContext =
    selectedOrganization?.type === 'team' &&
    (
      currentUserRole
        ? currentUserRole !== 'owner'
        : Boolean(userId && String(selectedOrganization.owner_id) !== String(userId))
    )
  const organizationName = selectedOrganization?.name ?? t('unnamed', { defaultValue: '组织' })

  return (
    <div className="h-full flex items-center justify-center overflow-y-auto select-none">
      <div className={cn(CONTEXT_PAGE_SHELL, 'w-full max-w-lg space-y-8')}>
        {/* Hero */}
        <div className="text-center space-y-4">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center">
            {isJoinedTeamContext ? (
              <Users className="h-7 w-7 text-accent" />
            ) : (
              <span className="text-heading select-none">🎉</span>
            )}
          </div>
          <h2 className="text-heading font-semibold text-foreground">
            {isJoinedTeamContext
              ? t('welcome.joinedTeamTitle', {
                  name: organizationName,
                  defaultValue: '已加入「{{name}}」',
                })
              : t('welcome.readyTitle', '准备好了！')}
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            {isJoinedTeamContext
              ? t('welcome.joinedTeamDesc', {
                  defaultValue:
                    '你已经是这个组织的成员。这个组织还没有可打开的 Space，可在这里创建一个 Space，或从左侧切换到其他组织。',
                })
              : t(
                  'welcome.readyDesc',
                  '创建你的第一个工作空间开始工作。',
                )}
          </p>
        </div>

        {/* 主 CTA：创建第一个 Space（外部 Agent 历史导入见任务侧栏「导入数据」） */}
        <div className="flex flex-col items-stretch gap-3 sm:mx-auto sm:max-w-sm">
          <button
            type="button"
            onClick={triggerCreate}
            data-testid="welcome-create-first-workspace"
            className="group flex items-center justify-center gap-2.5 px-6 py-3 bg-accent text-accent-foreground rounded-xl font-medium hover:bg-accent/90 transition-all shadow-sm"
          >
            <FolderOpen className="h-5 w-5" />
            <span>
              {isJoinedTeamContext
                ? t('welcome.createTeamSpace', { defaultValue: '在此组织创建 Space' })
                : t('welcome.createFirstAgent', '创建第一个 Space')}
            </span>
          </button>
        </div>

        {/* 分隔 */}
        <div className="flex items-center gap-4">
          <div className="flex-1 border-t border-border/30" />
          <span className="text-body text-muted-foreground/60">
            {t('welcome.orCollaborate', '或者，与他人协作')}
          </span>
          <div className="flex-1 border-t border-border/30" />
        </div>

        {/* 次要操作 */}
        <div className="flex justify-center gap-3">
          <SecondaryAction
            icon={<MessageCircle className="h-4 w-4" />}
            label={t('createGroup', '发起群聊')}
            onClick={() => setIsCreateConversationOpen(true)}
          />
        </div>
      </div>

      <CreateConversationDialog
        isOpen={isCreateConversationOpen}
        initialTab="group"
        groupOnly
        onClose={() => setIsCreateConversationOpen(false)}
      />
    </div>
  )
}

const SecondaryAction: React.FC<{
  icon: React.ReactNode
  label: string
  onClick: () => void
}> = ({ icon, label, onClick }) => (
  <button
    onClick={onClick}
    className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border/40 text-body text-muted-foreground hover:text-foreground hover:bg-muted/30 hover:border-border/60 transition-all"
  >
    {icon}
    <span>{label}</span>
  </button>
)
