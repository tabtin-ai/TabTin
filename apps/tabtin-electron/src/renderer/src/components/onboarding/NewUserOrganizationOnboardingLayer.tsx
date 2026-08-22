import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { CreateOrganizationDialog } from '@components/organization/CreateOrganizationDialog'
import { useAuthStore } from '@stores/useAuthStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useNewUserOrganizationOnboardingStore } from '@stores/useNewUserOrganizationOnboardingStore'
import type { NewUserOrganizationOnboardingStep } from '@stores/useNewUserOrganizationOnboardingStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useUIStore } from '@stores/useUIStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { cn } from '@utils/cn'
import type { Organization } from '@tabtin/app-shell'

declare global {
  interface Window {
    __tabtinNewUserOrganizationOnboarding?: {
      start: () => void
      reset: () => void
      complete: () => void
      clear: () => void
      status: () => {
        authUserId: string | number | null | undefined
        onboarding: ReturnType<typeof useNewUserOrganizationOnboardingStore.getState>
      }
    }
  }
}

const TARGET_SELECTORS: Partial<Record<NewUserOrganizationOnboardingStep, string>> = {
  me_entry: '[data-onboarding-target="new-user-organization-me-entry"]',
  team_entry: '[data-onboarding-target="new-user-organization-team-switcher"]',
  organization_choice:
    '[data-onboarding-target="new-user-organization-create-team"], [data-onboarding-target="new-user-organization-create-team-label"]',
  members_entry: '[data-onboarding-target="new-user-organization-members-entry"]',
  invite_hint: '[data-onboarding-target="new-user-organization-invite-button"]',
  agent_chat: '[data-onboarding-target="new-user-organization-agent-chat"]',
}

const STEP_INDEX: Partial<Record<NewUserOrganizationOnboardingStep, number>> = {
  intro: 1,
  me_entry: 2,
  team_entry: 3,
  organization_choice: 4,
  members_entry: 5,
  invite_hint: 6,
  agent_chat: 7,
}

const STEP_TOTAL = 7
const CARD_WIDTH = 320
const VIEWPORT_PADDING = 16

type Rect = Pick<DOMRect, 'top' | 'left' | 'width' | 'height' | 'right' | 'bottom'>

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function computeCardStyle(rect: Rect | null): React.CSSProperties {
  if (typeof window === 'undefined' || !rect) {
    return {
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
    }
  }

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - CARD_WIDTH - VIEWPORT_PADDING)
  const rightCandidate = rect.right + 14
  const leftCandidate = rect.left - CARD_WIDTH - 14
  const left = rightCandidate + CARD_WIDTH <= viewportWidth - VIEWPORT_PADDING
    ? rightCandidate
    : leftCandidate >= VIEWPORT_PADDING
      ? leftCandidate
      : clamp(rect.left, VIEWPORT_PADDING, maxLeft)
  const top = clamp(rect.top + rect.height / 2 - 90, VIEWPORT_PADDING, viewportHeight - 210)

  return {
    left,
    top,
  }
}

function useTargetRect(selector: string | undefined): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)

  useEffect(() => {
    if (!selector || typeof document === 'undefined') {
      setRect(null)
      return
    }

    const update = () => {
      const el = document.querySelector<HTMLElement>(selector)
      if (!el) {
        setRect(null)
        return
      }
      const next = el.getBoundingClientRect()
      setRect({
        top: next.top,
        left: next.left,
        right: next.right,
        bottom: next.bottom,
        width: next.width,
        height: next.height,
      })
    }

    update()
    const intervalId = window.setInterval(update, 250)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [selector])

  return rect
}

function setSidebarExpanded() {
  if (useUIStore.getState().sidebarCollapsed) {
    useUIStore.setState({ sidebarCollapsed: false })
  }
}

function setChatAvailable() {
  const ui = useUIStore.getState()
  if (ui.chatSidePanelCollapsed) {
    ui.setChatSidePanelCollapsed(false)
  }
}

export const NewUserOrganizationOnboardingLayer: React.FC = () => {
  const userId = useAuthStore(state => state.user?.id ?? null)
  const currentTab = useMainNavStore(state => state.currentTab)
  const selectedOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const activeUserId = useNewUserOrganizationOnboardingStore(state => state.activeUserId)
  const step = useNewUserOrganizationOnboardingStore(state => state.step)
  const completed = useNewUserOrganizationOnboardingStore(state => state.completed)
  const clearRuntime = useNewUserOrganizationOnboardingStore(state => state.clearRuntime)
  const resetForUser = useNewUserOrganizationOnboardingStore(state => state.resetForUser)
  const goToStep = useNewUserOrganizationOnboardingStore(state => state.goToStep)
  const skipOrganizationModule = useNewUserOrganizationOnboardingStore(state => state.skipOrganizationModule)
  const complete = useNewUserOrganizationOnboardingStore(state => state.complete)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createdOrganization, setCreatedOrganization] = useState<Organization | null>(null)

  const selector = step ? TARGET_SELECTORS[step] : undefined
  const targetRect = useTargetRect(selector)
  const cardStyle = useMemo(() => computeCardStyle(targetRect), [targetRect])

  useEffect(() => {
    if (!import.meta.env.DEV) return

    window.__tabtinNewUserOrganizationOnboarding = {
      start: () => useNewUserOrganizationOnboardingStore.getState().startForUser(
        useAuthStore.getState().user?.id,
      ),
      reset: () => useNewUserOrganizationOnboardingStore.getState().resetForUser(
        useAuthStore.getState().user?.id,
      ),
      complete: () => useNewUserOrganizationOnboardingStore.getState().complete(),
      clear: () => useNewUserOrganizationOnboardingStore.getState().clearRuntime(),
      status: () => ({
        authUserId: useAuthStore.getState().user?.id,
        onboarding: useNewUserOrganizationOnboardingStore.getState(),
      }),
    }

    return () => {
      delete window.__tabtinNewUserOrganizationOnboarding
    }
  }, [resetForUser])

  useEffect(() => {
    if (!userId) {
      clearRuntime()
    }
  }, [clearRuntime, userId])

  useEffect(() => {
    if (!step) return
    if (step === 'me_entry') {
      setSidebarExpanded()
      return
    }
    if (step === 'agent_chat') {
      useMainNavStore.getState().setCurrentTab('agent')
      setChatAvailable()
    }
  }, [step])

  useEffect(() => {
    if (step === 'me_entry' && currentTab === 'me') {
      goToStep('team_entry')
    }
  }, [currentTab, goToStep, step])

  const handleContinueIntro = useCallback(() => {
    setCreatedOrganization(null)
    setSidebarExpanded()
    goToStep('me_entry')
  }, [goToStep])

  const handleOpenMe = useCallback(() => {
    setSidebarExpanded()
    useMainNavStore.getState().setCurrentTab('me')
  }, [])

  const handleOpenTeamSwitcher = useCallback(() => {
    goToStep('organization_choice')
  }, [goToStep])

  const handleSkipOrganization = useCallback(() => {
    skipOrganizationModule()
  }, [skipOrganizationModule])

  const handleOpenCreateOrganization = useCallback(() => {
    setCreateDialogOpen(true)
    goToStep('create_organization')
  }, [goToStep])

  const handleCreateDialogClose = useCallback(() => {
    setCreateDialogOpen(false)
    if (useNewUserOrganizationOnboardingStore.getState().step === 'create_organization') {
      skipOrganizationModule()
    }
  }, [skipOrganizationModule])

  const handleOrganizationCreated = useCallback((organization: Organization) => {
    setCreateDialogOpen(false)
    setCreatedOrganization(organization)
    useMainNavStore.getState().setCurrentTab('me')
    goToStep('members_entry')
  }, [goToStep])

  const ensureCreatedOrganizationSelected = useCallback(async (): Promise<string | null> => {
    const store = useOrganizationStore.getState()
    const targetOrganization = createdOrganization ?? store.selectedOrganization
    const organizationId = targetOrganization?.id ?? selectedOrganizationId
    if (!organizationId) return null
    if (targetOrganization && store.selectedOrganization?.id !== organizationId) {
      const completed = await runWithAgentContextSwitchGuard(
        'organization',
        () => store.selectOrganization(targetOrganization),
      )
      if (!completed) return null
    }
    return organizationId
  }, [createdOrganization, selectedOrganizationId])

  const handleOpenMembers = useCallback(async () => {
    const organizationId = await ensureCreatedOrganizationSelected()
    if (!organizationId) return
    useMainNavStore.getState().setCurrentTab('me')
    useSettingsSpaceStore.getState().setRoute({
      category: 'organization',
      section: 'teamMembers',
      organizationId,
    })
    goToStep('invite_hint')
  }, [ensureCreatedOrganizationSelected, goToStep])

  const handleOpenInvite = useCallback(async () => {
    const organizationId = await ensureCreatedOrganizationSelected()
    if (organizationId) {
      useMainNavStore.getState().setCurrentTab('me')
      useSettingsSpaceStore.getState().setRoute({
        category: 'organization',
        section: 'teamMembers',
        organizationId,
      })
    }
    goToStep('invite_dialog')
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(
        '[data-onboarding-target="new-user-organization-invite-button"]',
      )?.click()
    }, 0)
  }, [ensureCreatedOrganizationSelected, goToStep])

  const handleGoAgent = useCallback(() => {
    goToStep('agent_chat')
  }, [goToStep])

  if (!userId || String(userId) !== activeUserId || !step || step === 'invite_dialog' || completed) {
    return null
  }

  if (step === 'create_organization' && createDialogOpen) {
    return (
      <CreateOrganizationDialog
        isOpen={createDialogOpen}
        onClose={handleCreateDialogClose}
        onCreated={handleOrganizationCreated}
      />
    )
  }

  const isCentered = !selector || !targetRect
  const waitsForTarget = Boolean(selector) && step !== 'agent_chat'

  if (waitsForTarget && !targetRect) {
    return (
      <CreateOrganizationDialog
        isOpen={createDialogOpen}
        onClose={handleCreateDialogClose}
        onCreated={handleOrganizationCreated}
      />
    )
  }

  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-global">
        {targetRect ? (
          <div
            className="fixed rounded-xl border border-accent/80 shadow-[0_0_0_9999px_hsl(var(--background)/0.12),0_0_0_4px_hsl(var(--accent)/0.10)]"
            style={{
              left: targetRect.left - 5,
              top: targetRect.top - 5,
              width: targetRect.width + 10,
              height: targetRect.height + 10,
            }}
          />
        ) : null}

        <div
          className={cn(
            'fixed inset-0 bg-background/60 backdrop-blur-[1px]',
            !isCentered && 'hidden',
          )}
        />

        <div
          className={cn(
            'pointer-events-auto fixed w-[320px] overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-[0_18px_50px_hsl(var(--foreground)/0.14)] backdrop-blur-xl',
            isCentered && 'max-w-[calc(100vw-32px)]',
          )}
          style={cardStyle}
        >
          <OnboardingCardContent
            step={step}
            onContinueIntro={handleContinueIntro}
            onOpenMe={handleOpenMe}
            onOpenTeamSwitcher={handleOpenTeamSwitcher}
            onSkipOrganization={handleSkipOrganization}
            onOpenCreateOrganization={handleOpenCreateOrganization}
            onOpenMembers={handleOpenMembers}
            onOpenInvite={handleOpenInvite}
            onGoAgent={handleGoAgent}
            onComplete={complete}
          />
        </div>
      </div>

      <CreateOrganizationDialog
        isOpen={createDialogOpen}
        onClose={handleCreateDialogClose}
        onCreated={handleOrganizationCreated}
      />
    </>
  )
}

interface OnboardingCardContentProps {
  step: NewUserOrganizationOnboardingStep
  onContinueIntro: () => void
  onOpenMe: () => void
  onOpenTeamSwitcher: () => void
  onSkipOrganization: () => void
  onOpenCreateOrganization: () => void
  onOpenMembers: () => void
  onOpenInvite: () => void
  onGoAgent: () => void
  onComplete: () => void
}

const OnboardingCardContent: React.FC<OnboardingCardContentProps> = ({
  step,
  onContinueIntro,
  onOpenMe,
  onOpenTeamSwitcher,
  onSkipOrganization,
  onOpenCreateOrganization,
  onOpenMembers,
  onOpenInvite,
  onGoAgent,
  onComplete,
}) => {
  if (step === 'intro') {
    return (
      <CardShell
        step={step}
        eyebrow="首次进入 TabTin"
        title="你现在在个人账号"
        body="个人账号适合自己先和 Agent 试用；如果要和别人一起协作，可以创建组织。"
      >
        <PrimaryButton onClick={onContinueIntro}>继续</PrimaryButton>
        <SecondaryButton onClick={onSkipOrganization}>跳过</SecondaryButton>
      </CardShell>
    )
  }

  if (step === 'me_entry') {
    return (
      <CardShell
        step={step}
        eyebrow="组织入口"
        title="从左上角头像进入个人与组织设置"
        body="点击继续，效果等同于点击窄栏左上角的头像，我会带你找到创建 organization 的地方。"
      >
        <PrimaryButton onClick={onOpenMe}>继续</PrimaryButton>
        <SecondaryButton onClick={onSkipOrganization}>跳过</SecondaryButton>
      </CardShell>
    )
  }

  if (step === 'team_entry') {
    return (
      <CardShell
        step={step}
        eyebrow="组织设置"
        title="点击「个人账号」"
        body="点击继续，效果等同于打开当前组织切换器。这里可以切换组织，也可以创建新的 organization。"
      >
        <PrimaryButton onClick={onOpenTeamSwitcher}>继续</PrimaryButton>
        <SecondaryButton onClick={onSkipOrganization}>跳过</SecondaryButton>
      </CardShell>
    )
  }

  if (step === 'organization_choice') {
    return (
      <CardShell
        step={step}
        eyebrow="创建 organization"
        title="点击「创建组织」"
        body="organization 用来邀请成员一起协作。点击继续会打开创建组织弹窗，也可以先跳过这部分。"
      >
        <PrimaryButton onClick={onOpenCreateOrganization}>继续</PrimaryButton>
        <SecondaryButton onClick={onSkipOrganization}>跳过</SecondaryButton>
      </CardShell>
    )
  }

  if (step === 'create_organization') {
    return (
      <CardShell
        step={step}
        eyebrow="创建中"
        title="填写 organization 名称"
        body="创建成功后，我会告诉你在哪里邀请成员，然后带你回到 Agent 对话。"
      >
        <PrimaryButton onClick={onOpenCreateOrganization}>继续</PrimaryButton>
        <SecondaryButton onClick={onSkipOrganization}>跳过</SecondaryButton>
      </CardShell>
    )
  }

  if (step === 'members_entry') {
    return (
      <CardShell
        step={step}
        eyebrow="Organization 已创建"
        title="点击「成员与额度」"
        body="你刚创建的是免费组织，具体资源额度以「会员与credits」页展示的免费版权益为准。点击继续会进入成员页，你可以在右上角邀请成员。"
      >
        <PrimaryButton onClick={onOpenMembers}>继续</PrimaryButton>
        <SecondaryButton onClick={onGoAgent}>跳过</SecondaryButton>
      </CardShell>
    )
  }

  if (step === 'invite_hint') {
    return (
      <CardShell
        step={step}
        eyebrow="Organization 已创建"
        title="点击「邀请」"
        body="你可以在这里邀请成员加入组织。点击继续会打开邀请弹窗；关闭弹窗后，我会带你回到 Agent 对话。"
      >
        <PrimaryButton onClick={onOpenInvite}>继续</PrimaryButton>
        <SecondaryButton onClick={onGoAgent}>跳过</SecondaryButton>
      </CardShell>
    )
  }

  return (
    <CardShell
      step={step}
      eyebrow="开始工作"
      title="现在可以直接和 Agent 对话"
      body="你可以先让 Agent 帮你做第一件事。创建组织和邀请成员之后也可以随时再做。"
    >
      <PrimaryButton onClick={onComplete}>
        <Check className="h-3.5 w-3.5" />
        继续
      </PrimaryButton>
      <SecondaryButton onClick={onComplete}>跳过</SecondaryButton>
    </CardShell>
  )
}

interface CardShellProps {
  step: NewUserOrganizationOnboardingStep
  eyebrow: string
  title: string
  body: string
  children: React.ReactNode
}

const CardShell: React.FC<CardShellProps> = ({ step, eyebrow, title, body, children }) => (
  <div className="p-4">
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-caption font-medium leading-none text-accent">
        {eyebrow}
      </span>
      <span className="text-caption font-medium text-muted-foreground/60">
        {typeof STEP_INDEX[step] === 'number'
          ? `${STEP_INDEX[step]}/${STEP_TOTAL}`
          : null}
      </span>
    </div>
    <div className="mt-3 space-y-1.5">
      <div className="text-subtitle font-semibold leading-snug text-foreground">
        {title}
      </div>
      <p className="text-body leading-relaxed text-muted-foreground">{body}</p>
    </div>
    <div className="mt-4 flex items-center justify-end gap-2">{children}</div>
  </div>
)

const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  className,
  children,
  ...props
}) => (
  <button
    type="button"
    className={cn(
      'inline-flex h-8 min-w-[72px] items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-body font-medium leading-none text-accent-foreground',
      'shadow-sm hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
      className,
    )}
    {...props}
  >
    {children}
  </button>
)

const SecondaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  className,
  children,
  ...props
}) => (
  <button
    type="button"
    className={cn(
      'inline-flex h-8 min-w-[72px] items-center justify-center rounded-lg px-3 text-body font-medium leading-none text-muted-foreground',
      'hover:bg-muted/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20',
      className,
    )}
    {...props}
  >
    {children}
  </button>
)
