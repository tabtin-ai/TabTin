/**
 * CollaboratorsSection — ShareDialog 顶部"邀请协作者"段。
 *
 * 内容：
 * 1. Owner 单独一行（PRD D9），不可移除/不可改权限
 * 2. canManage=true 时：成员搜索框 + 权限下拉 + 邀请按钮
 *    - 搜索结果前端过滤掉 owner / 已是协作者的人
 * 3. 当前协作者列表（每行 avatar / nickname / 权限下拉 / 移除按钮）
 *    - canManage=false 时只读
 * 4. partial failure：根据 invite 返回的 skipped 数组，按 reason 在 toast 中展示
 */

import * as React from 'react'
import { Check, Search, UserPlus, X, Loader2 } from 'lucide-react'
import { Button } from '../components/button'
import { Input } from '../components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/select'
import { toast } from '../components/toast/use-toast'
import { UserAvatar } from '../components/common/user-avatar'
import { Popover, PopoverContent, PopoverAnchor } from '../components/popover'
import { ConfirmDialog } from '../components/confirm-dialog'
import { useCollaborators } from './hooks/useCollaborators'
import { useMemberSearch } from './hooks/useMemberSearch'
import type {
  CollaboratorPermission,
  ResourceType,
  SearchedUser,
  SkippedItem,
  UserBrief,
} from './types'

interface Props {
  resourceType: ResourceType
  resourceId: string
  organizationId: string
  canManage: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}

const COLLAB_PERMISSION_OPTIONS: CollaboratorPermission[] = ['viewer', 'editor', 'admin']
export const DEFAULT_COLLABORATOR_PERMISSION: CollaboratorPermission = 'viewer'
export const MAX_COLLABORATOR_INVITE_COUNT = 50

export function summarizeSelectedUsers(users: SearchedUser[]): string {
  const names = users
    .slice(0, 3)
    .map((user) => user.nickname || (user.username ? `@${user.username}` : user.id))
  const remaining = users.length - names.length
  return remaining > 0 ? `${names.join('、')}，另 ${remaining} 人` : names.join('、')
}

function reasonI18nKey(reason: string): string {
  switch (reason) {
    case 'not_in_organization':
      return 'share.dialog.skipped.notInOrganization'
    case 'is_owner':
      return 'share.dialog.skipped.isOwner'
    case 'self':
      return 'share.dialog.skipped.self'
    default:
      return 'share.dialog.skipped.notInOrganization'
  }
}

export const CollaboratorsSection: React.FC<Props> = ({
  resourceType,
  resourceId,
  organizationId,
  canManage,
  t,
}) => {
  const {
    owner,
    collaborators,
    loading: listLoading,
    error: listError,
    reload,
    invite,
    updatePermission,
    remove,
  } = useCollaborators(resourceType, resourceId)

  const [query, setQuery] = React.useState('')
  const [selectedUsers, setSelectedUsers] = React.useState<SearchedUser[]>([])
  const [permission, setPermission] = React.useState<CollaboratorPermission>(
    DEFAULT_COLLABORATOR_PERMISSION,
  )
  const [inviting, setInviting] = React.useState(false)
  const [showResults, setShowResults] = React.useState(false)
  const [pendingRemove, setPendingRemove] = React.useState<
    { userId: string; nickname: string } | null
  >(null)
  const anchorRef = React.useRef<HTMLDivElement | null>(null)
  const isFileShare = resourceType === 'file'
  const supportsBulkSelection = resourceType !== 'file'

  const {
    results: searchResults,
    loading: searchLoading,
    loadingMore: searchLoadingMore,
    hasMore: searchHasMore,
    loadMore: loadMoreMembers,
  } = useMemberSearch(organizationId, query, showResults && canManage)

  // 前端过滤掉 owner / 已是协作者的人
  const existingIds = React.useMemo(() => {
    const ids = new Set<string>()
    if (owner?.user_id) ids.add(owner.user_id)
    for (const c of collaborators) {
      if (c.user_id) ids.add(c.user_id)
    }
    return ids
  }, [owner, collaborators])

  const filteredResults = React.useMemo(
    () => searchResults.filter((u) => !existingIds.has(u.id)),
    [searchResults, existingIds],
  )

  const selectedIds = React.useMemo(
    () => new Set(selectedUsers.map((user) => user.id)),
    [selectedUsers],
  )

  React.useEffect(() => {
    setQuery('')
    setSelectedUsers([])
    setPermission(DEFAULT_COLLABORATOR_PERMISSION)
    setShowResults(false)
  }, [organizationId, resourceId, resourceType])

  React.useEffect(() => {
    setSelectedUsers((current) => {
      const next = current.filter((user) => !existingIds.has(user.id))
      return next.length === current.length ? current : next
    })
  }, [existingIds])

  const handlePickUser = React.useCallback((u: SearchedUser) => {
    if (!supportsBulkSelection) {
      setSelectedUsers([u])
      setQuery(u.nickname || (u.username ? `@${u.username}` : u.id))
      setShowResults(false)
      return
    }

    if (selectedIds.has(u.id)) {
      setSelectedUsers((current) => current.filter((user) => user.id !== u.id))
      return
    }
    if (selectedUsers.length >= MAX_COLLABORATOR_INVITE_COUNT) {
      toast({
        title: t('share.dialog.collaborators.selectionLimit', {
          defaultValue: '一次最多选择 50 位成员',
        }),
        description: t('share.dialog.collaborators.selectionLimitHint', {
          defaultValue: '请先邀请已选成员，再继续选择其他成员。',
        }),
        variant: 'destructive',
      })
      return
    }
    setSelectedUsers((current) => [...current, u])
  }, [selectedIds, selectedUsers.length, supportsBulkSelection, t])

  const handleSelectCurrentResults = React.useCallback(() => {
    const unselected = filteredResults.filter((user) => !selectedIds.has(user.id))
    if (unselected.length === 0) return

    const available = MAX_COLLABORATOR_INVITE_COUNT - selectedUsers.length
    const additions = unselected.slice(0, Math.max(available, 0))
    setSelectedUsers((current) => [...current, ...additions])

    if (additions.length < unselected.length) {
      toast({
        title: t('share.dialog.collaborators.selectionLimit', {
          defaultValue: '一次最多选择 50 位成员',
        }),
        description: t('share.dialog.collaborators.selectionLimitReached', {
          defaultValue:
            additions.length > 0
              ? '当前结果超过上限，已选择前 {{count}} 位；请先完成本次邀请。'
              : '已达到 50 人上限；请先完成本次邀请。',
          count: additions.length,
        }),
        variant: 'destructive',
      })
    }
  }, [filteredResults, selectedIds, selectedUsers.length, t])

  const handleRemoveSelected = React.useCallback((userId: string) => {
    setSelectedUsers((current) => current.filter((user) => user.id !== userId))
  }, [])

  const handleResultsScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) return
      loadMoreMembers()
    },
    [loadMoreMembers],
  )

  const handleInvite = React.useCallback(async () => {
    if (selectedUsers.length === 0) {
      // 没选用户：尝试用第一条结果
      if (!supportsBulkSelection && filteredResults.length > 0) {
        setSelectedUsers([filteredResults[0]])
        return
      }
      toast({ title: t('share.dialog.collaborators.noSelection', { defaultValue: '请先选择成员' }) })
      return
    }
    setInviting(true)
    try {
      const result = await invite(
        selectedUsers.map((user) => user.id),
        isFileShare ? DEFAULT_COLLABORATOR_PERMISSION : permission,
      )
      if (result.notified > 0) {
        toast({
          title: t(isFileShare
            ? 'share.dialog.collaborators.fileShareSuccess'
            : 'share.dialog.collaborators.inviteSuccess', {
            defaultValue: isFileShare ? '已分享给 {{count}} 位成员' : '已邀请 {{count}} 位协作者',
            count: result.notified,
          }),
        })
      }
      if (result.skipped.length > 0) {
        // 按 reason 分组展示
        const groups = new Map<string, SkippedItem[]>()
        for (const item of result.skipped) {
          const key = reasonI18nKey(item.reason)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(item)
        }
        const messages: string[] = []
        for (const [key, items] of groups) {
          messages.push(`${t(key, { defaultValue: key })}（${items.length}）`)
        }
        toast({
          title: t('share.dialog.collaborators.invitePartial', { defaultValue: '部分邀请未成功' }),
          description: messages.join('；'),
          variant: 'destructive',
        })
      }
      setSelectedUsers([])
      setQuery('')
      setShowResults(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast({
        title: t('share.dialog.collaborators.inviteFailed', { defaultValue: '邀请失败' }),
        description: msg,
        variant: 'destructive',
      })
    } finally {
      setInviting(false)
    }
  }, [filteredResults, invite, isFileShare, permission, selectedUsers, supportsBulkSelection, t])

  const handleUpdatePermission = React.useCallback(
    async (userId: string, newPermission: CollaboratorPermission) => {
      try {
        await updatePermission(userId, newPermission)
        toast({
          title: t('share.dialog.collaborators.permissionUpdated', { defaultValue: '权限已更新' }),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast({
          title: t('share.dialog.collaborators.permissionUpdateFailed', { defaultValue: '权限更新失败' }),
          description: msg,
          variant: 'destructive',
        })
      }
    },
    [updatePermission, t],
  )

  const handleRequestRemove = React.useCallback((userId: string, nickname: string) => {
    setPendingRemove({ userId, nickname })
  }, [])

  const handleConfirmRemove = React.useCallback(async () => {
    if (!pendingRemove) return
    try {
      await remove(pendingRemove.userId)
      toast({
        title: t(isFileShare
          ? 'share.dialog.collaborators.fileRemoveSuccess'
          : 'share.dialog.collaborators.removeSuccess', {
          defaultValue: isFileShare ? '已取消文件分享' : '已移除协作者',
        }),
      })
      setPendingRemove(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast({
        title: t('share.dialog.collaborators.removeFailed', { defaultValue: '移除失败' }),
        description: msg,
        variant: 'destructive',
      })
    }
  }, [isFileShare, pendingRemove, remove, t])

  const permissionLabel = React.useCallback(
    (p: string) => t(`share.dialog.permission.${p}`, { defaultValue: p }),
    [t],
  )

  const sectionTitle = isFileShare
    ? t('share.dialog.collaborators.fileSection', { defaultValue: '分享文件' })
    : canManage
      ? t('share.dialog.collaborators.section', { defaultValue: '邀请协作者' })
      : t('share.dialog.collaborators.sectionReadOnly', { defaultValue: '协作者' })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-body font-medium">{sectionTitle}</h3>
      </div>

      {/* 邀请输入区（仅 canManage） */}
      {canManage && (
        <div ref={anchorRef} className="space-y-2">
          <div className="flex items-center gap-2">
            <Popover
              open={showResults && canManage}
              onOpenChange={(open) => {
                if (!open) setShowResults(false)
              }}
            >
              <PopoverAnchor asChild>
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      if (!supportsBulkSelection) setSelectedUsers([])
                      setShowResults(true)
                    }}
                    onFocus={() => setShowResults(true)}
                    onClick={() => setShowResults(true)}
                    placeholder={t('share.dialog.collaborators.search', {
                      defaultValue: '搜索或浏览同事…',
                    })}
                    className="pl-8 h-9"
                  />
                  {searchLoading && (
                    <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                  )}
                </div>
              </PopoverAnchor>
              <PopoverContent
                className="max-h-60 overflow-y-auto p-1 w-[var(--radix-popover-trigger-width)]"
                align="start"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onScroll={handleResultsScroll}
              >
                {searchLoading && filteredResults.length === 0 && (
                  <div className="flex items-center justify-center gap-1.5 px-3 py-3 text-caption text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('share.dialog.collaborators.loading', { defaultValue: '加载成员…' })}
                  </div>
                )}
                {filteredResults.length === 0 && !searchLoading && (
                  <div className="px-3 py-2 text-body text-muted-foreground">
                    {t('share.dialog.collaborators.noResults', { defaultValue: '没有匹配的成员' })}
                  </div>
                )}
                {supportsBulkSelection && filteredResults.length > 0 && (
                  <div className="flex items-center justify-between gap-2 border-b border-border/50 px-2 py-1.5">
                    <span className="text-caption text-muted-foreground">
                      {t('share.dialog.collaborators.loadedCandidates', {
                        defaultValue: '当前已加载 {{count}} 位候选成员',
                        count: filteredResults.length,
                      })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-caption"
                      onClick={handleSelectCurrentResults}
                      disabled={filteredResults.every((user) => selectedIds.has(user.id))}
                    >
                      {filteredResults.every((user) => selectedIds.has(user.id))
                        ? t('share.dialog.collaborators.currentResultsSelected', {
                            defaultValue: '当前结果已选',
                          })
                        : t('share.dialog.collaborators.selectCurrentResults', {
                            defaultValue: '全选当前结果',
                          })}
                    </Button>
                  </div>
                )}
                {filteredResults.map((u) => {
                  const displayName = u.nickname || (u.username ? `@${u.username}` : u.id)
                  const dedupHint = u.nickname && u.username ? `@${u.username}` : ''
                  const selected = selectedIds.has(u.id)
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => handlePickUser(u)}
                      aria-pressed={supportsBulkSelection ? selected : undefined}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    >
                      <UserAvatar name={displayName} seed={u.id} avatarUrl={u.avatar} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body font-medium">{displayName}</div>
                        {dedupHint && (
                          <div className="truncate text-caption text-muted-foreground">{dedupHint}</div>
                        )}
                      </div>
                      {supportsBulkSelection && (
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                          }`}
                          aria-hidden="true"
                        >
                          {selected && <Check className="h-3 w-3" />}
                        </span>
                      )}
                    </button>
                  )
                })}
                {(searchLoadingMore || (searchHasMore && filteredResults.length > 0)) && (
                  <div className="flex items-center justify-center gap-1.5 px-3 py-2 text-caption text-muted-foreground">
                    {searchLoadingMore ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t('share.dialog.collaborators.loadingMore', { defaultValue: '加载更多…' })}
                      </>
                    ) : (
                      t('share.dialog.collaborators.scrollForMore', { defaultValue: '向下滚动加载更多' })
                    )}
                  </div>
                )}
                {supportsBulkSelection && searchHasMore && (
                  <div className="border-t border-border/50 px-3 py-2 text-caption text-muted-foreground">
                    {t('share.dialog.collaborators.loadedResultsOnly', {
                      defaultValue: '全选仅作用于当前已加载结果；继续向下滚动可加载更多成员。',
                    })}
                  </div>
                )}
              </PopoverContent>
            </Popover>

            {isFileShare ? (
              <span className="flex h-9 w-[110px] flex-none items-center justify-center rounded-md border border-border bg-muted/30 px-3 text-caption text-muted-foreground">
                {t('share.dialog.collaborators.filePermission', { defaultValue: '查看和下载' })}
              </span>
            ) : (
              <Select
                value={permission}
                onValueChange={(v) => setPermission(v as CollaboratorPermission)}
              >
                <SelectTrigger className="h-9 w-[110px] flex-none">
                  <SelectValue placeholder={permissionLabel(permission)} />
                </SelectTrigger>
                <SelectContent>
                  {COLLAB_PERMISSION_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {permissionLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Button
              size="sm"
              onClick={() => void handleInvite()}
              disabled={selectedUsers.length === 0 || inviting}
              className="h-9 gap-1.5 flex-none"
            >
              {inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              {isFileShare
                ? t('share.dialog.collaborators.fileShareAction', { defaultValue: '分享' })
                : t('share.dialog.collaborators.invite', { defaultValue: '邀请' })}
            </Button>
          </div>

          {isFileShare && (
            <p className="text-caption leading-relaxed text-muted-foreground">
              {t('share.dialog.collaborators.filePermissionHint', {
                defaultValue: '接收者只能查看和下载该文件，不能编辑、移动、删除或再次分享。',
              })}
            </p>
          )}

          {supportsBulkSelection && selectedUsers.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 text-caption">
                <span className="min-w-0 truncate font-medium">
                  {t('share.dialog.collaborators.selectedSummary', {
                    defaultValue: '已选：{{summary}}',
                    summary: summarizeSelectedUsers(selectedUsers),
                  })}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {selectedUsers.length}/{MAX_COLLABORATOR_INVITE_COUNT}
                </span>
              </div>
              <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
                {selectedUsers.map((user) => {
                  const displayName = user.nickname || (user.username ? `@${user.username}` : user.id)
                  return (
                    <span
                      key={user.id}
                      className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-1 text-caption"
                    >
                      <span className="max-w-32 truncate">{displayName}</span>
                      <button
                        type="button"
                        className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => handleRemoveSelected(user.id)}
                        aria-label={t('share.dialog.collaborators.removeSelected', {
                          defaultValue: '取消选择 {{name}}',
                          name: displayName,
                        })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {supportsBulkSelection && (
            <p className="text-caption leading-relaxed text-muted-foreground">
              {t('share.dialog.collaborators.currentMembersOnlyHint', {
                defaultValue: '仅邀请本次选择的当前成员；新加入组织的成员不会自动获得权限。',
              })}
            </p>
          )}
        </div>
      )}

      {!canManage && (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-caption text-muted-foreground">
          {t('share.dialog.readOnlyHint', {
            defaultValue: '你的权限不足以邀请或修改协作者；以下为只读视图。',
          })}
        </div>
      )}

      {/* 列表：owner 单独 + 现有协作者 */}
      {listError ? (
        <div className="flex items-center justify-between rounded-md bg-destructive/10 px-3 py-2 text-body text-destructive">
          <span>{t('share.dialog.collaborators.loadFailed', { defaultValue: '加载协作者失败' })}</span>
          <Button variant="ghost" size="sm" onClick={() => void reload()} className="h-7 text-destructive hover:bg-destructive/20">
            {t('share.dialog.retry', { defaultValue: '重试' })}
          </Button>
        </div>
      ) : listLoading ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <div className="space-y-1">
          {owner && <OwnerRow owner={owner} t={t} />}
          {collaborators.length === 0 ? (
            <div className="px-3 py-3 text-body text-muted-foreground">
              {isFileShare
                ? t('share.dialog.collaborators.fileEmpty', { defaultValue: '还没有分享给任何人' })
                : t('share.dialog.collaborators.empty', { defaultValue: '还没有协作者' })}
            </div>
          ) : (
            collaborators.map((c) => (
              <CollaboratorRow
                key={c.user_id}
                user={c}
                canManage={canManage}
                isFileShare={isFileShare}
                onChangePermission={(p) => void handleUpdatePermission(c.user_id, p as CollaboratorPermission)}
                onRemove={() => handleRequestRemove(c.user_id, c.nickname || c.user_id)}
                permissionLabel={permissionLabel}
                t={t}
              />
            ))
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => { if (!open) setPendingRemove(null) }}
        title={t(isFileShare
          ? 'share.dialog.collaborators.fileConfirmRemoveTitle'
          : 'share.dialog.collaborators.confirmRemoveTitle', {
          defaultValue: isFileShare ? '取消文件分享' : '移除协作者',
        })}
        description={t(isFileShare
          ? 'share.dialog.collaborators.fileConfirmRemove'
          : 'share.dialog.collaborators.confirmRemove', {
          defaultValue: isFileShare
            ? '确定要取消对 {{name}} 的文件分享吗？'
            : '确定要将 {{name}} 从协作者中移除吗？',
          name: pendingRemove?.nickname ?? '',
        })}
        variant="destructive"
        confirmText={t('share.dialog.collaborators.remove', { defaultValue: '移除' })}
        cancelText={t('share.dialog.cancel', { defaultValue: '取消' })}
        onConfirm={handleConfirmRemove}
      />
    </div>
  )
}

interface OwnerRowProps {
  owner: UserBrief
  t: (key: string, opts?: Record<string, unknown>) => string
}

const OwnerRow: React.FC<OwnerRowProps> = ({ owner, t }) => {
  const displayName = owner.nickname || owner.user_id
  return (
    <div className="flex items-center gap-3 rounded-md bg-muted/40 px-3 py-2">
      <UserAvatar name={displayName} seed={owner.user_id} avatarUrl={owner.avatar} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium">{displayName}</span>
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-caption font-medium text-primary">
            {t('share.dialog.collaborators.ownerBadge', { defaultValue: '所有者' })}
          </span>
        </div>
      </div>
    </div>
  )
}

interface CollaboratorRowProps {
  user: { user_id: string; nickname: string; avatar?: string | null; permission: string }
  canManage: boolean
  isFileShare: boolean
  onChangePermission: (p: string) => void
  onRemove: () => void
  permissionLabel: (p: string) => string
  t: (key: string, opts?: Record<string, unknown>) => string
}

const CollaboratorRow: React.FC<CollaboratorRowProps> = ({
  user,
  canManage,
  isFileShare,
  onChangePermission,
  onRemove,
  permissionLabel,
  t,
}) => {
  const displayName = user.nickname || user.user_id
  return (
    <div className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 rounded-md">
      <UserAvatar name={displayName} seed={user.user_id} avatarUrl={user.avatar} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body">{displayName}</div>
      </div>
      {canManage ? (
        <>
          {isFileShare ? (
            <span className="w-[110px] flex-none text-center text-caption text-muted-foreground">
              {t('share.dialog.collaborators.filePermission', { defaultValue: '查看和下载' })}
            </span>
          ) : (
            <Select value={user.permission} onValueChange={onChangePermission}>
              <SelectTrigger className="h-8 w-[110px] flex-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLLAB_PERMISSION_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {permissionLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            className="h-8 w-8 flex-none p-0 text-muted-foreground hover:text-destructive"
            title={t('share.dialog.collaborators.remove', { defaultValue: '移除' })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : (
        <span className="text-caption text-muted-foreground flex-none">
          {isFileShare
            ? t('share.dialog.collaborators.filePermission', { defaultValue: '查看和下载' })
            : permissionLabel(user.permission)}
        </span>
      )}
    </div>
  )
}
