/**
 * AgentSettingsSheet — Agent 档案侧边设置面板
 *
 * 由 `useAgentSettingsSheetStore` 驱动，每次只展开一个模块。
 * Sheet 自身只提供"宽度 + 阴影 + 关闭按钮"的薄外壳，内容沿用 `SpaceSettingsPane`
 * 现有的右内容区 layout（`flex-col min-h-0` + 各子面板自治），保证零侵入。
 *
 * 复用 tabdata 的 `FieldSettingPanel` 同款 pattern：
 *   - `Sheet modal={false}` + `SheetContent overlay={false}` —— 非模态、无遮罩
 *   - `onInteractOutside` / `onPointerDownOutside` 阻止点外部关闭，必须主动关闭
 *   - 通过 `OverlayContainerProvider`（在 SpaceSettingsPane 外层）scoped 到面板内
 */

import React, { useCallback, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  ScrollArea,
  OverlayContainerProvider,
} from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { SIDEBAR_SCROLLBAR_TYPE } from '@components/layout/sidebarUi'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { canEditAgentSettings as canEditAgentSettingsFn } from '@/hooks/useCanEditAgentSettings'
import {
  effectiveCanEditAgentSettings,
  useSpaceSettingsEditGuard,
} from './hooks/useSpaceSettingsEditGuard'
import { RemoteSettingsReadonlyNotice } from './RemoteSettingsReadonlyNotice'
import {
  useAgentSettingsSheetStore,
  type AgentSettingsSection,
} from '@stores/useAgentSettingsSheetStore'
import type { Space } from '@tabtin/app-shell'
import { SettingsSectionContext } from './SettingsSectionContext'

import { AgentSecurityPanel } from './AgentSecurityPanel'
import { ExecutionLimitsPanel } from './ExecutionLimitsPanel'
import { MemoryPanel } from './MemoryPanel'
import { SubAgentPanel } from './SubAgentPanel'
import { ArchivedChatSessionsSection } from './ArchivedChatSessionsSection'
import { SessionExpiredNotice } from './SessionExpiredNotice'
import { ProfileIdentityForm } from './profile/ProfileIdentityForm'
import { ProfileRulesForm } from './profile/ProfileRulesForm'
import { ProfileWorkingDirForm } from './profile/ProfileWorkingDirForm'

// ---------------------------------------------------------------------------
// Section title resolver
// ---------------------------------------------------------------------------

const SECTION_TITLE_KEY: Record<AgentSettingsSection, { ns: 'space'; key: string; fallback?: string }> = {
  'profile-identity': { ns: 'space', key: 'profileSheet.identityTitle' },
  'profile-rules': { ns: 'space', key: 'profileSheet.rulesTitle' },
  'working-dir': { ns: 'space', key: 'profileSheet.workingDirTitle', fallback: '工作目录' },
  memory: { ns: 'space', key: 'tabs.memory' },
  subagents: { ns: 'space', key: 'tabs.subagents' },
  extensions: { ns: 'space', key: 'tabs.extensions' },
  device: { ns: 'space', key: 'tabs.device' },
  security: { ns: 'space', key: 'tabs.agentSecurity' },
  'execution-limits': { ns: 'space', key: 'tabs.executionLimits' },
  archived: { ns: 'space', key: 'tabs.archived' },
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgentSettingsSheetProps {
  /** 当前 Agent 档案对应的 Space ID（用于权限判断和子面板数据隔离） */
  spaceId: string
}

export const AgentSettingsSheet: React.FC<AgentSettingsSheetProps> = ({ spaceId }) => {
  const sheetContentRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation('space')
  const { isOpen, section, sheetSpaceId, sheetSessionId, open, close } = useAgentSettingsSheetStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      section: s.section,
      sheetSpaceId: s.spaceId,
      sheetSessionId: s.sessionId,
      open: s.open,
      close: s.close,
    })),
  )

  // 子面板可通过 useSettingsSection().setSection 在模块间跳转。在 Sheet 形态下，
  // "切换"等价于"在同一个 Sheet 里打开新 section"。
  // （历史上的 SSHPanel"前往设备页"按钮已随 SSH 迁出至设备域而移除，但此机制保留备用。）
  const sectionContextValue = useMemo(
    () => ({
      section: section ?? '',
      setSection: (s: string) => open(s as AgentSettingsSection, spaceId, { sessionId: sheetSessionId }),
    }),
    [section, open, spaceId, sheetSessionId],
  )

  const space = useSpaceStore((state) =>
    state.spaces.find((p) => p.id === spaceId) ?? null,
  ) as Space | null
  const currentUserRole = useOrganizationStore((state) => state.currentUserRole)
  const selectedOrganization = useOrganizationStore((state) => state.selectedOrganization)
  const user = useAuthStore((state) => state.user)
  //  纵深防御：登出传导链修通后正常情况下到不了这里，但若 UI 因任何
  // 残留状态仍渲染本 Sheet，token 失效（authPhase ≠ 'authenticated'）时
  // 不再呈现可编辑表单，改为「会话已过期」提示 + 重新登录入口。
  const authPhase = useAuthStore((state) => state.authPhase)
  const isSessionActive = authPhase === 'authenticated'
  const isOwner = !!(user && selectedOrganization && user.id === selectedOrganization.owner_id)
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' : null)
  const roleCanEditAgentSettings = canEditAgentSettingsFn(effectiveRole)
  const settingsEditGuard = useSpaceSettingsEditGuard(spaceId)
  const canEditAgentSettings = effectiveCanEditAgentSettings(
    roleCanEditAgentSettings,
    settingsEditGuard,
  )

  // Sheet 只在自己的 spaceId 命中时打开（多 Agent 切换时避免错位渲染）
  const isScopedOpen = isOpen && (!sheetSpaceId || sheetSpaceId === spaceId)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && isScopedOpen) close()
    },
    [close, isScopedOpen],
  )

  // 设备已并入工作目录：旧 open('device') 仍打开同一表单，标题统一为「工作目录」
  const effectiveSection = section === 'device' ? 'working-dir' : section

  const sectionTitle = useMemo(() => {
    if (!effectiveSection) return ''
    const meta = SECTION_TITLE_KEY[effectiveSection]
    return t(meta.key, { defaultValue: meta.fallback ?? effectiveSection })
  }, [effectiveSection, t])

  const sheetContentProps = {
    side: 'right' as const,
    overlay: false,
    closeable: false,
    // container={null} 覆盖 OverlayContainerContext：侧边栏 / 对话列表等入口触发的
    // Space 设置应全局浮层展示，不应被画布区 scoped overlay 限制在内容区内。
    container: null,
    // no-drag：Sheet 顶栏落在窗口拖拽带（~36px）内时，Electron 的
    // -webkit-app-region:drag 会吞掉点击，导致右上角关闭按钮点不中。
    // 内联 style 兜底（：仅 class 在 Electron 里可能不够）。
    className:
      'app-region-no-drag no-drag w-[480px] sm:max-w-[480px] flex flex-col p-0 surface-glass-overlay',
    style: { WebkitAppRegion: 'no-drag' } as React.CSSProperties,
    onInteractOutside: (e: Event) => e.preventDefault(),
    onPointerDownOutside: (e: Event) => e.preventDefault(),
  }

  if (!space || !section) {
    // Sheet 未挂载内容时直接返回空 Sheet（保证 portal 树结构稳定）
    return (
      <Sheet open={isScopedOpen} onOpenChange={handleOpenChange} modal={false}>
        <SheetContent ref={sheetContentRef} {...sheetContentProps}>
          <SheetTitle className="sr-only">{sectionTitle || 'Agent settings'}</SheetTitle>
          <SheetDescription className="sr-only">{sectionTitle || ''}</SheetDescription>
        </SheetContent>
      </Sheet>
    )
  }

  // 渲染对应子面板。layout 与 SpaceSettingsPane 右内容区一致：
  // 大多数子面板自带 ScrollArea + 固定保存栏 + flex-col h-full，需要容器
  // 提供 `flex-1 flex flex-col min-h-0` 的高度上下文。
  const sectionBody = isSessionActive
    ? (
      <>
        {settingsEditGuard.isRemoteViewer ? (
          <RemoteSettingsReadonlyNotice
            controlDeviceName={settingsEditGuard.controlDeviceName}
            className="mb-4"
          />
        ) : null}
        {renderSectionBody({
          section: effectiveSection ?? section,
          space,
          canEditAgentSettings,
          roleCanEditAgentSettings,
          sessionId: sheetSessionId,
          onSaved: close,
        })}
      </>
    )
    : <SessionExpiredNotice />

  return (
    <Sheet open={isScopedOpen} onOpenChange={handleOpenChange} modal={false}>
      <SheetContent ref={sheetContentRef} {...sheetContentProps}>
        <OverlayContainerProvider containerRef={sheetContentRef}>
        <SettingsSectionContext.Provider value={sectionContextValue}>
          {/* a11y 必需的 SheetTitle / SheetDescription（通过 sr-only 隐藏） */}
          <SheetTitle className="sr-only">{sectionTitle}</SheetTitle>
          <SheetDescription className="sr-only">{sectionTitle}</SheetDescription>

          {/* 顶部 mini header：标题 + 关闭按钮 */}
          <div
            className="app-region-no-drag no-drag shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-border/20"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="min-w-0 flex-1">
              <h2 className="text-subtitle font-medium text-foreground truncate">
                {sectionTitle}
              </h2>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={t('actions.cancel', { defaultValue: '关闭' })}
              className="app-region-no-drag no-drag shrink-0 rounded-interactive p-1.5 text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 内容区：复用 SpaceSettingsPane 的 layout 约束，让子面板自治 */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0 px-5 py-4">
            {/* profile-* 几个简短的表单不需要 ScrollArea，直接渲染 */}
            {effectiveSection === 'profile-identity' || effectiveSection === 'profile-rules' ? (
              <ScrollArea className="flex-1 -mx-5 px-5" scrollBar="vertical" type={SIDEBAR_SCROLLBAR_TYPE}>
                {sectionBody}
              </ScrollArea>
            ) : (
              <div className="flex-1 flex flex-col min-h-0 w-full">{sectionBody}</div>
            )}
          </div>
        </SettingsSectionContext.Provider>
        </OverlayContainerProvider>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Section body switcher
// ---------------------------------------------------------------------------

interface SectionBodyProps {
  section: AgentSettingsSection
  space: Space
  canEditAgentSettings: boolean
  roleCanEditAgentSettings: boolean
  sessionId?: string | null
  onSaved?: () => void
}

function renderSectionBody({
  section,
  space,
  canEditAgentSettings,
  roleCanEditAgentSettings,
  sessionId,
  onSaved,
}: SectionBodyProps): React.ReactNode {
  const spaceId = space.id
  const organizationId = space.organization_id

  switch (section) {
    case 'profile-identity': // [对象边界:S=Space属性] 身份/名片，多 Agent 后归 Space（PRD §5.3/§8.7）
      return <ProfileIdentityForm spaceId={spaceId} canManage={canEditAgentSettings} onSaved={onSaved} />
    case 'profile-rules':
      return <ProfileRulesForm spaceId={spaceId} canManage={canEditAgentSettings} />
    case 'working-dir':
    case 'device':
      // 设备与工作目录同屏；device section 由外层 remap 到 working-dir，这里兜底兼容。
      // 设备首次绑定后端为 editor 校验，故放开到 editor+，与后端对齐。
      return (
        <ProfileWorkingDirForm
          spaceId={spaceId}
          canManage={canEditAgentSettings}
          roleCanEdit={roleCanEditAgentSettings}
        />
      )
    case 'security':
      return <AgentSecurityPanel spaceId={spaceId} canManage={canEditAgentSettings} sessionId={sessionId} />
    case 'execution-limits':
      return <ExecutionLimitsPanel spaceId={spaceId} canManage={canEditAgentSettings} />
    case 'memory':
      return <MemoryPanel space={space} canManage={canEditAgentSettings} />
    case 'subagents':
      // 与规则/授权等同属「Agent 工作方式」，editor+ 可配置；勿用 owner-only canManage。
      return <SubAgentPanel spaceId={spaceId} canManage={canEditAgentSettings} />
    // 「集成能力」入口已屏蔽：Personal Plugin + Extension 混排体验未定型，暂不在 Agent 设置暴露
    case 'extensions':
      return null
    case 'archived': // [对象边界:S=Space属性] 归档对话（Space 生命周期），多 Agent 后归 Space（PRD §5.3/§8.7）
      // 取消归档 / 删除：会话归属用户本人可操作，勿用组织 owner-only canManage（会静默 disabled）
      return (
        <ArchivedChatSessionsSection
          spaceId={spaceId}
          organizationId={organizationId}
          className="flex-1 min-h-0"
        />
      )
    // 'trash' 已迁至「团队设置 → 资源回收站」（/#2253）
    default:
      return null
  }
}
