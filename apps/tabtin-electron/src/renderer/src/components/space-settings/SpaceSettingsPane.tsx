/**
 * SpaceSettingsPane — Agent 管理面板入口
 *
 * 两种形态：
 *   1. **workspace**（Agent 档案）：渲染 `AgentProfilePane` + `AgentSettingsSheet`，
 *      呼吸感优先的"名片 + 模块列表 + 侧边详情"形态，由
 *      `useAgentSettingsSheetStore` 驱动右侧 Sheet。
 *   2. **非 workspace**（如 group）：保留原有"左分组导航 + 右内容区"，
 *      因为档案语义只对 Agent 有意义。
 *
 * 历史上的 `SettingsSectionContext` / `useSettingsSection` 仍然导出（供子面板
 * 在模块间跳转）。在 bot 模式下，由 `AgentSettingsSheet` 注入
 * setSection = open(section)。
 * （SSH 面板已迁出至「设置 → 设备」组，见 IA Phase 1·1B。）
 */
import React, { useEffect, useMemo, useState, useRef } from 'react'
import {
  Settings, Sparkles,
  Trash2, Archive, AlertTriangle, Wrench,
  Server, Shield, Cpu, Smartphone, Bot,
  LayoutGrid, Gauge, ArrowRightLeft, Users,
} from 'lucide-react'
import {
  Button, ConfirmDialog, Input, ScrollArea, toast, Dialog, DialogContent,
  DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  OverlayContainerProvider,
  Textarea,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { canManageOrganization as canManageOrganizationFn } from '@/hooks/useCanManageOrganization'
import { canManageSpaceLifecycle } from '@/hooks/useCanManageSpaceLifecycle'
import { canEditAgentSettings as canEditAgentSettingsFn } from '@/hooks/useCanEditAgentSettings'
import {
  effectiveCanEditAgentSettings,
  effectiveCanManageSpaceSettings,
  useSpaceSettingsEditGuard,
} from '@components/space-settings/hooks/useSpaceSettingsEditGuard'
import { SettingsNameConfirmDialog } from '@components/settings/SettingsNameConfirmDialog'
import { SETTINGS_CONTROL, SETTINGS_CONTROL_SM, SETTINGS_GROUP_LABEL, SETTINGS_HINT, SETTINGS_LABEL, SETTINGS_SECTION_TITLE, SETTINGS_TEXTAREA_FULL } from '@components/settings/settingsUi'
import { SkillsSection } from '@components/context-space/skills'
import { ArchivedChatSessionsSection } from '@components/space-settings/ArchivedChatSessionsSection'
import { ProjectApiService } from '@/services/spaceApi'
import { confirmDirtyBeforeSpaceDelete } from '@components/context-space/dirtyExitConfirm/spaceDeleteGuard'
import { DevicePanel } from '@components/space-settings/DevicePanel'
import { AgentSecurityPanel } from '@components/space-settings/AgentSecurityPanel'
import { ExecutionLimitsPanel } from '@components/space-settings/ExecutionLimitsPanel'
import { SubAgentPanel } from '@components/space-settings/SubAgentPanel'
import { MemoryPanel } from '@components/space-settings/MemoryPanel'
import { TeamSpaceMembersSection } from '@components/space-settings/TeamSpaceMembersSection'
import type { Space } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import {
  AgentAvatarUploader,
  avatarUpdateFromDraft,
  resolveSpaceAvatarDraftPreview,
  type SpaceAvatarDraft,
} from './AgentAvatarUploader'
import { SpaceSettingsSectionHeader } from './SpaceSettingsSectionHeader'
import { SpaceLoginEnvironmentSection } from './SpaceLoginEnvironmentSection'
import { AgentProfilePane } from './AgentProfilePane'
import { AgentSettingsSheet } from './AgentSettingsSheet'
import { useSpaceDeleteGuard } from './hooks/useSpaceDeleteGuard'
import { RemoteSettingsReadonlyNotice } from './RemoteSettingsReadonlyNotice'
import { SPACE_ARCHIVE_UI_ENABLED, SPACE_TRASH_UI_ENABLED } from '@/utils/featureFlags'
import { SettingsSectionContext, useSettingsSection as useSettingsSectionImpl, type SettingsSection } from './SettingsSectionContext'
import {
  useAgentSettingsSheetStore,
  type AgentSettingsSection,
} from '@stores/useAgentSettingsSheetStore'

// 兼容旧导入路径
export const useSettingsSection = useSettingsSectionImpl

// ---------------------------------------------------------------------------
// Navigation config
// ---------------------------------------------------------------------------

interface NavItem {
  key: string
  icon: React.FC<{ className?: string }>
  labelKey: string
  group?: string
}

const WORKSPACE_NAV_ITEMS: NavItem[] = [
  { key: 'general', icon: Settings, labelKey: 'tabs.general', group: 'basic' },
  // 应用与能力
  // 「应用管理」（'apps'）入口已屏蔽：应用启用属于组织层的权限分发，Space 管理不再承载
  { key: 'skills', icon: Sparkles, labelKey: 'tabs.skills', group: 'applications' },
  // ：对话上下文（memory）已从工作空间设置移除
  { key: 'subagents', icon: Bot, labelKey: 'tabs.subagents', group: 'applications' },
  // 「集成能力」（'extensions'）入口已屏蔽：Personal Plugin + Extension 混排体验未定型，暂不在 Agent 设置暴露
  // 'mcp' 已迁出至「设置 → 设备」组（IA Phase 1·1D）：MCP 是 device-local 资源，不再作为 per-Space tab。
  // 设备管理
  { key: 'device', icon: Smartphone, labelKey: 'tabs.device', group: 'devices' },
  // 'ssh' 已迁出至「设置 → 设备」组（IA Phase 1·1B），不再作为 Agent 设置 tab。
  { key: 'security', icon: Shield, labelKey: 'tabs.agentSecurity', group: 'devices' },
  { key: 'execution-limits', icon: Gauge, labelKey: 'tabs.executionLimits', group: 'devices' },
  // 「对外渠道」（'channels'）入口已屏蔽：Bot 外部渠道接入尚未产品化，Space 管理不再承载
  // 「开发者 API」（'api'）入口已屏蔽：Space 级开发者 API 不再在 Agent 设置中暴露
  // 管理
  { key: 'archived', icon: Archive, labelKey: 'tabs.archived', group: 'management' },
  // 'trash' 已迁至「团队设置 → 资源回收站」（/#2253）：资源归属团队，不再以 Space 为回收站边界。
]

export function getVisibleWorkspaceSettingsSectionKeys(): string[] {
  return WORKSPACE_NAV_ITEMS.map(item => item.key)
}

const GROUP_LABELS: Record<string, string> = {
  basic: '',
  applications: 'groups.applications',
  devices: 'groups.devices',
  governance: 'groups.governance',
  collaboration: 'groups.collaboration',
  management: 'groups.management',
}

const WORKSPACE_ONLY_KEYS = new Set(['device', 'security', 'execution-limits', 'subagents'])
const NON_WORKSPACE_NAV_ITEMS: NavItem[] = [
  WORKSPACE_NAV_ITEMS[0],
  { key: 'members', icon: Users, labelKey: 'tabs.members', group: 'collaboration' },
  ...WORKSPACE_NAV_ITEMS.filter(
    item => item.key !== 'general' && !WORKSPACE_ONLY_KEYS.has(item.key)
  ),
]
const getDefaultSection = (_spaceType?: string) => 'general'

// ---------------------------------------------------------------------------
// General Section
// ---------------------------------------------------------------------------

/**
 * GeneralSection 同时承载两类动作：
 * - 表单类（name/description/customRules/avatar）→ 调 updateSpace + updateAgent，
 *   后端校验 editor，对应 `canEditAgentSettings`（D3：A 类）
 * - 危险区（移入回收站 / 归档 / 删除 Space）→ Space 级 owner（工作空间）
 *   或 Organization Owner（Project）；对应 `canManageSpaceLifecycle`（B 类）
 */
const GeneralSection: React.FC<{
  spaceId: string
  canEditAgentSettings: boolean
  canManage: boolean
}> = ({ spaceId, canEditAgentSettings, canManage }) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore(state =>
    state.spaces.find(p => p.id === spaceId) ?? null
  )
  const isWorkspace = space?.type === 'workspace'
  const agent = useSpaceStore(state =>
    state.selectedSpace?.id === spaceId ? state.selectedAgent : null,
  )
  const user = useAuthStore(state => state.user)
  const currentUserRole = useOrganizationStore(state => state.currentUserRole)
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const isOrganizationOwner = !!(user && selectedOrganization && user.id === selectedOrganization.owner_id)
  const effectiveRole = currentUserRole ?? (isOrganizationOwner ? 'owner' : null)
  const canManageSpaceLifecycleActions = canManageSpaceLifecycle(
    space,
    agent,
    user?.id ?? null,
    effectiveRole,
  )
  const { updateSpace, updateAgent, deleteSpace, archiveSpace, loadSpaces, isLoading } = useSpaceStore(useShallow(state => ({
    updateSpace: state.updateSpace,
    updateAgent: state.updateAgent,
    deleteSpace: state.deleteSpace,
    archiveSpace: state.archiveSpace,
    loadSpaces: state.loadSpaces,
    isLoading: state.isLoading,
  })))

  // 工作空间删除守卫：最后 Space 禁删、远程端禁删并提示（§5.4）
  const deleteGuard = useSpaceDeleteGuard(space)

  const [name, setName] = useState(space?.name ?? '')
  const [description, setDescription] = useState(space?.description ?? '')
  const [customRules, setCustomRules] = useState(agent?.custom_rules ?? '')
  const [avatarDraft, setAvatarDraft] = useState<SpaceAvatarDraft | null>(null)
  const [formError, setFormError] = useState('')
  const [dangerError, setDangerError] = useState('')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteInputValue, setDeleteInputValue] = useState('')
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  /**
   * Wave 5b S5：删除 Space 时若绑定独立环境（非 default），弹窗里多一行警告
   * 提示用户该环境会被一并删除（PRD Story 8）。
   *
   * 此处用 useState + useEffect 而不是 react-query 是因为：
   *   1. 仅在删除弹窗打开瞬间一次性查询，无 refetch 需求；
   *   2. 主进程 BrowserEnvironmentService 是同步缓存查询，毫秒级返回；
   *   3. 避免引入新的 query hook 与 SpaceLoginEnvironmentSection 内部 hook 重复。
   */
  const [pendingDeleteEnv, setPendingDeleteEnv] = useState<{
    id: string
    name: string
    /**
     * 实际使用该环境的 Space 数。
     * 用于 handleDelete 决定是否真删 env：
     *   == 1（只有当前 Space 使用）→ 删除孤儿 env；
     *   >  1（其他 Space 也共享）→ 不删 env，只删 Space binding 自动 rebind 当前 Space；
     *      其他 Space 不受影响。
     */
    using_space_count: number
  } | null>(null)

  useEffect(() => {
    if (!space) return
    setName(space.name)
    setDescription(space.description ?? '')
    setAvatarDraft(null)
    setFormError('')
    setDangerError('')
    setDeleteDialogOpen(false)
    setDeleteInputValue('')
  }, [space?.id, space?.name, space?.description, space?.avatar])

  // S5：弹窗打开时拉一次绑定，关闭时清掉。
  useEffect(() => {
    if (!deleteDialogOpen || !space) {
      setPendingDeleteEnv(null)
      return
    }
    let cancelled = false
    const browserEnv = (window as any).tabtin?.browserEnv
    if (!browserEnv?.getEnvironmentForSpace) return undefined
    void browserEnv
      .getEnvironmentForSpace({ spaceId: space.id })
      .then((res: any) => {
        if (cancelled) return
        const env = res?.environment
        if (env && env.is_default === false) {
          setPendingDeleteEnv({
            id: env.id,
            name: env.name,
            using_space_count: typeof env.using_space_count === 'number'
              ? env.using_space_count
              : 1,
          })
        } else {
          setPendingDeleteEnv(null)
        }
      })
      .catch((err: any) => {
        // 查询失败不阻塞删除流程，只是少了警告——保守取舍
        console.warn('[GeneralSection] getEnvironmentForSpace failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [deleteDialogOpen, space?.id])

  useEffect(() => {
    setCustomRules(agent?.custom_rules ?? '')
  }, [agent?.id, agent?.custom_rules])

  if (!space) return null

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    if (!name.trim()) {
      setFormError(t('validation.nameRequired'))
      return
    }
    try {
      const tasks: Promise<unknown>[] = [
        updateSpace(space.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          ...avatarUpdateFromDraft(avatarDraft),
        }),
      ]
      if (agent) {
        tasks.push(updateAgent(agent.id, {
          custom_rules: customRules.trim(),
        }))
      }
      const results = await Promise.all(tasks)
      if (results[0] === false) {
        setFormError(useSpaceStore.getState().error ?? t('errors.updateFailed'))
        return
      }
      setAvatarDraft(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('errors.updateFailed'))
    }
  }

  const handleDelete = async () => {
    setDangerError('')
    if (deleteInputValue.trim() !== space.name.trim()) {
      const msg = t('validation.nameMismatch')
      setDangerError(msg)
      throw new Error(msg)
    }
    // W2.5 T9: 先做 dirty 合并对话框确认；用户取消 / 保存失败时阻止删除
    const ok = await confirmDirtyBeforeSpaceDelete({
      spaceId: space.id,
      spaceName: space.name,
    })
    if (!ok) {
      const msg = t('errors.deleteCancelled', { defaultValue: '删除已取消' })
      setDangerError(msg)
      throw new Error(msg)
    }
    // Wave 5b S5：在 deleteSpace 前快照独立环境，删除成功后再清理孤儿环境
    // （Space.on_delete=CASCADE 只清 SpaceEnvironmentBinding，不会清 BrowserEnvironment）。
    //
    // 关键：**仅当该 env 只被本 Space 使用时**（using_space_count <= 1）才删 env，
    // 否则其他 Space 还在使用——删除会让那些 Space 被 rebind 到默认环境，副作用
    // 超出"用户删自己 Agent"的预期（PRD Story 8 是单租户场景）。
    const envToCleanup =
      pendingDeleteEnv && pendingDeleteEnv.using_space_count <= 1 ? pendingDeleteEnv : null
    const deleted = await deleteSpace(space.id)
    if (!deleted) {
      const msg = useSpaceStore.getState().error ?? t('errors.deleteFailed')
      setDangerError(msg)
      throw new Error(msg)
    }
    if (envToCleanup) {
      const browserEnv = (window as any).tabtin?.browserEnv
      if (browserEnv?.delete) {
        try {
          const r = await browserEnv.delete({ id: envToCleanup.id })
          if (!r?.success) {
            toast({
              title: t('browserEnv.deleteWarning.deleteEnvFailedTitle'),
              description: t('browserEnv.deleteWarning.deleteEnvFailedDesc', {
                name: envToCleanup.name,
              }),
              variant: 'destructive',
            })
          } else {
            // Wave 5b 视角 1#3 自修：S5 弹窗打开时拉的 using_space_count
            // 是快照——用户犹豫期间其他端把别的 Space 也 bind 到这个 env
            // 后，删除会让那些 Space 静默 rebound 回默认环境（撕破 PD-2 隔离）。
            // 后端 DELETE 已经返回 rebound_bindings / rebound_space_ids，
            // 前端消费起来给用户兜底 toast，让他知情。
            const reboundCount =
              typeof r?.rebound_bindings === 'number'
                ? r.rebound_bindings
                : Array.isArray(r?.rebound_space_ids)
                  ? r.rebound_space_ids.length
                  : 0
            if (reboundCount > 0) {
              toast({
                title: t('browserEnv.deleteWarning.reboundOthersTitle'),
                description: t('browserEnv.deleteWarning.reboundOthersDesc', {
                  name: envToCleanup.name,
                  count: reboundCount,
                }),
              })
            }
          }
        } catch (err) {
          console.warn('[GeneralSection] browserEnv.delete failed:', err)
          toast({
            title: t('browserEnv.deleteWarning.deleteEnvFailedTitle'),
            description: t('browserEnv.deleteWarning.deleteEnvFailedDesc', {
              name: envToCleanup.name,
            }),
            variant: 'destructive',
          })
        }
      }
    }
  }

  const handleTrashSpace = async () => {
    setDangerError('')
    try {
      // ：团队 Project → 回收站；个人工作空间 → 直接删除（无 trash）
      if (space.type === 'team_space') {
        await ProjectApiService.trash(space.id)
        void loadSpaces(space.organization_id).catch(() => {})
        toast({
          title: t('trash.trashSuccess', { defaultValue: `已移入回收站：${space.name}` }),
          description: t('trash.trashShareWarning', { defaultValue: '已移入回收站，可在保留期内恢复' }),
          action: (
            <button
              type="button"
              className="text-body font-medium text-accent hover:underline"
              onClick={async () => {
                try {
                  await ProjectApiService.restoreFromTrash(space.id)
                  void loadSpaces(space.organization_id).catch(() => {})
                  toast({ title: t('trash.restoreSuccess', { name: space.name }) })
                } catch {
                  toast({ title: t('trash.restoreFailed', { defaultValue: '撤销失败' }), variant: 'destructive' })
                }
              }}
            >
              {t('undo', { defaultValue: '撤销' })}
            </button>
          ),
        })
        return
      }
      const deleted = await deleteSpace(space.id)
      if (!deleted) {
        throw new Error(t('errors.trashFailed', { defaultValue: '移入回收站失败' }))
      }
      toast({
        title: t('trash.trashSuccess', { defaultValue: `已删除：${space.name}` }),
      })
    } catch (err) {
      setDangerError(err instanceof Error ? err.message : t('errors.trashFailed', { defaultValue: '移入回收站失败' }))
    }
  }

  const handleArchive = async () => {
    setDangerError('')
    try {
      await archiveSpace(space.id)
    } catch (err) {
      setDangerError(err instanceof Error ? err.message : t('errors.archiveFailed'))
    }
  }

  const isDirty = avatarDraft !== null ||
    name !== (space.name ?? '') ||
    description !== (space.description ?? '') ||
    customRules !== (agent?.custom_rules ?? '')
  const previewAvatar = resolveSpaceAvatarDraftPreview(avatarDraft, space.avatar)

  return (
    <form onSubmit={handleUpdate} className="flex flex-col h-full">
      <ScrollArea className="flex-1"><div className="space-y-4">
        <SpaceSettingsSectionHeader
          marginBottomClassName="mb-2"
          title={t('tabs.general')}
          description={t('general.moduleHint')}
        />
        {/* 头像上传：裁剪/移除只进草稿，随表单保存一起持久化 */}
        <AgentAvatarUploader
          spaceId={space.id}
          canManage={canEditAgentSettings}
          currentAvatar={previewAvatar}
          onAvatarUploaded={(url) => setAvatarDraft({ type: 'set', url })}
          onAvatarRemoved={() => setAvatarDraft({ type: 'clear' })}
        />

        {/* 名称 */}
        <div className="space-y-1">
          <label className={SETTINGS_LABEL}>
            {t('fields.name')} <span className="text-destructive/80">*</span>
          </label>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('fields.namePlaceholder')}
            maxLength={100}
            disabled={isLoading || !canEditAgentSettings}
            className={cn('w-full', SETTINGS_CONTROL)}
          />
          <p className={SETTINGS_HINT}>
            {t('fields.nameHint', { count: name.length })}
          </p>
        </div>

        {/* 可见范围（只读） */}
        <div className="space-y-1">
          <label className={SETTINGS_LABEL}>
            {t('fields.visibility', { defaultValue: '可见范围' })}
          </label>
          <p className={cn(SETTINGS_CONTROL, 'flex items-center h-9 px-3 rounded-interactive bg-muted/20 text-foreground')}>
            {space.visibility === 'shared'
              ? t('fields.visibilityShared', {
                  count: space.member_count ?? 1,
                  defaultValue: `已共享 · ${space.member_count ?? 1} 人`,
                })
              : t('fields.visibilityPrivate', { defaultValue: '仅自己可见' })}
          </p>
          <p className={SETTINGS_HINT}>
            {t('fields.visibilityHint', {
              defaultValue: '新建工作空间默认仅自己可见；添加组织成员后会变为已共享。',
            })}
          </p>
        </div>

        {/* 描述 */}
        <div className="space-y-1">
          <label className={SETTINGS_LABEL}>{t('fields.description')}</label>
          <Textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t('fields.descriptionPlaceholder')}
            maxLength={500}
            rows={3}
            disabled={isLoading || !canEditAgentSettings}
            className={SETTINGS_TEXTAREA_FULL}
          />
        </div>

        {/* 自定义规则 */}
        {agent && (
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('fields.customRules', { defaultValue: '自定义规则' })}</label>
            <Textarea
              value={customRules}
              onChange={e => setCustomRules(e.target.value)}
              placeholder={t('fields.customRulesPlaceholder', { defaultValue: 'Agent 在所有对话中遵循的规则，如代码风格、回复语言偏好等' })}
              maxLength={5000}
              rows={5}
              disabled={isLoading || !canEditAgentSettings}
              className={SETTINGS_TEXTAREA_FULL}
            />
            <p className={SETTINGS_HINT}>
              {t('fields.customRulesHint', { defaultValue: '设定执行任务时的要求，Agent 会严格遵循这些规则' })}
            </p>
          </div>
        )}

        {formError && (
          <p className="text-caption text-destructive">{formError}</p>
        )}

        {/* 登录环境：仅对仍绑定独立环境的历史 Space 显示（组件内部自判，
            共享环境 / 新用户直接 return null），给老用户保留切回共享环境的出口。 */}
        {isWorkspace && (
          <SpaceLoginEnvironmentSection spaceId={space.id} canManage={canManage} />
        )}

        {/* 危险区域：Space 级 owner 可管理工作空间生命周期（§5.4） */}
      {/* 删除入口始终保留；回收站 / 归档受 flag 控制 */}
      {canManageSpaceLifecycleActions && (
        <div className="border-t border-border/30 pt-4 space-y-2">
          <h4 className={cn(SETTINGS_SECTION_TITLE, 'flex items-center gap-1.5')}>
            <AlertTriangle className="h-3 w-3" />
            {t('danger.title')}
          </h4>

          {SPACE_TRASH_UI_ENABLED && (
            <div className="flex items-center justify-between gap-4 py-1.5">
              <div className="min-w-0">
                <div className="text-body font-medium text-foreground">{t('danger.trashTitle', { defaultValue: '移入回收站' })}</div>
                <div className={SETTINGS_HINT}>{t('danger.trashDesc')}</div>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTrashConfirmOpen(true)}
                disabled={isLoading || deleteGuard.isResolving || deleteGuard.isRemoteViewer || deleteGuard.blockReason === 'last-space'}
                className={cn('shrink-0 gap-1', SETTINGS_CONTROL_SM)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('actions.trash', { defaultValue: '移入回收站' })}
              </Button>
            </div>
          )}

          {SPACE_ARCHIVE_UI_ENABLED && (
            <div className="flex items-center justify-between gap-4 py-1.5">
              <div className="min-w-0">
                <div className="text-body font-medium text-foreground">{t('danger.archiveTitle')}</div>
                <div className={SETTINGS_HINT}>{t('danger.archiveDesc')}</div>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setArchiveConfirmOpen(true)}
                disabled={isLoading || deleteGuard.isResolving || deleteGuard.isRemoteViewer}
                className={cn('shrink-0 gap-1', SETTINGS_CONTROL_SM)}
              >
                <Archive className="h-3.5 w-3.5" />
                {t('actions.archive')}
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between gap-4 py-1.5">
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground">{t('danger.deleteTitle')}</div>
              <div className={SETTINGS_HINT}>{t('danger.deleteDesc')}</div>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDangerError('')
                setDeleteInputValue('')
                setDeleteDialogOpen(true)
              }}
              disabled={isLoading || !deleteGuard.canDelete}
              className={cn('shrink-0 gap-1 text-destructive/60 hover:text-destructive hover:bg-destructive/5', SETTINGS_CONTROL_SM)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('actions.delete')}
            </Button>
          </div>

          {deleteGuard.blockReason === 'remote' && (
            <p className={SETTINGS_HINT}>
              {deleteGuard.controlDeviceName
                ? t('danger.remoteLifecycleHintWithDevice', {
                    device: deleteGuard.controlDeviceName,
                    defaultValue: `正在远程查看。删除等操作请回到执行设备「${deleteGuard.controlDeviceName}」本机进行。`,
                  })
                : t('danger.remoteLifecycleHint', {
                    defaultValue: '正在远程查看。删除等操作请回到执行设备本机进行。',
                  })}
            </p>
          )}
          {deleteGuard.blockReason === 'last-space' && (
            <p className={SETTINGS_HINT}>
              {t('danger.lastSpaceHint', {
                defaultValue:
                  '这是当前 Team 在这台设备上的最后一个 Space，需至少保留一个，不能删除或移入回收站。',
              })}
            </p>
          )}
          {deleteGuard.blockReason === 'resolving' && (
            <p className={SETTINGS_HINT}>
              {t('danger.deviceResolvingHint', {
                defaultValue: '正在识别本机设备，请稍候再试删除或移入回收站。',
              })}
            </p>
          )}
          {dangerError && <p className="text-caption text-destructive">{dangerError}</p>}
        </div>
      )}
      </div></ScrollArea>

      {/* 固定在底部的保存按钮 */}
      <div className="shrink-0 flex justify-end pt-3 border-t border-border/20 mt-3">
        <Button
          type="submit"
          disabled={isLoading || !canEditAgentSettings || !name.trim() || !isDirty}
          className={cn(
            SETTINGS_CONTROL,
            'transition-opacity',
            !isDirty && 'opacity-40'
          )}
        >
          {isLoading ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>

      <SettingsNameConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={open => {
            setDeleteDialogOpen(open)
            if (!open) {
              setDeleteInputValue('')
              setDangerError('')
            }
          }}
          title={t('confirm.title')}
          subtitle={t('confirm.subtitle')}
          items={[
            // 只删工作空间记录和必要关系，组织资源与本机目录保留（§5.4）
            t('confirm.items.spaceOnly', {
              name: space.name,
              defaultValue: `只删除工作空间记录和必要关系：${space.name}`,
            }),
            t('confirm.items.keepResources', {
              defaultValue: '组织文档、表格和云端文件不会被删除',
            }),
            space.working_dir
              ? t('confirm.items.keepWorkingDirPath', {
                  path: space.working_dir,
                  defaultValue: `本机工作目录会保留在原位置：${space.working_dir}`,
                })
              : t('confirm.items.keepWorkingDir', {
                  defaultValue: '本机工作目录不会被删除',
                }),
            // Wave 5b S5：根据登录环境绑定状态追加针对性文案。
            //   - 独立环境 + using_space_count <= 1：本 Space 是该独立 env 唯一使用者 →
            //     "环境会一并被删除（登录态丢失）"——PRD Story 8 主路径。
            //   - 独立环境 + using_space_count > 1：其他 Space 还在用 → 不删 env，警告文案
            //     仅说"将解除绑定"，避免误导。
            //   - 共享环境（pendingDeleteEnv === null）：不再追加登录环境文案。移除独立
            //     环境入口后，"共享 vs 独立"概念对新用户不存在，删除时再提反而困惑。
            ...(pendingDeleteEnv
              ? [
                  pendingDeleteEnv.using_space_count <= 1
                    ? t('browserEnv.deleteWarning.envWillBeDeleted', {
                        name: pendingDeleteEnv.name,
                      })
                    : t('browserEnv.deleteWarning.envBindingOnly', {
                        name: pendingDeleteEnv.name,
                        others: pendingDeleteEnv.using_space_count - 1,
                      }),
                ]
              : []),
          ]}
          warning={t('confirm.warning')}
          inputLabel={t('confirm.inputLabel')}
          inputPlaceholder={space.name}
          inputValue={deleteInputValue}
          onInputChange={setDeleteInputValue}
          expectedValue={space.name}
          error={dangerError}
          isLoading={isLoading}
          confirmText={t('actions.confirmDelete')}
          cancelText={t('actions.cancel')}
          onConfirm={handleDelete}
        />

      {SPACE_TRASH_UI_ENABLED && (
        <ConfirmDialog
          open={trashConfirmOpen}
          onOpenChange={setTrashConfirmOpen}
          title={t('danger.trashConfirmTitle', { defaultValue: '确认移入回收站？' })}
          description={t('danger.trashConfirmDesc', { name: space.name, defaultValue: `确定要将「${space.name}」移入回收站吗？30 天内可从回收站恢复。` })}
          variant="destructive"
          onConfirm={handleTrashSpace}
        />
      )}

      {SPACE_ARCHIVE_UI_ENABLED && (
        <ConfirmDialog
          open={archiveConfirmOpen}
          onOpenChange={setArchiveConfirmOpen}
          title={t('danger.archiveConfirmTitle', { defaultValue: '确认归档？' })}
          description={t('danger.archiveConfirmDesc', { name: space.name, defaultValue: `确定要归档「${space.name}」吗？归档后不会显示在列表中，但可以恢复。` })}
          variant="destructive"
          onConfirm={handleArchive}
        />
      )}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface SpaceSettingsPaneProps {
  spaceId: string
  initialSection?: string
  renderAgentSettingsSheet?: boolean
}

export const SpaceSettingsPane: React.FC<SpaceSettingsPaneProps> = ({
  spaceId,
  initialSection,
  renderAgentSettingsSheet = false,
}) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore(state =>
    state.spaces.find(p => p.id === spaceId) ?? null
  )
  const [section, setSection] = useState<SettingsSection>(
    initialSection ?? getDefaultSection(space?.type)
  )
  const currentUserRole = useOrganizationStore(state => state.currentUserRole)
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const user = useAuthStore(state => state.user)
  const isOwner = !!(user && selectedOrganization && user.id === selectedOrganization.owner_id)
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' : null)
  /**
   * `canManage` (admin+)：用于 B 类面板——非 agent_config 的高风险动作。
   * 包括：Project 删除/归档/移入回收站、改 SSH 密钥、TrashBin、子 Agent 模板、
   * 共享/委托/成员管理、扩展/MCP/渠道/应用启用配置等。
   * 工作空间生命周期改走 `canManageSpaceLifecycle`（Space 级 owner）。
   * 注：设备首次绑定 / 添加远程设备后端为 editor 校验，已归到 canEditAgentSettings。
   */
  const canManage = canManageOrganizationFn(effectiveRole)
  const settingsEditGuard = useSpaceSettingsEditGuard(spaceId)
  /**
   * `canEditAgentSettings` (editor+)：用于 A 类面板——后端 `update_agent` 已允许 editor 修改。
   * 包括：AgentSecurityPanel、ExecutionLimitsPanel、MemoryPanel，
   * 以及 GeneralSection 的表单字段（name/description/customRules/avatar）。
   * 远程查看时一律只读（与 deleteGuard 同口径）。
   */
  const canEditAgentSettings = effectiveCanEditAgentSettings(
    canEditAgentSettingsFn(effectiveRole),
    settingsEditGuard,
  )
  const canManageSpaceSettings = effectiveCanManageSpaceSettings(
    canManage,
    settingsEditGuard,
  )
  const spaceType = space?.type
  const effectiveSpace: Space | null = space
  const isWorkspace = spaceType === 'workspace'

  // ── workspace：使用档案 + 侧边 Sheet 形态 ──
  // OverlayContainerProvider 让 Sheet scoped 到本面板内（不全屏 portal 到 body）
  const overlayContainerRef = useRef<HTMLDivElement | null>(null)
  const openSheet = useAgentSettingsSheetStore(s => s.open)
  const closeSheet = useAgentSettingsSheetStore(s => s.close)
  const currentSessionIdForSpace = useChatStore(s => s.currentSessionIdBySpaceId[spaceId] ?? null)

  // initialSection 在 bot 模式下转译为"自动打开侧边 sheet 到对应 section"
  // 只在 spaceId / initialSection 变化时触发一次，不会在 sheet 用户手动关闭后再次自动打开
  const lastOpenedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isWorkspace || !initialSection || !space) return
    const sheetSections = new Set<string>([
      'profile-identity', 'profile-rules',
      // 'skills' 不在列：Skill 走独立 SkillPanel（PRD §4.5/§8.8），bot Sheet 无 skills 面板，
      // 不应自动打开（否则 AgentSettingsSheet 取不到 SECTION_TITLE_KEY['skills'] 会崩）。
      'memory', 'subagents',
      'device', 'security', 'execution-limits',
      'archived',
    ])
    if (!sheetSections.has(initialSection)) return
    const key = `${space.id}:${initialSection}`
    if (lastOpenedKeyRef.current === key) return
    lastOpenedKeyRef.current = key
    openSheet(initialSection as AgentSettingsSection, space.id, { sessionId: currentSessionIdForSpace })
  }, [isWorkspace, initialSection, space, openSheet, currentSessionIdForSpace])

  // 切换 spaceId 时关闭可能残留的 sheet（避免错位渲染）
  useEffect(() => {
    return () => {
      closeSheet()
    }
  }, [spaceId, closeSheet])

  useEffect(() => {
    if (initialSection) {
      setSection(initialSection)
      return
    }
    if (spaceType) {
      setSection(getDefaultSection(spaceType))
    }
  }, [initialSection, spaceType])

  const visibleNavItems = useMemo(() => {
    if (isWorkspace) return WORKSPACE_NAV_ITEMS
    return NON_WORKSPACE_NAV_ITEMS
  }, [isWorkspace])

  useEffect(() => {
    if (!visibleNavItems.some(item => item.key === section)) {
      setSection(visibleNavItems[0]?.key ?? getDefaultSection(spaceType))
    }
  }, [section, spaceType, visibleNavItems])

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: NavItem[] }> = []
    let currentGroup: string | undefined
    for (const item of visibleNavItems) {
      if (item.group !== currentGroup) {
        currentGroup = item.group
        groups.push({
          label: GROUP_LABELS[currentGroup ?? ''] ?? '',
          items: [],
        })
      }
      groups[groups.length - 1].items.push(item)
    }
    return groups
  }, [visibleNavItems])

  const ctxValue = useMemo(() => ({ section, setSection }), [section])

  if (!spaceId || !effectiveSpace) {
    return (
      <div className="flex h-full items-center justify-center text-body text-muted-foreground">
        {t('errors.spaceNotFound', { defaultValue: '当前工作空间不存在或你已无权访问' })}
      </div>
    )
  }

  // ── workspace → 档案 + 侧边 Sheet ──
  if (isWorkspace) {
    return (
      <OverlayContainerProvider containerRef={overlayContainerRef}>
        <div
          ref={overlayContainerRef}
          className="relative flex h-full w-full overflow-hidden"
        >
          <AgentProfilePane spaceId={spaceId} />
          {renderAgentSettingsSheet ? <AgentSettingsSheet spaceId={spaceId} /> : null}
        </div>
      </OverlayContainerProvider>
    )
  }

  // ── 非 workspace（group 等）→ 沿用左导航 + 右内容区 ──
  return (
    <SettingsSectionContext.Provider value={ctxValue}>
      <div className="flex h-full w-full bg-background">
        {/* 左导航 */}
        <nav className="w-40 shrink-0 border-r border-border/30 py-3 px-2 space-y-2.5 overflow-y-auto">
          {grouped.map((group, gi) => (
            <div key={gi} className="space-y-0.5">
              {group.label && (
                <div className={cn('px-2.5 pt-1.5 pb-1', SETTINGS_GROUP_LABEL)}>
                  {t(group.label, { defaultValue: group.label })}
                </div>
              )}
              {group.items.map(item => {
                const Icon = item.icon
                const isActive = section === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setSection(item.key)}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-body transition-colors',
                      isActive
                        ? 'bg-muted/40 text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-foreground' : 'text-muted-foreground/60')} />
                    <span className="truncate">{t(item.labelKey)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        {/* 右内容区 */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 px-6 py-4">
          <div className="flex-1 flex flex-col min-h-0 w-full">
            {/* A 类面板（editor+ 可改，对齐后端 update_agent 校验） */}
            {section === 'general' && <GeneralSection spaceId={spaceId} canEditAgentSettings={canEditAgentSettings} canManage={canManageSpaceSettings} />}
            {/* Project 成员管理权限在组件内按 SpaceMembership owner 判定（对齐后端），不走 Organization 角色 */}
            {section === 'members' && effectiveSpace && <TeamSpaceMembersSection space={effectiveSpace} />}
            {section === 'security' && isWorkspace && (
              <AgentSecurityPanel
                spaceId={spaceId}
                canManage={canEditAgentSettings}
                sessionId={currentSessionIdForSpace}
              />
            )}
            {section === 'execution-limits' && isWorkspace && <ExecutionLimitsPanel spaceId={spaceId} canManage={canEditAgentSettings} />}
            {section === 'memory' && effectiveSpace && <MemoryPanel space={effectiveSpace} canManage={canEditAgentSettings} />}

            {/* 设备绑定后端为 editor 校验（bind_agent_device / createInstallToken），故前端对齐 editor+ */}
            {section === 'device' && isWorkspace && (
              <ScrollArea className="flex-1">
                <DevicePanel
                  spaceId={spaceId}
                  canManage={canEditAgentSettings}
                  roleCanEdit={canEditAgentSettingsFn(effectiveRole)}
                />
              </ScrollArea>
            )}
            {section === 'subagents' && isWorkspace && (
              <SubAgentPanel spaceId={spaceId} canManage={canEditAgentSettings} />
            )}
            {section === 'skills' && <ScrollArea className="flex-1"><SkillsSection spaceId={spaceId} canManage={canManageSpaceSettings} /></ScrollArea>}
            {/* 「集成能力」（'extensions'）入口已屏蔽：见 WORKSPACE_NAV_ITEMS 注释 */}
            {/* MCP 已迁出至「设置 → 设备」组（IA Phase 1·1D）：MCP 是 device-local 资源，不再作为 per-Space 面板。 */}
            {section === 'archived' && effectiveSpace && (
              <ArchivedChatSessionsSection
                spaceId={spaceId}
                organizationId={effectiveSpace.organization_id}
                className="flex-1 min-h-0"
              />
            )}
          </div>
        </div>
      </div>
    </SettingsSectionContext.Provider>
  )
}
