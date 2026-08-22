/**
 * AgentProfilePane — Agent 档案主页（简历 / 名片式排版）
 *
 * 取代原 SpaceSettingsPane 中 isWorkspace 时的"左导航 + 右内容区"布局。
 *
 * 设计语言：
 *   - 杂志/简历排版：左对齐章节 + definition list（label / preview）+ divide-y 分隔
 *   - 不卡片化：无 rounded box、无 min-h、无 hover 块底色，只在行级加极轻底色
 *   - 呼吸感：章节之间留大空白，行内留 leading-relaxed
 *   - 自适应宽度：max-w-3xl xl:max-w-4xl 让宽屏多用空间，窄屏 label/preview 自然堆叠
 *
 * 入口逻辑：
 *   - 顶部 Hero：名字 + 简介
 *   - 底部「危险操作」：删除工作空间（；回收站/归档受 flag）
 *   - Agent 停用在「AI 分身 / 我的 Agent」详情危险区，不在本页
 *   - 模块定义列表：按「Space 设置 / Agent 在此的工作方式」两大方向分章节
 *
 * 侧边详情面板由 `AgentSettingsSheet` + `useAgentSettingsSheetStore` 渲染。
 */

import React, { useMemo } from 'react'
import {
  ScrollArea,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { canEditAgentSettings as canEditAgentSettingsFn } from '@/hooks/useCanEditAgentSettings'
import { SIDEBAR_SCROLLBAR_TYPE } from '@components/layout/sidebarUi'
import {
  effectiveCanEditAgentSettings,
  useSpaceSettingsEditGuard,
} from './hooks/useSpaceSettingsEditGuard'
import { RemoteSettingsReadonlyNotice } from './RemoteSettingsReadonlyNotice'
import {
  useAgentSettingsSheetStore,
  type AgentSettingsSection,
} from '@stores/useAgentSettingsSheetStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useEffectiveSessionApprovalMode } from '@/stores/chat/session/sessionApprovalMode'
import type { Space, Agent } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { ProfileModuleRow, SectionTitle } from './profile/ProfileModuleRow'
import {
  RulesPreview,
  WorkingDirPreview,
  SubAgentsPreview,
} from './profile/ProfileModulePreviews'
import { WorkspaceLifecycleMenu } from './WorkspaceLifecycleMenu'

// ---------------------------------------------------------------------------
// Primary modules — 用 hardcoded 渲染（每个模块自己控制 preview 节点）
// ---------------------------------------------------------------------------

interface PrimaryModulesProps {
  space: Space
  agent: Agent | null
  onOpen: (section: AgentSettingsSection) => void
}

/**
 * 模块按两大方向组织成"章节 + 定义列表"结构：
 * - Space 设置：工作目录、归档对话等 Space 级环境与数据
 * - Agent 在此的工作方式：规则、记忆、授权、集成、子 Agent 等执行配置
 *   （执行设备与工作目录合一，见「工作目录」行）
 */
const PrimaryModules: React.FC<PrimaryModulesProps> = ({
  space,
  agent,
  onOpen,
}) => {
  const { t } = useTranslation('space')

  const sectionCls = 'mt-12 first:mt-0'
  const listCls = 'divide-y divide-border/40'

  return (
    <div>
      {/* ── Space 设置 ── */}
      <section className={sectionCls}>
        <SectionTitle>
          {t('profilePane.groups.space', { defaultValue: '工作空间设置' })}
        </SectionTitle>
        <div className={listCls}>
          <ProfileModuleRow
            label={t('tabs.workingDir', { defaultValue: '工作目录' })}
            preview={<WorkingDirPreview agent={agent} space={space} />}
            onClick={() => onOpen('working-dir')}
          />
          <ProfileModuleRow
            label={t('tabs.archived', { defaultValue: '归档对话' })}
            onClick={() => onOpen('archived')}
          />
        </div>
      </section>

      {/* ── Agent 在此的工作方式 ── */}
      <section className={sectionCls}>
        <SectionTitle>
          {t('profilePane.groups.agentBehavior', { defaultValue: 'Agent 在此的工作方式' })}
        </SectionTitle>
        <div className={listCls}>
          <ProfileModuleRow
            label={t('profilePane.modules.rules', { defaultValue: '自定义规则' })}
            preview={<RulesPreview space={space} />}
            onClick={() => onOpen('profile-rules')}
          />
          {/* ：对话上下文（memory）已从工作空间设置移除，归属 Agent/个人记忆偏好 */}
          <StatusModuleRow
            section="security"
            label={t('tabs.agentSecurity', { defaultValue: '授权策略' })}
            spaceId={space.id}
            onClick={() => onOpen('security')}
          />
          <ProfileModuleRow
            label={t('tabs.executionLimits', { defaultValue: '执行限制' })}
            onClick={() => onOpen('execution-limits')}
          />
          {/* 「设备」入口已并入「工作目录」：目录与执行设备绑定，同屏展示与配置 */}
          {/* 「应用管理」入口已屏蔽：应用启用属于组织层的权限分发，Space 管理不再承载（应用配置走 组织设置 → 应用市场） */}
          {/* 「集成能力」入口已屏蔽：Personal Plugin + Extension 混排体验未定型，暂不在 Agent 设置暴露 */}
          <ProfileModuleRow
            label={t('tabs.subagents', { defaultValue: '子 Agent' })}
            preview={<SubAgentsPreview spaceId={space.id} />}
            onClick={() => onOpen('subagents')}
          />
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status module row — 带状态摘要的入口（如授权策略）
// ---------------------------------------------------------------------------

interface StatusModuleRowProps {
  section: AgentSettingsSection
  label: string
  spaceId: string
  onClick: () => void
}

const StatusModuleRow: React.FC<StatusModuleRowProps> = ({ section, label, spaceId, onClick }) => {
  const status = useModuleStatus(section, spaceId)
  return (
    <ProfileModuleRow
      label={label}
      status={status}
      onClick={onClick}
    />
  )
}

function useModuleStatus(
  section: AgentSettingsSection,
  spaceId: string,
): string | null {
  const { t } = useTranslation('space')
  const currentSessionId = useChatStore(s => s.currentSessionIdBySpaceId[spaceId] ?? null)
  const effectiveApprovalMode = useEffectiveSessionApprovalMode(currentSessionId)
  return useMemo(() => {
    switch (section) {
      case 'security':
        return t(`security.approvalGrant.${effectiveApprovalMode}.name`)
      default:
        return null
    }
  }, [section, effectiveApprovalMode, t])
}

// ---------------------------------------------------------------------------
// Sub: Header — 名字 + 描述
// 工作空间是执行现场而非社交身份，因此不提供头像。
// ---------------------------------------------------------------------------

interface ProfileHeaderProps {
  space: Space
  canEditAgentSettings: boolean
  onOpenIdentity: () => void
}

const ProfileHeader: React.FC<ProfileHeaderProps> = ({
  space,
  canEditAgentSettings,
  onOpenIdentity,
}) => {
  const { t } = useTranslation('space')

  return (
    <header className="pt-4 pb-12 text-center">
      {/* 名字 + 描述：垂直堆叠，各占独立一行 */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={onOpenIdentity}
          disabled={!canEditAgentSettings}
          className={cn(
            'rounded-md px-2 -mx-2',
            canEditAgentSettings && 'hover:bg-muted/20 cursor-pointer',
            !canEditAgentSettings && 'cursor-default',
          )}
        >
          <h1 className="text-heading font-semibold text-foreground leading-tight tracking-tight">
            {space.name}
          </h1>
        </button>

        {space.description ? (
          <button
            type="button"
            onClick={onOpenIdentity}
            disabled={!canEditAgentSettings}
            className={cn(
              'mt-3 max-w-prose rounded-md px-2 -mx-2',
              canEditAgentSettings && 'hover:bg-muted/20 cursor-pointer',
            )}
          >
            <p className="text-body text-muted-foreground leading-relaxed line-clamp-3">
              {space.description}
            </p>
          </button>
        ) : canEditAgentSettings ? (
          <button
            type="button"
            onClick={onOpenIdentity}
            className="mt-3 rounded-md px-2 -mx-2 text-body text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/20 transition-colors"
          >
            {t('profilePane.header.addDescription', { defaultValue: '加一句简介' })}
          </button>
        ) : null}
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Main pane
// ---------------------------------------------------------------------------

interface AgentProfilePaneProps {
  spaceId: string
}

export const AgentProfilePane: React.FC<AgentProfilePaneProps> = ({ spaceId }) => {
  const space = useSpaceStore((state) => state.spaces.find((p) => p.id === spaceId) ?? null)
  const agent = useSpaceStore((state) => state.selectedAgent)

  const currentUserRole = useOrganizationStore((state) => state.currentUserRole)
  const selectedOrganization = useOrganizationStore((state) => state.selectedOrganization)
  const user = useAuthStore((state) => state.user)
  const isOwner = !!(user && selectedOrganization && user.id === selectedOrganization.owner_id)
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' : null)
  const settingsEditGuard = useSpaceSettingsEditGuard(space?.id)
  const canEditAgentSettings = effectiveCanEditAgentSettings(
    canEditAgentSettingsFn(effectiveRole),
    settingsEditGuard,
  )

  const open = useAgentSettingsSheetStore((s) => s.open)
  const currentSessionIdForSpace = useChatStore(s => s.currentSessionIdBySpaceId[spaceId] ?? null)

  const openSection = (section: AgentSettingsSection) => {
    if (!space) return
    open(section, space.id, { sessionId: currentSessionIdForSpace })
  }

  if (!space) return null

  return (
    <div className="relative flex-1 h-full overflow-hidden">
      <ScrollArea
        className="relative z-sticky flex-1 h-full"
        scrollBar="vertical"
        type={SIDEBAR_SCROLLBAR_TYPE}
      >
        <div className="mx-auto w-full max-w-3xl xl:max-w-4xl px-10 pt-4 pb-24">
          {/* [对象边界:S=Space属性] 身份/名片（profile-identity）是 Space 对象属性（PRD §3.3/§5.3/§8.7）：一对一下当 Agent 名片用，多 Agent 后归 Space */}
          <ProfileHeader
            space={space}
            canEditAgentSettings={canEditAgentSettings}
            onOpenIdentity={() => openSection('profile-identity')}
          />

          {/* hero 与正文之间的细分隔线，划出"名片 → 简历"的层次 */}
          <div className="border-t border-border/40" />

          <div className="pt-8">
            {settingsEditGuard.isRemoteViewer ? (
              <RemoteSettingsReadonlyNotice
                controlDeviceName={settingsEditGuard.controlDeviceName}
                className="mb-6"
              />
            ) : null}
            <PrimaryModules
              space={space}
              agent={agent}
              onOpen={openSection}
            />
            {/* Workspace 生命周期：页底危险区（Agent 停用不在此页） */}
            <WorkspaceLifecycleMenu space={space} />
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
