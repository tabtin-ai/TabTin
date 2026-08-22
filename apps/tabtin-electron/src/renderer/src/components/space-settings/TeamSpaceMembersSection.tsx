/**
 * TeamSpaceMembersSection — Project 成员管理（唯一实现，勿再造）。
 *
 * 三个入口复用：
 *   1. SpaceSettingsPane 的 members section
 *   2. 项目页齿轮 TeamSpaceSettingsDialog 的「成员」tab
 *   3. 项目页「成员 / Agent」Tab 的 Space 成员区
 *
 * 管理权限对齐后端口径（access_service._assert_can_manage_team_space）：
 * 仅当前用户自己的 SpaceMembership role=owner 可管理，Organization owner/admin 无隐式提权。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, ScrollArea, toast } from '@components/ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useTeamSpacePresence } from '@/hooks/useTeamSpacePresence'
import { MemberApiService } from '@/services/memberApi'
import { SpaceAccessApiService } from '@/services/spaceAccessApi'
import { ProjectApiService } from '@/services/projectApi'
import { SETTINGS_CONTROL, SETTINGS_CONTROL_SM, SETTINGS_HINT, SETTINGS_LABEL } from '@components/settings/settingsUi'
import type { Space, OrganizationMember } from '@tabtin/app-shell'
import type { SpaceMembership } from '@/types/space-access'
import type { ProjectPendingInvitation } from '@/types/project'
import { cn } from '@utils/cn'
import { SpaceSettingsSectionHeader } from './SpaceSettingsSectionHeader'
import { PROJECT_INVITATION_RECEIVED_EVENT } from '@components/layout/project/PendingProjectInvitations'

export interface TeamSpaceMembersSectionProps {
  space: Space
  /** 设置面板内需要自滚动（默认 true）；嵌入已可滚动的页面/Dialog 时传 false */
  scrollable?: boolean
  /** 是否渲染「成员」标题头（嵌入外部已有标题的容器时传 false） */
  showHeader?: boolean
}

export const TeamSpaceMembersSection: React.FC<TeamSpaceMembersSectionProps> = ({
  space,
  scrollable = true,
  showHeader = true,
}) => {
  const { t } = useTranslation('space')
  const loadSpaces = useSpaceStore(state => state.loadSpaces)
  const currentUserId = useAuthStore(state => state.user?.id)
  const [memberships, setMemberships] = useState<SpaceMembership[]>([])
  const [pendingInvitations, setPendingInvitations] = useState<ProjectPendingInvitation[]>([])
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationMember[]>([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState('')

  // Project presence：谁现在开着这个 Space（阶段4 在场感）
  const { isUserOnline } = useTeamSpacePresence(space.id, space.type === 'team_space')

  // 仅当前用户自己的 SpaceMembership role=owner 可管理（对齐后端）
  const canManage = useMemo(() => {
    if (!currentUserId) return false
    return memberships.some(
      m => m.is_active && m.user_id === String(currentUserId) && m.role === 'owner',
    )
  }, [memberships, currentUserId])

  const loadMembers = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const [spaceMembers, teamMembers, pending] = await Promise.all([
        SpaceAccessApiService.listSpaceMemberships(space.id),
        MemberApiService.getMembers(space.organization_id, { limit: 200 }),
        ProjectApiService.listProjectPendingInvitations(space.id).catch(() => [] as ProjectPendingInvitation[]),
      ])
      setMemberships(spaceMembers.memberships)
      setOrganizationMembers(teamMembers.members)
      setPendingInvitations(pending)
      const occupiedUserIds = new Set([
        ...spaceMembers.memberships.map(item => item.user_id).filter(Boolean) as string[],
        ...pending.map(item => item.user_id),
      ])
      setSelectedUserId(current => {
        if (current && !occupiedUserIds.has(current)) return current
        const next = teamMembers.members.find(member => !occupiedUserIds.has(member.user_id))
        return next?.user_id ?? ''
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('members.loadFailed', { defaultValue: '加载成员失败' }))
    } finally {
      setIsLoading(false)
      setHasLoaded(true)
    }
  }, [space.id, space.organization_id, t])

  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  // 对方接受/拒绝后推送 space.invitation.*，重拉使「待接受」收敛为成员或消失。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; isSync?: boolean }>).detail
      if (detail?.projectId && detail.projectId !== space.id && !detail.isSync) return
      void loadMembers()
    }
    window.addEventListener(PROJECT_INVITATION_RECEIVED_EVENT, handler)
    return () => window.removeEventListener(PROJECT_INVITATION_RECEIVED_EVENT, handler)
  }, [loadMembers, space.id])

  const memberByUserId = useMemo(() => {
    return new Map(organizationMembers.map(member => [member.user_id, member]))
  }, [organizationMembers])

  const activeUserIds = useMemo(() => {
    return new Set(memberships.map(item => item.user_id).filter(Boolean))
  }, [memberships])

  const pendingUserIds = useMemo(() => {
    return new Set(pendingInvitations.map(item => item.user_id))
  }, [pendingInvitations])

  const inviteOptions = useMemo(() => {
    return organizationMembers.filter(
      member => !activeUserIds.has(member.user_id) && !pendingUserIds.has(member.user_id),
    )
  }, [activeUserIds, organizationMembers, pendingUserIds])

  const displayMemberName = useCallback((userId?: string | null) => {
    if (!userId) return t('members.unknownIdentity', { defaultValue: '未知成员' })
    const member = memberByUserId.get(userId)
    return (
      member?.user?.nickname ||
      member?.user?.username ||
      member?.user?.email ||
      userId
    )
  }, [memberByUserId, t])

  const handleInvite = async () => {
    if (!selectedUserId) return
    setIsLoading(true)
    setError('')
    try {
      // 发邀请（建 pending 成员 + 通知）；成员需在自己的 Electron 上接受后才生效，
      // 接受时才当场供给其伴生工作空间。直加路径（addSpaceMembership）保留给系统内部。
      await ProjectApiService.inviteMember(space.id, {
        user_id: selectedUserId,
        role: 'editor',
      })
      toast({
        title: t('members.inviteSent', { defaultValue: '邀请已发送' }),
        description: t('members.inviteSentHint', {
          defaultValue: '成员在自己的设备上接受后会加入本项目，并获得专属执行工作空间。',
        }),
      })
      await loadMembers()
      await loadSpaces(space.organization_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('members.inviteFailed', { defaultValue: '邀请成员失败' }))
    } finally {
      setIsLoading(false)
    }
  }

  const body = (
    <div className="space-y-4">
      {showHeader && (
        <SpaceSettingsSectionHeader
          marginBottomClassName="mb-2"
          title={t('members.title', { defaultValue: '成员' })}
          description={t('members.teamSpaceHint', {
            defaultValue: 'Project 只对被邀请成员可见；这里的成员不会获得 Owner 的个人执行环境。',
          })}
        />
      )}

      {canManage && (
        <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-2">
          <label className={SETTINGS_LABEL}>
            {t('members.inviteLabel', { defaultValue: '邀请 Organization 成员' })}
          </label>
          <div className="flex gap-2">
            <select
              value={selectedUserId}
              onChange={event => setSelectedUserId(event.target.value)}
              disabled={isLoading || inviteOptions.length === 0}
              className={cn(
                SETTINGS_CONTROL,
                'flex-1 rounded-md border border-input bg-background px-3 text-body text-foreground outline-none'
              )}
            >
              {inviteOptions.length === 0 ? (
                <option value="">
                  {t('members.noInviteOptions', { defaultValue: '没有可邀请成员' })}
                </option>
              ) : inviteOptions.map(member => (
                <option key={member.user_id} value={member.user_id}>
                  {displayMemberName(member.user_id)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              onClick={handleInvite}
              disabled={isLoading || !selectedUserId}
              className={SETTINGS_CONTROL_SM}
            >
              {t('members.inviteAction', { defaultValue: '邀请' })}
            </Button>
          </div>
          <p className={SETTINGS_HINT}>
            {t('members.inviteHelpPending', {
              defaultValue: '邀请发出后会出现在下方「待接受」；对方在自己的设备上接受前，不能重复邀请。',
            })}
          </p>
        </div>
      )}

      {hasLoaded && !canManage && (
        <p className={SETTINGS_HINT}>
          {t('members.ownerOnly', { defaultValue: '只有Project Owner 可以邀请或移除成员。' })}
        </p>
      )}

      <div className="space-y-2">
        {memberships.map(membership => {
          const isOwner = membership.role === 'owner'
          const isOnline = !!membership.user_id && isUserOnline(membership.user_id)
          return (
            <div
              key={membership.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/30 bg-background/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-body font-medium text-foreground">
                    {displayMemberName(membership.user_id)}
                  </span>
                  {isOnline && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-success"
                      title={t('members.online', { defaultValue: '在线' })}
                    />
                  )}
                </div>
                <div className="text-caption text-muted-foreground">
                  {isOwner
                    ? t('members.roleOwner', { defaultValue: 'Owner' })
                    : t('members.roleEditor', { defaultValue: '成员' })}
                </div>
              </div>
              {!isOwner && <span className={SETTINGS_HINT}>成员关系本期固定</span>}
            </div>
          )
        })}

        {pendingInvitations.map(invitation => (
          <div
            key={invitation.membership_id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/30 bg-background/60 px-3 py-2"
            data-testid="project-pending-invitation"
          >
            <div className="min-w-0">
              <div className="truncate text-body font-medium text-foreground">
                {invitation.user_name || displayMemberName(invitation.user_id)}
              </div>
              <div className="text-caption text-muted-foreground">
                {t('members.roleEditor', { defaultValue: '成员' })}
                {' · '}
                {t('members.pendingAccept', { defaultValue: '待接受' })}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-caption font-medium text-warning">
              {t('members.pendingAccept', { defaultValue: '待接受' })}
            </span>
          </div>
        ))}
      </div>

      {error && <p className="text-caption text-destructive">{error}</p>}
    </div>
  )

  if (!scrollable) return body
  return <ScrollArea className="flex-1">{body}</ScrollArea>
}
