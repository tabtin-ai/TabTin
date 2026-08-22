import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2 } from 'lucide-react'
import { ContextPageToolbar } from '@components/context-space/ContextPageToolbar'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import { cn } from '@utils/cn'
import { ColorAvatar } from '../ColorAvatar'
import type { IMMemberItem } from './types'
import { memberDisplayName } from './types'

const MEMBER_ROW_CLASS = cn(
  'flex w-full min-w-0 items-center gap-3 rounded-interactive px-2.5 py-2 text-left transition-colors',
)

export interface IMMemberTransferProps {
  /** 左侧候选列表（可被搜索过滤） */
  members: IMMemberItem[]
  /**
   * 右侧已选解析目录（通常传未过滤的 otherMembers）。
   * 缺省时回退 members；搜索过滤时务必传入完整目录，避免已选项从右侧消失。
   */
  memberDirectory?: IMMemberItem[]
  selectedIds: Set<string>
  onSelectionChange: (next: Set<string>) => void
  search: string
  onSearchChange: (value: string) => void
  isLoadingMembers?: boolean
  isSearching?: boolean
  /** DM 单选；群聊多选 */
  mode?: 'single' | 'multi'
  searchPlaceholder?: string
  className?: string
  /** 由固定高度父容器承载时，允许列表收缩并只滚动内部成员区域。 */
  fitAvailableHeight?: boolean
}

export const IMMemberTransfer: React.FC<IMMemberTransferProps> = ({
  members,
  memberDirectory,
  selectedIds,
  onSelectionChange,
  search,
  onSearchChange,
  isLoadingMembers = false,
  isSearching = false,
  mode = 'multi',
  searchPlaceholder,
  className,
  fitAvailableHeight = false,
}) => {
  const { t } = useTranslation('tabchat')

  const directoryById = useMemo(() => {
    const map = new Map<string, IMMemberItem>()
    for (const member of memberDirectory ?? []) {
      map.set(member.user_id, member)
    }
    for (const member of members) {
      map.set(member.user_id, member)
    }
    return map
  }, [memberDirectory, members])

  const toggleMember = (userId: string) => {
    if (mode === 'single') {
      onSelectionChange(selectedIds.has(userId) ? new Set() : new Set([userId]))
      return
    }
    const next = new Set(selectedIds)
    if (next.has(userId)) next.delete(userId)
    else next.add(userId)
    onSelectionChange(next)
  }

  const renderMemberPickerState = () => {
    if (isLoadingMembers && members.length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-body">{t('loadingMembers')}</span>
        </div>
      )
    }
    if (isSearching && members.length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-body">{t('searchingMembers')}</span>
        </div>
      )
    }
    if (members.length === 0) {
      return (
        <div className="py-8 text-center text-body text-muted-foreground">
          {t('noMembersToAdd')}
        </div>
      )
    }
    return members.map((member) => {
      const userId = member.user_id
      const name = memberDisplayName(member)
      const isSelected = selectedIds.has(userId)
      const disabled = mode === 'single' && selectedIds.size === 1 && !isSelected

      return (
        <button
          key={userId}
          type="button"
          onClick={() => toggleMember(userId)}
          disabled={disabled}
          className={cn(
            MEMBER_ROW_CLASS,
            isSelected
              ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08]'
              : disabled
                ? 'cursor-not-allowed opacity-40'
                : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
          )}
        >
          <ColorAvatar
            name={name}
            seed={userId}
            imageUrl={member.user?.avatar}
            className="h-8 w-8"
            fallbackClassName="text-caption"
          />
          <div className="min-w-0 flex-1 text-left">
            <span className="block truncate text-body text-foreground">{name}</span>
            {member.user?.email ? (
              <span className={cn('block truncate', CANVAS_TEXT_META)}>
                {member.user.email}
              </span>
            ) : null}
          </div>
          {isSelected ? <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : null}
        </button>
      )
    })
  }

  const selectedMembers = Array.from(selectedIds)
    .map((userId) => directoryById.get(userId))
    .filter((member): member is IMMemberItem => Boolean(member))
  const placeholder = searchPlaceholder ?? t('searchMembers')

  if (mode === 'single') {
    return (
      <div className={cn('flex min-h-0 flex-col gap-4', className)}>
        <ContextPageToolbar
          withHeaderGap={false}
          searchPlaceholder={placeholder}
          searchValue={search}
          onSearchChange={onSearchChange}
          searchAriaLabel={placeholder}
        />
        <div className={cn(
          'flex-1 overflow-y-auto rounded-[12px] border border-foreground/[0.08] p-1.5 scrollbar-hover dark:border-foreground/[0.12]',
          fitAvailableHeight ? 'min-h-0' : 'min-h-[240px]',
        )}>
          {renderMemberPickerState()}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-4', className)}>
      <ContextPageToolbar
        withHeaderGap={false}
        searchPlaceholder={placeholder}
        searchValue={search}
        onSearchChange={onSearchChange}
        searchAriaLabel={placeholder}
      />
      <div className={cn(
        'grid flex-1 grid-cols-2 overflow-hidden rounded-[12px] border border-foreground/[0.08] dark:border-foreground/[0.12]',
        fitAvailableHeight ? 'min-h-0' : 'min-h-[320px]',
      )}>
        <div className="flex min-h-0 flex-col border-r border-foreground/[0.08] dark:border-foreground/[0.12]">
          <div className="shrink-0 border-b border-foreground/[0.06] px-3 py-2.5 dark:border-foreground/[0.08]">
            <span className="text-body font-medium text-foreground">{t('selectMembers')}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-hover">
            {renderMemberPickerState()}
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="shrink-0 border-b border-foreground/[0.06] px-3 py-2.5 dark:border-foreground/[0.08]">
            <span className="text-body font-medium text-foreground">
              {t('selectedMembers', { count: selectedIds.size })}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-hover">
            {selectedIds.size === 0 ? (
              <p className={cn('px-2 py-6 text-center', CANVAS_TEXT_META)}>
                {t('noMembersSelected')}
              </p>
            ) : (
              selectedMembers.map((member) => {
                const name = memberDisplayName(member)
                return (
                  <button
                    key={member.user_id}
                    type="button"
                    onClick={() => toggleMember(member.user_id)}
                    className={cn(MEMBER_ROW_CLASS, 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]')}
                    aria-label={t('removeSelectedMember', { name })}
                  >
                    <ColorAvatar
                      name={name}
                      seed={member.user_id}
                      imageUrl={member.user?.avatar}
                      className="h-8 w-8"
                      fallbackClassName="text-caption"
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-foreground">{name}</span>
                    <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
