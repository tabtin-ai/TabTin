import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CheckSquare2,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderKanban,
  Hash,
  Info,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  Upload,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { TeamSpaceMembersSection } from '@components/space-settings/TeamSpaceMembersSection'
import { useTeamSpacePresence } from '@/hooks/useTeamSpacePresence'
import { useIMStore } from '@stores/useIMStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useScopedUnifiedResources, useUnifiedResources } from '@stores/useUnifiedResources'
import { useUIStore } from '@stores/useUIStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import {
  SpaceApiService,
  type Agent,
  type Space,
  type SpaceContextItem,
  type OrganizationMember,
} from '@tabtin/app-shell'
import { useCloudDocumentPreviewStore } from '@/components/chat/preview/useCloudDocumentPreviewStore'
import { MarkdownRenderer } from '@/components/chat/markdown/MarkdownRenderer'
import { useContextInjectionStore } from '@/stores/useContextInjectionStore'
import {
  listConversations,
  type Conversation,
} from '@/services/tabchatApi'
import { directUpload } from '@/services/oss-direct-uploader'
import { MemberApiService } from '@/services/memberApi'
import { SpaceAccessApiService } from '@/services/spaceAccessApi'
import { ProjectApiService } from '@/services/projectApi'
import { openProjectTaskChatSession } from '@/services/openProjectTaskChatSession'
import {
  createProjectWithCompanionWorkspace,
  provisionProjectCompanionWorkspace,
} from '@/services/provisionProjectWorkspace'
import type { ProjectCompanionWorkspace } from '@/types/project'
import { getProjectExecutionSpaceId } from '@/utils/projectExecutionTarget'
import { SpaceActivityApiService, type SpaceActivityEvent } from '@/services/spaceActivityApi'
import { createLogger } from '@/utils/logger'
import { formatRelativeTime } from '@utils/formatRelativeTime'
import {
  CANVAS_TEXT_EYEBROW,
  CANVAS_TEXT_META,
  CANVAS_TEXT_SECONDARY,
} from './canvasUi'
import {
  SIDEBAR_CHROME_ACTION,
  SIDEBAR_CHROME_ICON_SIZE,
  SIDEBAR_CHROME_ICON_STROKE,
  SIDEBAR_COUNT,
  SIDEBAR_EMPTY_STATE,
  SIDEBAR_ICON,
  SIDEBAR_ICON_ACTIVE,
  SIDEBAR_ICON_BUTTON,
  SIDEBAR_ICON_INACTIVE,
  SIDEBAR_ICON_SM,
  SIDEBAR_LIST_ICON,
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_PANEL_PRIMARY_TOP_SHELL,
  SIDEBAR_ROW_LIST,
  SIDEBAR_SECTION_HEADER_PANEL_TOP,
  SIDEBAR_SECTION_LABEL,
} from './sidebarUi'
import { SidebarMenuItem } from './SidebarMenuItem'
import { useProjectWorkspaceSelectionStore } from './projectWorkspaceSelectionStore'
import {
  ProjectOverviewPane,
  ProjectWorkspaceNavigation,
  type ProjectTab,
} from './project/ProjectWorkspaceNavigation'
import { ProjectTasksPane } from './project/ProjectTasksPane'
import {
  enterTeamSpaceProject,
  exitTeamSpaceProjectView,
  markTeamSpaceProjectNavigation,
  returnToCollaborationList,
} from './project/teamSpaceProjectNavigation'
import { useAppPageStore } from '@/stores/useAppPageStore'
import { ContextPageHeader } from '@components/context-space/ContextPageHeader'
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage'
import { PendingProjectInvitations } from './project/PendingProjectInvitations'
import {
  CONTEXT_PAGE_HEADER_GAP,
  CONTEXT_PAGE_SHELL_FILL,
} from '@components/context-space/constants'

export { useProjectWorkspaceSelectionStore } from './projectWorkspaceSelectionStore'

const projectLog = createLogger('projectWorkspace')

const TEAM_SPACE_CHANNEL_ORDER: Record<string, number> = {
  '#general': 0,
  '#agent-updates': 1,
}

function sortTeamSpaceChannels(channels: Conversation[]): Conversation[] {
  return [...channels].sort((a, b) => {
    const aName = a.name ?? ''
    const bName = b.name ?? ''
    const ao = TEAM_SPACE_CHANNEL_ORDER[aName] ?? 100
    const bo = TEAM_SPACE_CHANNEL_ORDER[bName] ?? 100
    if (ao !== bo) return ao - bo
    return aName.localeCompare(bName)
  })
}

function filterTeamSpaceChannels(
  items: Conversation[],
  project: Pick<Space, 'id' | 'organization_id'>,
): Conversation[] {
  if (!project.organization_id) return []
  return sortTeamSpaceChannels(
    items.filter(conversation =>
      conversation.organization_id === project.organization_id
      && conversation.space_id === project.id
      && conversation.is_team_space_channel
      && !conversation.is_archived,
    ),
  )
}

function describeTeamSpaceChannel(channelName: string): string {
  if (channelName === '#general') return '围绕这个Project 的日常讨论、决策和上下文沉淀。'
  if (channelName === '#agent-updates') return 'Agent 任务完成、失败和产物入口会汇总到这里。'
  return '项目内的专题讨论频道，成员边界继承 Project。'
}

const ASSET_ITEM_TYPE_LABEL: Record<string, string> = {
  tabfiles: '文件',
  team_asset: '产物',
  cloud_file: '文件',
  tabdoc: '文档',
}

const ASSET_SOURCE_LABEL: Record<string, string> = {
  member_upload: '成员上传',
  ai_deliverable: 'AI 产物',
}

const EXCLUDED_TEAM_SPACE_ASSET_KINDS = new Set(['ai_final_answer'])
const INCLUDED_TEAM_SPACE_ASSET_ITEM_TYPES = new Set(['tabfiles', 'file', 'cloud_file'])

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
  agent: 'Agent',
  bot: 'Agent',
  human: 'Member',
  system: 'System',
}

const IDENTITY_TYPE_LABEL: Record<string, string> = {
  member: '成员',
  agent: 'Agent',
}

type PeopleItem = {
  id: string
  name: string
  identityType: 'member' | 'agent'
  role: string
  initial: string
}

const PROJECT_SIDEBAR_ICON_INACTIVE_CLASS = 'grayscale opacity-80'

const projectSidebarIconClass = (active: boolean) => cn(
  'shrink-0',
  active ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
  !active && PROJECT_SIDEBAR_ICON_INACTIVE_CLASS,
)

// Project 进入 / 退出的 store 编排移至 ./project/teamSpaceProjectNavigation
// （窄栏导航中枢需要饿加载，不能连带本面板组件进主 bundle）。

export const ProjectSidebarContent: React.FC<{ className?: string }> = ({ className }) => {
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const selectedOrganizationId = selectedOrganization?.id ?? null
  const spaces = useSpaceStore(state => state.spaces)
  const selectedProjectId = useProjectWorkspaceSelectionStore(state => state.selectedProjectId)
  const activePage = useAppPageStore(state => state.activePage)
  const activeProjectId = useAppPageStore(state => state.activeProjectId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [settingsSpaceId, setSettingsSpaceId] = useState<string | null>(null)
  const teamSpaces = useMemo(
    () => spaces.filter(space => space.type === 'team_space' && !space.is_archived && space.organization_id === selectedOrganizationId),
    [selectedOrganizationId, spaces],
  )
  const settingsSpace = useMemo(
    () => teamSpaces.find(space => space.id === settingsSpaceId) ?? null,
    [settingsSpaceId, teamSpaces],
  )
  const handleSelectTeamSpace = useCallback((projectId: string) => {
    enterTeamSpaceProject(projectId)
  }, [])

  return (
    <div className={cn('scrollbar-hover h-full w-full overflow-y-auto', className)}>
      <div className={SIDEBAR_PANEL_PRIMARY_TOP_SHELL}>
        <div className={cn(SIDEBAR_SECTION_HEADER_PANEL_TOP, 'flex items-center gap-1')}>
          <span className={SIDEBAR_SECTION_LABEL}>Project</span>
          <span className={SIDEBAR_COUNT}>{teamSpaces.length}</span>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className={cn(SIDEBAR_CHROME_ACTION, 'ml-auto mr-1.5 shrink-0')}
            aria-label="新建Project"
            title="新建Project"
          >
            <Plus size={SIDEBAR_CHROME_ICON_SIZE} strokeWidth={SIDEBAR_CHROME_ICON_STROKE} />
          </button>
        </div>
        <PendingProjectInvitations
          organizationId={selectedOrganizationId}
          organizationName={selectedOrganization?.name ?? '当前组织'}
          onAccepted={handleSelectTeamSpace}
        />
        <div className={cn('shrink-0', SIDEBAR_ROW_LIST)}>
          {teamSpaces.map(project => {
            const active = activePage === 'project' && activeProjectId === project.id
            return (
              <div key={project.id} className="flex min-w-0 items-center gap-1">
                <SidebarMenuItem
                  as="button"
                  active={active}
                  fullWidth
                  onClick={() => handleSelectTeamSpace(project.id)}
                  leading={
                    <span className={cn(projectSidebarIconClass(active), SIDEBAR_LIST_ICON_SLOT)}>
                      <FolderKanban
                        className={SIDEBAR_LIST_ICON}
                        size={SIDEBAR_LIST_ICON_SIZE}
                        strokeWidth={SIDEBAR_MENU_ICON_STROKE}
                      />
                    </span>
                  }
                  label={project.name}
                />
                {active ? (
                  <button
                    type="button"
                    aria-label={`退出 ${project.name}`}
                    title="退出当前Project"
                    onClick={() => exitTeamSpaceProjectView(getProjectExecutionSpaceId(project, spaces))}
                    className={cn(SIDEBAR_ICON_BUTTON, 'shrink-0')}
                  >
                    <LogOut className={SIDEBAR_ICON_SM} />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`管理 ${project.name}`}
                  title="Project 设置"
                  onClick={() => setSettingsSpaceId(project.id)}
                  className={cn(SIDEBAR_ICON_BUTTON, 'shrink-0')}
                >
                  <Settings className={SIDEBAR_ICON_SM} />
                </button>
              </div>
            )
          })}
          {teamSpaces.length === 0 ? (
            <div className={cn(SIDEBAR_EMPTY_STATE, 'text-muted-foreground/80')}>
              还没有Project。新建后可把团队对话和共享资产放在这里。
            </div>
          ) : null}
        </div>
      </div>
      <CreateTeamSpaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <TeamSpaceSettingsDialog
        open={settingsSpaceId !== null}
        onOpenChange={(open) => { if (!open) setSettingsSpaceId(null) }}
        space={settingsSpace}
      />
    </div>
  )
}

export type ProjectMainContentSurface = 'gallery' | 'detail'

export const ProjectMainContent: React.FC<{
  /** gallery：协作入口展示全部 Project 卡片；detail：进入单个 Project。 */
  surface?: ProjectMainContentSurface
}> = ({ surface = 'detail' }) => {
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const spaces = useSpaceStore(state => state.spaces)
  const selectedProjectId = useProjectWorkspaceSelectionStore(state => state.selectedProjectId)
  const pendingTaskFocus = useProjectWorkspaceSelectionStore(state => state.pendingTaskFocus)
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const currentConversationId = useIMStore(state => state.currentConversationId)
  const setCurrentConversation = useIMStore(state => state.setCurrentConversation)
  const teamSpaces = useMemo(
    () => spaces.filter(space => space.type === 'team_space' && !space.is_archived && space.organization_id === selectedOrganization?.id),
    [selectedOrganization?.id, spaces],
  )
  // 协作入口绝不静默落到第一个 Project；详情页也只认显式选中。
  const project = surface === 'detail' && selectedProjectId
    ? teamSpaces.find(item => item.id === selectedProjectId) ?? null
    : null
  // Project presence：打开项目页即订阅 space:{spaceId}，让本人被同伴看见，
  // 同时拿到「谁在线」用于头部摘要（阶段4 在场感）
  const { onlineUserIds } = useTeamSpacePresence(project?.id ?? null)
  const organizationName = selectedOrganization?.name ?? '当前组织'
  const handleSelectTab = useCallback((tab: ProjectTab) => {
    if (tab !== 'discussion' && currentConversationId) {
      setCurrentConversation(null)
    }
    setActiveTab(tab)
  }, [currentConversationId, setCurrentConversation])
  const handleOpenProject = useCallback((projectId: string) => {
    enterTeamSpaceProject(projectId)
  }, [])

  useEffect(() => {
    setActiveTab('overview')
  }, [project?.id])

  useEffect(() => {
    if (!project || !pendingTaskFocus) return
    if (pendingTaskFocus.projectId !== project.id) return
    handleSelectTab('tasks')
  }, [handleSelectTab, pendingTaskFocus, project])

  if (!project) {
    if (teamSpaces.length > 0) {
      return (
        <CollaborationProjectsGallery
          projects={teamSpaces}
          organizationName={organizationName}
          organizationId={selectedOrganization?.id ?? null}
          onOpenProject={handleOpenProject}
          onAccepted={handleOpenProject}
          createDialogOpen={createDialogOpen}
          onCreateDialogOpenChange={setCreateDialogOpen}
        />
      )
    }

    return (
      <div className="h-full overflow-y-auto select-none scrollbar-hover">
        <div className={cn(CONTEXT_PAGE_SHELL_FILL, 'items-center justify-center text-center')}>
          <div className="flex w-full max-w-3xl flex-col items-center gap-3">
          <FolderKanban className="h-10 w-10 text-muted-foreground/60" />
          <h1 className="text-heading font-semibold text-foreground">还没有Project</h1>
          <p className="max-w-md text-body leading-relaxed text-muted-foreground">
            Project 是团队协作与项目管理层；任务由成员接住，再交给自己可控的 Agent 在私有 Project 工作空间中执行。
          </p>
          <Button
            type="button"
            variant="soft"
            className="mt-1"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            新建 Project
          </Button>
          {selectedOrganization?.id ? (
            <div className="mt-2 w-full max-w-md text-left">
              <PendingProjectInvitations
                organizationId={selectedOrganization.id}
                organizationName={organizationName}
                onAccepted={handleOpenProject}
              />
            </div>
          ) : null}
          </div>
        </div>
        <CreateTeamSpaceDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto select-none scrollbar-hover">
      <div className={CONTEXT_PAGE_SHELL_FILL}>
        <ProjectHeader
          project={project}
          organizationName={organizationName}
          onlineCount={onlineUserIds.length}
          onBackToCollaboration={returnToCollaborationList}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className={cn('min-w-0', CONTEXT_PAGE_HEADER_GAP)}>
          <ProjectWorkspaceNavigation activeTab={activeTab} onChange={handleSelectTab} />
          <main
            id="project-workspace-panel"
            role="tabpanel"
            aria-labelledby={`project-tab-${activeTab}`}
            className="min-w-0 pt-6"
          >
            <ProjectTabContent
              activeTab={activeTab}
              project={project}
              onSelectTab={handleSelectTab}
            />
          </main>
        </div>
      </div>
      <TeamSpaceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        space={project}
      />
    </div>
  )
}

const CollaborationProjectsGallery: React.FC<{
  projects: Space[]
  organizationName: string
  organizationId: string | null
  onOpenProject: (projectId: string) => void
  onAccepted: (projectId: string) => void
  createDialogOpen: boolean
  onCreateDialogOpenChange: (open: boolean) => void
}> = ({
  projects,
  organizationName,
  organizationId,
  onOpenProject,
  onAccepted,
  createDialogOpen,
  onCreateDialogOpenChange,
}) => {
  const { t } = useTranslation('sidebar')
  return (
  <>
    <StandaloneModulePage
      icon={<FolderKanban className="h-7 w-7" />}
      title={t('primaryNav.collaboration', { defaultValue: '协作' })}
      titleAs="h1"
      description={t('appHome.collaborationSubtitle', {
        defaultValue: '选择一个 Project 进入团队协作；任务、资产和讨论都按 Project 分开。',
      })}
      actions={(
        <Button
          type="button"
          variant="soft"
          onClick={() => onCreateDialogOpenChange(true)}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          新建 Project
        </Button>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto scrollbar-hover">
        {organizationId ? (
          <PendingProjectInvitations
            organizationId={organizationId}
            organizationName={organizationName}
            onAccepted={onAccepted}
          />
        ) : null}

        <div
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          role="list"
          aria-label="全部 Project"
        >
          {projects.map(project => (
            <div key={project.id} role="listitem" className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenProject(project.id)}
                className="grid min-h-36 w-full content-between gap-4 rounded-[12px] bg-foreground/[0.03] p-5 text-left transition-colors hover:bg-foreground/[0.06] dark:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08]"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-foreground/[0.05] text-muted-foreground">
                    <FolderKanban className="h-4 w-4" aria-hidden />
                  </span>
                  {typeof project.member_count === 'number' ? (
                    <span className={CANVAS_TEXT_META}>
                      {project.member_count} 位成员
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-subtitle font-medium text-foreground">
                    {project.name}
                  </span>
                  <span className={cn('mt-1 line-clamp-2', CANVAS_TEXT_SECONDARY)}>
                    {project.description || '团队成员在这里围绕一个目标持续协作。'}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </StandaloneModulePage>
    <CreateTeamSpaceDialog open={createDialogOpen} onOpenChange={onCreateDialogOpenChange} />
  </>
  )
}

const ProjectHeader: React.FC<{
  project: Space
  organizationName: string
  onlineCount: number
  onBackToCollaboration: () => void
  onOpenSettings: () => void
}> = ({ project, organizationName, onlineCount, onBackToCollaboration, onOpenSettings }) => (
  <ContextPageHeader
    title={project.name}
    titleAs="h1"
    icon={<FolderKanban className="h-7 w-7" />}
    description={project.description || '团队成员在这里围绕一个目标持续对话，沉淀可共享的资产。'}
    actions={(
      <Button type="button" variant="secondary" size="sm" className="shrink-0 gap-2" onClick={onOpenSettings}>
        <Settings className="h-3.5 w-3.5" />
        管理
      </Button>
    )}
    footer={(
      <div className="space-y-3">
        <nav
          aria-label="面包屑"
          className={cn('flex min-w-0 flex-wrap items-center gap-1.5 font-medium', CANVAS_TEXT_META)}
        >
          <FolderKanban className={cn('h-[1em] w-[1em] shrink-0 text-accent-text', CANVAS_TEXT_META)} aria-hidden />
          <span className="truncate">{organizationName}</span>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden />
          <button
            type="button"
            onClick={onBackToCollaboration}
            className="truncate text-accent-text transition-colors hover:text-accent-text/80"
          >
            协作
          </button>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden />
          <span className="truncate text-muted-foreground/80" aria-current="page">
            {project.name}
          </span>
        </nav>
        <div className={cn('flex flex-wrap items-center gap-2', CANVAS_TEXT_META)}>
          <span>{project.member_count ?? 1} 位成员</span>
          {onlineCount > 0 && (
            <>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                {onlineCount} 人在线
              </span>
            </>
          )}
        </div>
      </div>
    )}
  />
)

const ProjectTabContent: React.FC<{
  activeTab: ProjectTab
  project: Space
  onSelectTab: (tab: ProjectTab) => void
}> = ({ activeTab, project, onSelectTab }) => {
  if (activeTab === 'overview') {
    return (
      <ProjectOverviewPane
        projectId={project.id}
        onSelectTab={onSelectTab}
      />
    )
  }
  if (activeTab === 'tasks') return <ProjectTasksPane project={project} />
  if (activeTab === 'discussion') return <DiscussionPane project={project} />
  if (activeTab === 'assets') return <AssetsPane project={project} />
  if (activeTab === 'activity') return <ActivityPane project={project} />
  if (activeTab === 'members') return <MembersPane project={project} />
  return null
}

const DiscussionPane: React.FC<{ project: Space }> = ({ project }) => {
  const setCurrentConversation = useIMStore(state => state.setCurrentConversation)
  const onNewConversation = useIMStore(state => state.onNewConversation)
  const currentConversationId = useIMStore(state => state.currentConversationId)
  const unreadCounts = useIMStore(state => state.unreadCounts)
  // 勿在 useIMStore selector 内 .filter()——React 19 useSyncExternalStore 要求
  // getSnapshot 在 store 未变时返回稳定引用，否则 Maximum update depth（ 白屏）。
  const imConversations = useIMStore(state => state.conversations)
  const liveChannelConversations = useMemo(
    () => filterTeamSpaceChannels(imConversations, project),
    [imConversations, project],
  )
  const setChatSidePanelCollapsed = useUIStore(state => state.setChatSidePanelCollapsed)
  const [channels, setChannels] = useState<Conversation[]>([])
  const [isLoadingChannels, setIsLoadingChannels] = useState(false)
  const [channelError, setChannelError] = useState<string | null>(null)
  const prevUnreadSignatureRef = useRef<string | null>(null)

  const channelUnreadSignature = useMemo(
    () => channels.map(channel => `${channel.id}:${unreadCounts[channel.id] ?? 0}`).join('|'),
    [channels, unreadCounts],
  )

  const displayChannels = useMemo(() => {
    if (channels.length === 0) return channels
    const liveById = new Map(liveChannelConversations.map(conversation => [conversation.id, conversation]))
    return sortTeamSpaceChannels(
      channels.map((channel) => {
        const live = liveById.get(channel.id)
        const unreadCount = unreadCounts[channel.id] ?? live?.unread_count ?? channel.unread_count ?? 0
        if (!live) {
          return { ...channel, unread_count: unreadCount }
        }
        const liveAt = live.last_message_at ? Date.parse(live.last_message_at) : 0
        const channelAt = channel.last_message_at ? Date.parse(channel.last_message_at) : 0
        const preferLive = liveAt >= channelAt
        return {
          ...channel,
          last_message_at: preferLive
            ? (live.last_message_at ?? channel.last_message_at)
            : channel.last_message_at,
          last_message_preview: preferLive
            ? (live.last_message_preview || channel.last_message_preview)
            : (channel.last_message_preview || live.last_message_preview),
          unread_count: unreadCount,
        }
      }),
    )
  }, [channels, liveChannelConversations, unreadCounts])

  const refreshChannels = useCallback(async () => {
    if (!project.organization_id) return
    setIsLoadingChannels(true)
    setChannelError(null)
    try {
      const items = await listConversations(project.organization_id)
      setChannels(filterTeamSpaceChannels(items, project))
    } catch (err) {
      projectLog.error('discussion channels load failed', { projectId: project.id, err })
      setChannels([])
      setChannelError('讨论频道加载失败，请稍后重试。')
    } finally {
      setIsLoadingChannels(false)
    }
  }, [project])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!project.organization_id) return
      setIsLoadingChannels(true)
      setChannelError(null)
      try {
        const items = await listConversations(project.organization_id)
        if (cancelled) return
        setChannels(filterTeamSpaceChannels(items, project))
        void useIMStore.getState().loadConversations(project.organization_id)
      } catch (err) {
        if (cancelled) return
        projectLog.error('discussion channels refresh failed', { projectId: project.id, err })
        setChannels([])
        setChannelError('讨论频道加载失败，请稍后重试。')
      } finally {
        if (!cancelled) setIsLoadingChannels(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [project])

  useEffect(() => {
    if (channels.length === 0) return
    if (prevUnreadSignatureRef.current === null) {
      prevUnreadSignatureRef.current = channelUnreadSignature
      return
    }
    if (prevUnreadSignatureRef.current === channelUnreadSignature) return
    prevUnreadSignatureRef.current = channelUnreadSignature
    void refreshChannels()
  }, [channelUnreadSignature, channels.length, refreshChannels])

  const openChannel = useCallback((channel: Conversation) => {
    onNewConversation(channel)
    setCurrentConversation(channel.id)
    useAppPageStore.getState().openProjectPage(project.id)
    setChatSidePanelCollapsed(false)
  }, [onNewConversation, project.id, setChatSidePanelCollapsed, setCurrentConversation])

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-[12px] bg-foreground/[0.03] p-4 dark:bg-foreground/[0.04]">
        <div className="flex items-start gap-3">
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/80" />
          <div className="min-w-0">
            <p className="text-body font-medium text-foreground">历史讨论仅保留读取</p>
            <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
              Project 默认群、Project Ask 与 @Agent 回复线程均已后置；新 Project 本期不会创建频道。
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col rounded-[12px] bg-foreground/[0.03] dark:bg-foreground/[0.04]">
        {displayChannels.length > 0 ? displayChannels.map(channel => (
          <button
            key={channel.id}
            type="button"
            onClick={() => openChannel(channel)}
            className="group flex w-full items-start gap-3 border-b border-foreground/[0.04] p-4 text-left transition-colors last:border-b-0 hover:bg-foreground/[0.03] dark:border-foreground/[0.06] dark:hover:bg-foreground/[0.04]"
          >
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-foreground/[0.04] text-muted-foreground/80 group-hover:text-foreground dark:bg-foreground/[0.06]">
              <Hash className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-body font-medium text-foreground">{channel.name}</p>
                {channel.unread_count > 0 && channel.id !== currentConversationId ? (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-caption font-medium text-accent-foreground">
                    {channel.unread_count}
                  </span>
                ) : null}
              </div>
              <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
                {channel.last_message_preview || describeTeamSpaceChannel(channel.name)}
              </p>
            </div>
            <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground" />
          </button>
        )) : (
          <div className="p-6">
            <p className="text-body font-medium text-foreground">
              {isLoadingChannels ? '正在加载讨论频道...' : channelError ?? '还没有可用频道'}
            </p>
            <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
              新 Project 不创建讨论频道；已有历史频道仍可在这里读取。
            </p>
          </div>
        )}
      </div>

    </section>
  )
}

const AssetsPane: React.FC<{ project: Space }> = ({ project }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { resources, isLoading, error } = useScopedUnifiedResources(project.id, 'space')
  const loadResources = useUnifiedResources(state => state.load)
  const [isUploading, setIsUploading] = useState(false)
  const assets = useMemo(
    () => resources.filter(isTeamSpaceAsset),
    [resources],
  )
  const assetGroups = useMemo(() => groupProjectAssets(assets), [assets])

  useEffect(() => {
    void loadResources(project.id, true, 'space')
  }, [loadResources, project.id])

  const refreshAssets = useCallback(async () => {
    await loadResources(project.id, true, 'space')
  }, [loadResources, project.id])

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || isUploading) return
    if (!project.organization_id) {
      toast({ title: '缺少组织信息，无法上传' })
      return
    }

    setIsUploading(true)
    try {
      const uploaded = await directUpload(file, file.name, {
        module: 'tabfiles',
        contextType: 'team_space_asset',
        contextId: project.id,
        organizationId: project.organization_id,
        isPublic: true,
      })
      if (!uploaded.fileId) {
        throw new Error('文件上传后缺少 file_id')
      }
      await SpaceApiService.uploadSpaceFile(project.id, {
        file_record_id: uploaded.fileId,
        title: file.name,
      }, 'project')
      await refreshAssets()
      toast({ title: '资产已上传' })
    } catch (err) {
      projectLog.error('asset upload failed', { projectId: project.id, err })
      toast({
        title: '资产上传失败',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setIsUploading(false)
    }
  }, [isUploading, project.id, project.organization_id, refreshAssets])

  const handleOpenAsset = useCallback(async (asset: SpaceContextItem) => {
    try {
      await SpaceApiService.recordResourceAccess(asset.id)
      if (isTabdocTeamSpaceAsset(asset)) {
        if (!asset.space_id) {
          toast({ title: '无法打开文档', description: '该文档未绑定工作区宿主' })
          return
        }
        useCloudDocumentPreviewStore.getState().open({
          documentId: asset.resource_id,
          resourceSpaceId: asset.space_id,
          title: asset.title,
          organizationId: project.organization_id,
        })
        return
      }
      if (isFileTeamSpaceAsset(asset)) {
        const result = asset.space_id
          ? await SpaceApiService.getSpaceFileDownloadUrl(
              asset.space_id,
              asset.id,
              { hostKind: 'project' },
            )
          : await SpaceApiService.getOrganizationFileDownloadUrl(
              project.organization_id,
              asset.id,
            )
        const opened = await window.tabtin?.openExternal?.(result.url)
        if (!opened?.success) {
          window.open(result.url, '_blank', 'noopener,noreferrer')
        }
        return
      }
      const taskSessionId = getAssetSourceField(asset, 'chat_session_id')
      if (taskSessionId) {
        await openProjectTaskChatSession({
          projectId: project.id,
          organizationId: project.organization_id,
          sessionId: taskSessionId,
        })
        return
      }
      toast({ title: '这条资产来自团队对话，可在任务对话中查看' })
    } catch (err) {
      projectLog.error('asset open failed', { projectId: project.id, assetId: asset.id, err })
      toast({ title: '资产打开失败' })
    }
  }, [project.id, project.organization_id])

  const handleAddDeliverableToChat = useCallback((deliverable: ProjectDeliverable) => {
    const store = useContextInjectionStore.getState()
    if (!store.activeScopeId) {
      toast({
        title: '请先打开要继续使用的对话',
        description: '打开对话窗口后，可把这组交付资产直接加入输入框。',
      })
      return
    }
    const reusableAssets = deliverable.assets.flatMap((asset) => {
      const type = getAssetContextRefType(asset)
      return type ? [{ asset, type }] : []
    })
    for (const { asset, type } of reusableAssets) {
      store.addContextRefToScope(
        store.activeScopeId,
        type,
        asset.resource_id,
        asset.title || '未命名资产',
        {
          spaceId: asset.space_id ?? undefined,
          tabType: isTabdocTeamSpaceAsset(asset) ? 'tabdoc' : 'tabfiles',
          meta: deliverable.summary?.preview
            ? { preview: `${asset.title || '交付资产'}\n交付结论：${deliverable.summary.preview}` }
            : undefined,
        },
      )
    }
    toast({
      title: '已加入当前对话',
      description: `已添加 ${reusableAssets.length} 个交付资产，可让 Agent 基于它们继续工作。`,
    })
  }, [])

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className={CANVAS_TEXT_EYEBROW}>团队资料 / 产物</span>
          <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
            成员上传的文件、文档和 AI 明确声明的云端产物会出现在这里。
          </p>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button type="button" variant="soft" size="sm" className="gap-2" onClick={handleUploadClick} disabled={isUploading}>
            {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            上传资产
          </Button>
        </div>
      </div>

      {isLoading && assets.length === 0 ? (
        <div className="flex min-h-[160px] items-center justify-center rounded-[12px] bg-foreground/[0.03] p-6 text-body text-muted-foreground dark:bg-foreground/[0.04]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在加载团队资产...
        </div>
      ) : null}

      {error && assets.length === 0 ? (
        <div className="rounded-[12px] bg-foreground/[0.03] p-6 dark:bg-foreground/[0.04]">
          <p className="text-body font-medium text-foreground">团队资产加载失败</p>
              <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
            当前无法列出这个Project 的资产，请稍后重试。
          </p>
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void refreshAssets()}>
            重试
          </Button>
        </div>
      ) : null}

      {!isLoading && !error && assets.length === 0 ? (
        <EmptyState message="还没有团队资产。上传文件后，Project 成员都可以在这里看到。" />
      ) : null}

      {assets.length > 0 ? (
        <div className="space-y-3">
          {assetGroups.deliverables.map(deliverable => (
            <DeliverableCard
              key={deliverable.taskRunId}
              deliverable={deliverable}
              onOpen={handleOpenAsset}
              onAddToChat={handleAddDeliverableToChat}
            />
          ))}
          {assetGroups.standalone.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {assetGroups.standalone.map(item => (
                <AssetCard key={item.id} item={item} onOpen={handleOpenAsset} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

const ACTIVITY_PAGE_SIZE = 20
type ActivityFilter = 'all' | 'task' | 'agent' | 'asset' | 'discussion' | 'member' | 'project'

const ACTIVITY_FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'task', label: '任务' },
  { id: 'agent', label: 'Agent 执行' },
  { id: 'asset', label: '交付资产' },
  { id: 'discussion', label: '讨论' },
  { id: 'member', label: '成员' },
  { id: 'project', label: 'Project' },
]

const ACTIVITY_EVENT_PRESENTATION: Record<string, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  space_created: { label: '创建了这个Project', Icon: FolderKanban },
  member_joined: { label: '加入了Project', Icon: Plus },
  member_left: { label: '退出了Project', Icon: Info },
  member_role_changed: { label: '的角色被调整', Icon: Settings },
  asset_created: { label: '新增了资产', Icon: Upload },
  asset_archived: { label: '归档了资产', Icon: FileText },
  asset_restored: { label: '恢复了资产', Icon: FileText },
  agent_run_started: { label: '发起了 Agent 任务', Icon: Bot },
  agent_run_completed: { label: '的 Agent 任务已完成', Icon: Bot },
  agent_run_failed: { label: '的 Agent 任务失败了', Icon: Bot },
  settings_updated: { label: '更新了 Project 设置', Icon: Settings },
  channel_created: { label: '创建了讨论频道', Icon: Hash },
  channel_renamed: { label: '重命名了讨论频道', Icon: Hash },
  channel_archived: { label: '归档了讨论频道', Icon: Hash },
  task_created: { label: '创建了任务', Icon: CheckSquare2 },
  task_assigned: { label: '指派了任务', Icon: CheckSquare2 },
  task_accepted: { label: '接受了任务', Icon: CheckSquare2 },
  task_rejected: { label: '拒绝了任务', Icon: CheckSquare2 },
  task_execution_configured: { label: '确认了任务执行配置', Icon: Settings },
  task_review_requested: { label: '完成了一轮 Agent 执行', Icon: CheckSquare2 },
  task_completed: { label: '完成了任务', Icon: CheckSquare2 },
}

function describeActivityEvent(event: SpaceActivityEvent): string {
  const actor = event.actor_name || '有成员'
  switch (event.event_type) {
    case 'space_created':
      return `${actor} 创建了Project「${event.target_name}」`
    case 'member_joined':
      return `${actor} 邀请 ${event.target_name || '成员'} 加入了Project`
    case 'member_left':
      return `${actor} 将 ${event.target_name || '成员'} 移出了Project`
    case 'member_role_changed': {
      const newRole = typeof event.metadata?.new_role === 'string' ? event.metadata.new_role : ''
      const roleLabel = newRole ? ROLE_LABEL[newRole] ?? newRole : ''
      return `${actor} 将 ${event.target_name || '成员'} 的角色调整为 ${roleLabel || '新角色'}`
    }
    case 'asset_created':
      return `${actor} 新增了资产「${event.target_name || '未命名'}」`
    case 'asset_archived':
      return `${actor} 归档了资产「${event.target_name || '未命名'}」`
    case 'asset_restored':
      return `${actor} 恢复了资产「${event.target_name || '未命名'}」`
    case 'agent_run_started':
      return `${actor} 发起了 Agent 任务「${event.target_name || '未命名任务'}」`
    case 'agent_run_completed':
      return `${actor} 的 Agent 任务「${event.target_name || '未命名任务'}」已完成`
    case 'agent_run_failed':
      return `${actor} 的 Agent 任务「${event.target_name || '未命名任务'}」失败了`
    case 'task_created': {
      const responsibleName = typeof event.metadata?.responsible_user_name === 'string'
        ? event.metadata.responsible_user_name.trim()
        : ''
      const priority = typeof event.metadata?.priority === 'string' ? event.metadata.priority : ''
      const priorityLabel = priority === 'low'
        ? '低'
        : priority === 'medium'
          ? '中'
          : priority === 'high'
            ? '高'
            : priority === 'urgent'
              ? '紧急'
              : ''
      const parts = [
        `${actor} 创建了任务「${event.target_name || '未命名任务'}」`,
        responsibleName ? `指派给 ${responsibleName}` : '',
        priorityLabel ? `优先级 ${priorityLabel}` : '',
      ].filter(Boolean)
      return parts.join(' · ')
    }
    case 'task_assigned':
      return `${actor} 指派了任务「${event.target_name || '未命名任务'}」`
    case 'task_accepted':
      return `${actor} 接受了任务「${event.target_name || '未命名任务'}」`
    case 'task_rejected':
      return `${actor} 拒绝了任务「${event.target_name || '未命名任务'}」`
    case 'task_execution_configured':
      return `${actor} 确认了任务「${event.target_name || '未命名任务'}」的执行配置`
    case 'task_review_requested':
      return `${actor} 完成了任务「${event.target_name || '未命名任务'}」的一轮 Agent 执行`
    case 'task_completed':
      return `${actor} 完成了任务「${event.target_name || '未命名任务'}」`
    case 'settings_updated': {
      const metadata = event.metadata ?? {}
      if (typeof metadata.new_name === 'string' && metadata.new_name) {
        return `${actor} 将 Project 改名为「${metadata.new_name}」`
      }
      return `${actor} 更新了 Project 设置`
    }
    case 'channel_created':
      return `${actor} 创建了讨论频道「${event.target_name || '未命名'}」`
    case 'channel_renamed': {
      const oldName = typeof event.metadata?.old_name === 'string' ? event.metadata.old_name : ''
      const newName = typeof event.metadata?.new_name === 'string' ? event.metadata.new_name : event.target_name
      if (oldName && newName) {
        return `${actor} 将频道「${oldName}」重命名为「${newName}」`
      }
      return `${actor} 重命名了讨论频道「${event.target_name || '未命名'}」`
    }
    case 'channel_archived':
      return `${actor} 归档了讨论频道「${event.target_name || '未命名'}」`
    default:
      return `${actor} 有一条新动态`
  }
}

function getActivityFilter(eventType: string): Exclude<ActivityFilter, 'all'> {
  if (eventType.startsWith('task_')) return 'task'
  if (eventType.startsWith('agent_run_')) return 'agent'
  if (eventType.startsWith('asset_')) return 'asset'
  if (eventType.startsWith('channel_')) return 'discussion'
  if (eventType.startsWith('member_')) return 'member'
  return 'project'
}

const ActivityPane: React.FC<{ project: Space }> = ({ project }) => {
  const [events, setEvents] = useState<SpaceActivityEvent[]>([])
  const [activeFilter, setActiveFilter] = useState<ActivityFilter>('all')
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)

  const loadPage = useCallback(async (page: number) => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    if (page === 1) {
      setIsLoading(true)
      setError(null)
    } else {
      setIsLoadingMore(true)
    }
    try {
      const result = await SpaceActivityApiService.listActivities(project.id, {
        page,
        limit: ACTIVITY_PAGE_SIZE,
      })
      if (requestRef.current !== requestId) return
      setTotal(result.total)
      setEvents(prev => (page === 1 ? result.items : [...prev, ...result.items]))
    } catch (err) {
      if (requestRef.current !== requestId) return
      projectLog.error('activities load failed', { projectId: project.id, page, err })
      if (page === 1) {
        setEvents([])
        setError('动态加载失败，请稍后重试。')
      } else {
        toast({ title: '加载更多动态失败' })
      }
    } finally {
      if (requestRef.current === requestId) {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    }
  }, [project.id])

  useEffect(() => {
    void loadPage(1)
  }, [loadPage])

  const openTaskSession = useCallback(async (event: SpaceActivityEvent) => {
    const sessionId = typeof event.metadata?.session_id === 'string' ? event.metadata.session_id : ''
    if (!sessionId) return
    try {
      await openProjectTaskChatSession({
        projectId: project.id,
        organizationId: project.organization_id,
        sessionId,
      })
    } catch (err) {
      projectLog.error('activity task session open failed', { projectId: project.id, sessionId, err })
      toast({ title: '打开任务线程失败', variant: 'destructive' })
    }
  }, [project.id, project.organization_id])

  const hasMore = events.length < total
  const nextPage = Math.floor(events.length / ACTIVITY_PAGE_SIZE) + 1
  const filteredEvents = useMemo(
    () => activeFilter === 'all'
      ? events
      : events.filter(event => getActivityFilter(event.event_type) === activeFilter),
    [activeFilter, events],
  )

  return (
    <section className="flex flex-col gap-3">
      <div>
        <span className={CANVAS_TEXT_EYEBROW}>动态流</span>
        <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
          按任务、Agent 执行、交付资产、讨论和成员协作快速找到相关记录。
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="动态筛选">
        {ACTIVITY_FILTERS.map(filter => (
          <button
            key={filter.id}
            type="button"
            aria-pressed={activeFilter === filter.id}
            onClick={() => setActiveFilter(filter.id)}
            className={cn(
              'h-7 rounded-interactive px-2.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              activeFilter === filter.id
                ? 'bg-foreground text-background'
                : 'bg-foreground/[0.04] text-muted-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground',
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {isLoading && events.length === 0 ? (
        <div className="flex min-h-[160px] items-center justify-center rounded-[12px] bg-foreground/[0.03] p-6 text-body text-muted-foreground dark:bg-foreground/[0.04]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在加载动态...
        </div>
      ) : null}

      {error && events.length === 0 ? (
        <div className="rounded-[12px] bg-foreground/[0.03] p-6 dark:bg-foreground/[0.04]">
          <p className="text-body font-medium text-foreground">动态加载失败</p>
              <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
            当前无法列出这个Project 的动态，请稍后重试。
          </p>
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void loadPage(1)}>
            重试
          </Button>
        </div>
      ) : null}

      {!isLoading && !error && events.length === 0 ? (
        <EmptyState message="还没有动态。邀请成员、上传资产或运行 Agent 任务后会出现在这里。" />
      ) : null}

      {events.length > 0 ? (
        <div className="flex flex-col rounded-[12px] bg-foreground/[0.03] dark:bg-foreground/[0.04]">
          {filteredEvents.map(event => {
            const presentation = ACTIVITY_EVENT_PRESENTATION[event.event_type]
            const Icon = presentation?.Icon ?? Info
            const canOpenTask = (
              event.target_type === 'agent_run'
              && typeof event.metadata?.session_id === 'string'
              && event.metadata.session_id
            )
            const errorSummary = typeof event.metadata?.error === 'string' ? event.metadata.error : ''
            return (
              <div
                key={event.id}
                className="flex items-start gap-3 border-b border-foreground/[0.04] p-4 last:border-b-0 dark:border-foreground/[0.06]"
              >
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-foreground/[0.04] text-muted-foreground/80 dark:bg-foreground/[0.06]">
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-body leading-5 text-foreground">
                    {describeActivityEvent(event)}
                  </p>
                  <p className="mt-0.5 text-caption text-muted-foreground/60">
                    {formatRelativeTime(event.created_at)}
                  </p>
                  {errorSummary ? (
                    <p className={cn('mt-1 line-clamp-2 text-destructive/80', CANVAS_TEXT_SECONDARY)}>
                      {errorSummary}
                    </p>
                  ) : null}
                  {canOpenTask ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 px-2 text-caption"
                      onClick={() => void openTaskSession(event)}
                    >
                      前往对话
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
          {filteredEvents.length === 0 ? (
            <div className="p-6 text-center text-body text-muted-foreground">
              当前已加载的动态中没有这一类记录。
            </div>
          ) : null}
          {hasMore ? (
            <div className="flex justify-center p-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isLoadingMore}
                onClick={() => void loadPage(nextPage)}
              >
                {isLoadingMore ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                加载更多
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

const MembersPane: React.FC<{ project: Space }> = ({ project }) => {
  const [members, setMembers] = useState<OrganizationMember[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadPeopleRequestRef = useRef(0)

  const loadPeople = useCallback(async () => {
    const requestId = loadPeopleRequestRef.current + 1
    loadPeopleRequestRef.current = requestId
    if (!project.organization_id) {
      setMembers([])
      setAgents([])
      setError(null)
      setIsLoading(false)
      return
    }
    setMembers([])
    setAgents([])
    setIsLoading(true)
    setError(null)
    try {
      const [memberResult, agentResult] = await Promise.all([
        MemberApiService.getMembers(project.organization_id, { limit: 200 }),
        SpaceAccessApiService.listOrganizationAgents(project.organization_id, { pageSize: 200 }),
      ])
      if (loadPeopleRequestRef.current !== requestId) return
      setMembers(memberResult.members)
      setAgents(agentResult.agents)
    } catch (err) {
      if (loadPeopleRequestRef.current !== requestId) return
      projectLog.error('members and agents load failed', { projectId: project.id, err })
      setMembers([])
      setAgents([])
      setError('成员和 Agent 加载失败，请稍后重试。')
    } finally {
      if (loadPeopleRequestRef.current === requestId) {
        setIsLoading(false)
      }
    }
  }, [project.id, project.organization_id])

  useEffect(() => {
    void loadPeople()
  }, [loadPeople])

  const memberItems = useMemo(
    () => members.map(member => {
      const name = getOrganizationMemberName(member)
      return {
        id: member.id,
        name,
        identityType: 'member' as const,
        role: member.role,
        initial: getPeopleInitial(name),
      }
    }),
    [members],
  )

  // listOrganizationAgents 已按当前用户所有权过滤；此处只展示可执行的非 human Agent。
  const agentItems = useMemo(
    () => agents
      .filter(agent => agent.type !== 'human' && agent.is_active)
      .map(agent => ({
        id: agent.id,
        name: agent.display_name || agent.name,
        identityType: 'agent' as const,
        role: agent.type || 'agent',
        initial: getPeopleInitial(agent.display_name || agent.name),
      })),
    [agents],
  )

  return (
    <section className="flex flex-col gap-6">
      {/* Space 成员：这个 Project 的成员（Owner 可邀请；移除语义后置），
          与下方「组织全员」（Organization 维度，此处仅展示）是两个不同集合，勿混淆 */}
      <div className="flex flex-col gap-3">
        <span className={CANVAS_TEXT_EYEBROW}>Project 成员</span>
        <div className="rounded-[12px] bg-foreground/[0.03] p-4 dark:bg-foreground/[0.04]">
          <TeamSpaceMembersSection space={project} scrollable={false} showHeader={false} />
        </div>
      </div>

      <MyExecutionPositionPanel project={project} />

      <section className="flex flex-col gap-3">
        <div>
          <span className={CANVAS_TEXT_EYEBROW}>任务执行用的 Agent</span>
          <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
            Agent 不作为 Project 成员入席。你接住任务后，在任务详情里选择工作空间与 Agent 并确认。
          </p>
        </div>
      </section>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-foreground/[0.03] p-4 dark:bg-foreground/[0.04]">
          <p className="text-body text-muted-foreground">{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void loadPeople()} disabled={isLoading}>
            重试
          </Button>
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <PeoplePanel
          title="组织全员"
          items={memberItems}
          emptyMessage={isLoading ? '正在加载组织成员...' : '这个组织还没有可显示的成员。'}
        />
        <PeoplePanel
          title="我的 Agent（任务中选用）"
          items={agentItems}
          emptyMessage={isLoading ? '正在加载 Agent...' : '你还没有可用的活跃 Agent。'}
        />
      </div>
    </section>
  )
}

const MyExecutionPositionPanel: React.FC<{ project: Space }> = ({ project }) => {
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const [executionPosition, setExecutionPosition] = useState<ProjectCompanionWorkspace | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isProvisioning, setIsProvisioning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadExecutionPosition = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const currentProject = await ProjectApiService.getProject(project.id)
      setExecutionPosition(currentProject.my_workspace ?? null)
    } catch (loadError) {
      projectLog.warn('execution position load failed', { projectId: project.id, loadError })
      setExecutionPosition(null)
      setError('默认执行位置加载失败，请稍后重试。')
    } finally {
      setIsLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    void loadExecutionPosition()
  }, [loadExecutionPosition])

  const handleProvision = useCallback(async () => {
    if (!selectedOrganization?.id || isProvisioning) return
    setIsProvisioning(true)
    try {
      const result = await provisionProjectCompanionWorkspace({
        organizationId: selectedOrganization.id,
        organizationName: selectedOrganization.name ?? '',
        projectId: project.id,
        projectName: project.name,
        mode: 'ensure',
      })
      if (!result.ok) {
        toast({ title: '执行位置准备失败', description: result.error })
        return
      }
      toast({ title: '默认执行位置已就绪' })
      await loadExecutionPosition()
    } catch (provisionError) {
      toast({
        title: '执行位置准备失败',
        description: provisionError instanceof Error ? provisionError.message : '请稍后重试',
      })
    } finally {
      setIsProvisioning(false)
    }
  }, [isProvisioning, loadExecutionPosition, project.id, project.name, selectedOrganization])

  return (
    <section className="flex flex-col gap-3">
      <div>
        <span className={CANVAS_TEXT_EYEBROW}>我的默认执行位置</span>
        <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
          任务由你接住后，再选择自己可控的 Agent 执行；其他成员只能看到与任务相关的状态和记录。
        </p>
      </div>
      <div className="rounded-[12px] bg-foreground/[0.03] p-4 dark:bg-foreground/[0.04]">
        {isLoading ? (
          <div className="flex items-center gap-2 text-caption text-muted-foreground/80">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载执行位置…
          </div>
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-caption text-muted-foreground/80">{error}</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void loadExecutionPosition()}>
              重试
            </Button>
          </div>
        ) : executionPosition ? (
          <div>
            <p className="text-body font-medium text-foreground">{executionPosition.name}</p>
            <p className="mt-1 break-all text-caption text-muted-foreground/80">
              {executionPosition.working_dir || '尚未设置 Agent 工作目录'}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-body font-medium text-foreground">尚未准备默认执行位置</p>
              <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
                这只为你准备个人执行现场，不会创建项目专属 Agent，也不会共享本地目录。
              </p>
            </div>
            <Button
              type="button"
              variant="soft"
              size="sm"
              disabled={isProvisioning}
              onClick={() => void handleProvision()}
            >
              {isProvisioning ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              准备默认执行位置
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}

const PeoplePanel: React.FC<{
  title: string
  items: PeopleItem[]
  emptyMessage: string
}> = ({ title, items, emptyMessage }) => (
  <section className="flex flex-col gap-3">
    <span className={CANVAS_TEXT_EYEBROW}>{title}</span>
    <div className="space-y-1 rounded-[12px] bg-foreground/[0.03] p-3 dark:bg-foreground/[0.04]">
      {items.length === 0 ? (
        <div className={cn('px-1 py-2', CANVAS_TEXT_SECONDARY)}>
          {emptyMessage}
        </div>
      ) : (
        items.map(item => (
          <div key={item.id} className="flex items-center gap-3 rounded-interactive px-1 py-2">
            <span className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-full bg-foreground/[0.04] text-caption font-semibold text-muted-foreground/80">
              {item.initial}
            </span>
            <div className="min-w-0">
              <div className="truncate text-body font-medium text-foreground">{item.name}</div>
              <div className="truncate text-caption text-muted-foreground/80">
                {IDENTITY_TYPE_LABEL[item.identityType] ?? item.identityType}
                {' · '}
                {ROLE_LABEL[item.role] ?? item.role}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  </section>
)

function getOrganizationMemberName(member: OrganizationMember): string {
  return (
    member.user?.nickname?.trim()
    || member.user?.username?.trim()
    || member.user?.email?.trim()
    || member.user?.phone?.trim()
    || member.user_id
  )
}

function getPeopleInitial(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed[0].toUpperCase()
}

const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="rounded-[12px] bg-foreground/[0.03] p-6 text-body text-muted-foreground dark:bg-foreground/[0.04]">
    {message}
  </div>
)

function isTeamSpaceAsset(item: SpaceContextItem): boolean {
  const metadata = item.metadata ?? {}
  const assetKind = typeof metadata.asset_kind === 'string' ? metadata.asset_kind : ''
  const sourceKind = getAssetSourceKind(item)
  if (
    EXCLUDED_TEAM_SPACE_ASSET_KINDS.has(item.item_type) ||
    EXCLUDED_TEAM_SPACE_ASSET_KINDS.has(assetKind) ||
    EXCLUDED_TEAM_SPACE_ASSET_KINDS.has(sourceKind)
  ) {
    return false
  }
  return isFileTeamSpaceAsset(item)
    || isTabdocTeamSpaceAsset(item)
    || Boolean(assetKind)
    || sourceKind === 'member_upload'
    || sourceKind === 'ai_deliverable'
}

function isTabdocTeamSpaceAsset(item: SpaceContextItem): boolean {
  return item.item_type === 'tabdoc' && item.metadata?.asset_kind === 'tabdoc'
}

function isFileTeamSpaceAsset(item: SpaceContextItem): boolean {
  const assetKind = typeof item.metadata?.asset_kind === 'string' ? item.metadata.asset_kind : ''
  return INCLUDED_TEAM_SPACE_ASSET_ITEM_TYPES.has(item.item_type) || assetKind === 'cloud_file'
}

function getAssetTypeLabel(item: SpaceContextItem): string {
  const metadata = item.metadata ?? {}
  const assetKind = typeof metadata.asset_kind === 'string' ? metadata.asset_kind : ''
  return ASSET_ITEM_TYPE_LABEL[assetKind]
    ?? ASSET_ITEM_TYPE_LABEL[item.item_type]
    ?? item.item_type
}

function getAssetSourceLabel(item: SpaceContextItem): string {
  const kind = getAssetSourceKind(item)
  if (kind) {
    return ASSET_SOURCE_LABEL[kind] ?? kind
  }
  return isFileTeamSpaceAsset(item) ? '文件资产' : '团队资产'
}

function getAssetSourceKind(item: SpaceContextItem): string {
  const source = item.metadata?.asset_source
  if (source && typeof source === 'object' && 'kind' in source) {
    return String(source.kind)
  }
  return ''
}

function getAssetSourceField(item: SpaceContextItem, field: string): string {
  const source = item.metadata?.asset_source
  if (!source || typeof source !== 'object' || !(field in source)) return ''
  const value = source[field as keyof typeof source]
  return typeof value === 'string' ? value : ''
}

function formatAssetTime(value: string | null): string {
  if (!value) return '暂无更新时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无更新时间'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

interface ProjectDeliverable {
  taskRunId: string
  summary: SpaceContextItem | null
  assets: SpaceContextItem[]
}

function groupProjectAssets(items: SpaceContextItem[]): {
  deliverables: ProjectDeliverable[]
  standalone: SpaceContextItem[]
} {
  const byRun = new Map<string, ProjectDeliverable>()
  const standalone: SpaceContextItem[] = []

  const sortedItems = [...items].sort((a, b) => {
    const timeDelta = Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '')
    return Number.isNaN(timeDelta) || timeDelta === 0
      ? b.id.localeCompare(a.id)
      : timeDelta
  })
  for (const item of sortedItems) {
    const taskRunId = getAssetSourceField(item, 'task_run_id')
    if (!taskRunId) {
      standalone.push(item)
      continue
    }
    const deliverable = byRun.get(taskRunId) ?? {
      taskRunId,
      summary: null,
      assets: [],
    }
    const isSummary = item.item_type === 'team_asset'
      && (
        getAssetSourceKind(item) === 'ai_deliverable'
        || item.resource_id.startsWith('project_task_run:')
      )
    if (isSummary) {
      deliverable.summary ??= item
    } else {
      deliverable.assets.push(item)
    }
    byRun.set(taskRunId, deliverable)
  }

  return {
    deliverables: [...byRun.values()].sort((a, b) => {
      const aTime = Date.parse(a.summary?.updated_at ?? a.assets[0]?.updated_at ?? '')
      const bTime = Date.parse(b.summary?.updated_at ?? b.assets[0]?.updated_at ?? '')
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
    }),
    standalone,
  }
}

function getAssetContextRefType(item: SpaceContextItem): 'document' | null {
  if (isTabdocTeamSpaceAsset(item)) return 'document'
  return null
}

const DeliverableCard: React.FC<{
  deliverable: ProjectDeliverable
  onOpen: (item: SpaceContextItem) => void
  onAddToChat: (deliverable: ProjectDeliverable) => void
}> = ({ deliverable, onOpen, onAddToChat }) => {
  const { summary, assets } = deliverable
  const title = summary?.title
    ?? (assets[0]?.title ? `${assets[0].title} · 交付结果` : '未命名交付结果')
  const updatedAt = summary?.updated_at ?? assets[0]?.updated_at ?? null

  return (
    <article className="rounded-[14px] border border-foreground/[0.08] bg-foreground/[0.02] p-4 dark:bg-foreground/[0.03]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-caption font-medium text-accent-text">
            <Bot className="h-3 w-3" />
            任务交付
          </span>
          <h3 className="mt-2 truncate text-body font-semibold text-foreground">{title}</h3>
        </div>
        <span className="shrink-0 text-caption text-muted-foreground/60">
          {formatAssetTime(updatedAt)}
        </span>
      </div>

      <section className="mt-4">
        <h4 className="text-caption font-medium text-muted-foreground/60">结论</h4>
        <MarkdownRenderer
          content={summary?.preview || '这次交付尚未写入结论。'}
          className="mt-1 text-foreground/90"
          renderLevel={2}
          resourceSpaceId={summary?.space_id ?? assets[0]?.space_id}
        />
      </section>

      {assets.length > 0 ? (
        <section className="mt-4">
          <h4 className="text-caption font-medium text-muted-foreground/60">
            相关资产 · {assets.length}
          </h4>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {assets.map(asset => (
              <button
                key={asset.id}
                type="button"
                aria-label={`打开资产：${asset.title || '未命名资产'}`}
                onClick={() => onOpen(asset)}
                className="flex min-w-0 items-center gap-3 rounded-[10px] bg-background/80 px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.06]"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-foreground/[0.05] text-muted-foreground">
                  <FileText className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-foreground">
                    {asset.title || '未命名资产'}
                  </span>
                  <span className="block text-caption text-muted-foreground/60">
                    {getAssetTypeLabel(asset)}
                  </span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-foreground/[0.06] pt-3">
        {summary && getAssetSourceField(summary, 'chat_session_id') ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(summary)}>
            <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
            查看执行会话
          </Button>
        ) : null}
        {assets.some(asset => getAssetContextRefType(asset) !== null) ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => onAddToChat(deliverable)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            添加到当前对话
          </Button>
        ) : null}
      </div>
    </article>
  )
}

const AssetCard: React.FC<{
  item: SpaceContextItem
  onOpen: (item: SpaceContextItem) => void
}> = ({ item, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(item)}
    className="grid min-h-28 content-between gap-3 rounded-[12px] bg-foreground/[0.03] p-4 text-left transition-colors hover:bg-foreground/[0.06] dark:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08]"
  >
    <span className="flex items-center justify-between gap-3">
      <span className="inline-flex w-fit items-center gap-1 rounded-full bg-foreground/[0.04] px-2 py-0.5 text-caption text-muted-foreground/60">
        <FileText className="h-3 w-3" />
        {getAssetTypeLabel(item)}
      </span>
      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/60" />
    </span>
    <div className="min-w-0">
      <div className="line-clamp-2 text-body font-medium text-foreground">{item.title || '未命名资产'}</div>
      {item.preview ? (
        <div className={cn('mt-1 line-clamp-2', CANVAS_TEXT_SECONDARY)}>
          {item.preview}
        </div>
      ) : null}
      <div className="mt-2 text-caption text-muted-foreground/80">
        {getAssetSourceLabel(item)}
        {' · '}
        {formatAssetTime(item.updated_at)}
      </div>
    </div>
  </button>
)

ProjectSidebarContent.displayName = 'ProjectSidebarContent'
ProjectMainContent.displayName = 'ProjectMainContent'

const TeamSpaceSettingsDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  space: Space | null
}> = ({ open, onOpenChange, space }) => {
  const updateSpace = useSpaceStore(state => state.updateSpace)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [workspace, setWorkspace] = useState<ProjectCompanionWorkspace | null>(null)
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!open || !space) return
    setName(space.name)
    setDescription(space.description ?? '')
    setIsSaving(false)
  }, [open, space])

  useEffect(() => {
    if (!open || !space) return
    let cancelled = false
    setWorkspace(null)
    setWorkspaceError(null)
    setIsWorkspaceLoading(true)
    void ProjectApiService.getProject(space.id)
      .then(project => {
        if (!cancelled) setWorkspace(project.my_workspace ?? null)
      })
      .catch(error => {
        projectLog.warn('settings workspace load failed', { projectId: space.id, error })
        if (!cancelled) setWorkspaceError('工作空间信息暂时无法加载')
      })
      .finally(() => {
        if (!cancelled) setIsWorkspaceLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, space])

  useEffect(() => {
    if (open && !space) {
      onOpenChange(false)
    }
  }, [onOpenChange, open, space])

  const handleSave = async () => {
    if (!space || isSaving) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast({ title: '请输入Project 名称' })
      return
    }
    setIsSaving(true)
    try {
      const updated = await updateSpace(space.id, {
        name: trimmedName,
        description: description.trim(),
        expected_version: space.config_version,
      })
      if (!updated) {
        toast({ title: 'Project 设置保存失败' })
        return
      }
      toast({ title: 'Project 设置已保存' })
      onOpenChange(false)
    } catch (error) {
      projectLog.error('settings update failed', { projectId: space?.id, error })
      toast({ title: 'Project 设置保存失败' })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-heading font-semibold text-foreground">Project 设置</DialogTitle>
          <DialogDescription className="text-body leading-6 text-muted-foreground">
            管理这个 Project 的名称与目标说明，并查看你在此 Project 下的私有工作空间。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60vh,32rem)] space-y-4 overflow-y-auto pr-1">
          <label className="block space-y-1.5">
            <span className="text-caption font-medium text-muted-foreground/80">名称</span>
            <Input value={name} onChange={event => setName(event.target.value)} placeholder="例如：发布准备" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-caption font-medium text-muted-foreground/80">描述</span>
            <Textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder="这个Project 要一起完成什么？"
              rows={3}
            />
          </label>
          <section aria-labelledby="project-settings-workspace-title">
            <div className="flex items-center justify-between gap-3">
              <span id="project-settings-workspace-title" className="text-caption font-medium text-muted-foreground/80">
                我的工作空间
              </span>
              <span className="text-caption text-muted-foreground/60">只读</span>
            </div>
            <div className="mt-1.5 rounded-[12px] bg-foreground/[0.03] p-3 dark:bg-foreground/[0.04]">
              {isWorkspaceLoading ? (
                <p className="flex items-center gap-2 text-caption text-muted-foreground/80">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  正在加载工作空间…
                </p>
              ) : workspaceError ? (
                <p className="text-caption text-muted-foreground/80">{workspaceError}</p>
              ) : workspace ? (
                <div>
                  <p className="text-body font-medium text-foreground">{workspace.name}</p>
                  <p className="mt-1 break-all text-caption text-muted-foreground/80">
                    {workspace.working_dir || '尚未设置工作目录'}
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-body font-medium text-foreground">尚未准备工作空间</p>
                  <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
                    可在成员模块中准备你的私有执行位置。
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={isSaving}>
            取消
          </Button>
          <Button type="button" variant="soft" onClick={handleSave} disabled={isSaving || !space}>
            {isSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const CreateTeamSpaceDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
}> = ({ open, onOpenChange }) => {
  const { t } = useTranslation('project')
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const reset = () => {
    setName('')
    setDescription('')
    setIsCreating(false)
  }

  const handleCreate = async () => {
    if (!selectedOrganization?.id) {
      toast({ title: t('createProjectDialog.selectOrganization', { defaultValue: '请先选择组织' }) })
      return
    }
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast({ title: t('createProjectDialog.nameRequired', { defaultValue: '请输入 Project 名称' }) })
      return
    }
    setIsCreating(true)
    const created = await createProjectWithCompanionWorkspace({
      organizationId: selectedOrganization.id,
      organizationName: selectedOrganization.name ?? '',
      projectName: trimmedName,
      description: description.trim(),
    })
    setIsCreating(false)
    if (!created.ok) {
      toast({ title: t('createProjectDialog.createFailed', { defaultValue: 'Project 创建失败' }), description: created.error })
      return
    }
    const workspace = {
      ...created.workspace,
      organization_id: selectedOrganization.id,
      type: 'workspace',
      project_id: created.project.id,
    } as unknown as Space
    useSpaceStore.setState(state => ({
      spaces: [created.project as Space, workspace].reduce<Space[]>((items, nextSpace) => (
        items.some(item => item.id === nextSpace.id)
          ? items.map(item => item.id === nextSpace.id ? nextSpace : item)
          : [...items, nextSpace]
      ), state.spaces),
    }))
    markTeamSpaceProjectNavigation(created.project.id)
    useIMStore.getState().closeIM()
    useIMStore.getState().setCurrentConversation(null)
    enterTeamSpaceProject(created.project.id)
    toast({ title: t('createProjectDialog.created', { defaultValue: 'Project 已创建' }) })
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      onOpenChange(nextOpen)
      if (!nextOpen) reset()
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-heading font-semibold text-foreground">
            {t('createProjectDialog.title', { defaultValue: '新建 Project' })}
          </DialogTitle>
          <DialogDescription className="text-body text-muted-foreground">
            {t('createProjectDialog.introduction', {
              defaultValue: 'Project 用任务串起成员、Agent、讨论、资产与执行记录；Project 不拥有团队共享本地目录，也不会额外创建项目专属 Agent。',
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-caption font-medium text-muted-foreground/80">
              {t('createProjectDialog.nameLabel', { defaultValue: '名称' })}
            </span>
            <Input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t('createProjectDialog.namePlaceholder', { defaultValue: '例如：发布准备' })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-caption font-medium text-muted-foreground/80">
              {t('createProjectDialog.descriptionLabel', { defaultValue: '描述' })}
            </span>
            <Textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder={t('createProjectDialog.descriptionPlaceholder', { defaultValue: '这个 Project 要一起完成什么？' })}
              rows={3}
            />
          </label>
          <p className={CANVAS_TEXT_SECONDARY}>
            {t('createProjectDialog.workspaceNotice', {
              defaultValue: '创建后会为当前成员在该 Project 下新建私有执行工作空间，并绑定当前设备、准备默认工作目录；不会新建项目专属 Agent。Agent 产物会回流到 Project，并按团队权限共享。',
            })}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('createProjectDialog.cancel', { defaultValue: '取消' })}
          </Button>
          <Button type="button" variant="soft" onClick={handleCreate} disabled={isCreating || !name.trim()}>
            {isCreating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t('createProjectDialog.create', { defaultValue: '创建' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
