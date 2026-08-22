import React, { useEffect, useRef, useState } from 'react'
import { Building2, CheckCheck, ChevronRight, Copy, CreditCard, LogOut, Pencil } from 'lucide-react'
import type { ReactElement } from 'react'
import { Button, ConfirmDialog, Input, StatusNotice, Textarea, toast } from '@components/ui'
import type { Organization } from '@tabtin/app-shell'
import { useShallow } from 'zustand/react/shallow'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsNameConfirmDialog } from '../SettingsNameConfirmDialog'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsRow } from '../SettingsRow'
import { SETTINGS_CARD_TITLE, SETTINGS_CONTROL, SETTINGS_CONTROL_SM, SETTINGS_HINT, SETTINGS_LABEL, SETTINGS_TEXTAREA, SETTINGS_TEXT_META_BASE } from '../settingsUi'
import { canManageOrganization as canManageOrganizationFn } from '@/hooks/useCanManageOrganization'
import { OrganizationOwnershipTransferDialog } from './OrganizationOwnershipTransferDialog'
import { OrganizationCashRechargePanel } from './OrganizationCashRechargePanel'
import {
  OrganizationAvatarUploader,
  OrganizationIdentityAvatar,
  logoSettingsFromDraft,
  resolveOrgLogoDraftPreview,
  type OrgLogoDraft,
} from './OrganizationAvatarUploader'

interface OrganizationSettingsPanelProps {
  organization: Organization
  /** 嵌入模式：由外层「团队资料」页提供整页布局与页眉，这里只渲染主体。 */
  embedded?: boolean
  /** 插入到「团队资料」主体与「危险操作」之间的内容（如会员与点券分区）。 */
  children?: React.ReactNode
}

const normalizeString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/** 组织 ID 只读行：与个人资料的「用户 ID」一致，可一键复制。 */
function OrganizationIdRow({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(organizationId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard not available */
    }
  }

  return (
    <SettingsRow
      label={t('settings.fields.organizationId', { defaultValue: '组织 ID' })}
      labelClassName={SETTINGS_CARD_TITLE}
      control={(
        <div className="flex min-w-0 items-center gap-2">
          <code className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'truncate rounded bg-background/80 px-1.5 py-0.5 font-mono select-all')}>
            {organizationId}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(SETTINGS_HINT, 'flex shrink-0 items-center rounded-interactive px-1.5 py-0.5 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]')}
            title={t('settings.actions.copyId', { defaultValue: '复制 ID' })}
            aria-label={t('settings.actions.copyId', { defaultValue: '复制 ID' })}
          >
            {copied ? (
              <CheckCheck className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      )}
      controlClassName="min-w-0 sm:max-w-[28rem]"
    />
  )
}

function OrganizationEditEntryRow({
  label,
  onClick,
  disabled = false,
  destructive = false,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors',
        'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      <span
        className={cn(
          'text-body font-medium',
          destructive ? 'text-destructive/90' : 'text-foreground',
        )}
      >
        {label}
      </span>
      <ChevronRight
        className={cn(
          'h-4 w-4 shrink-0',
          destructive ? 'text-destructive/60' : 'text-muted-foreground/50',
        )}
      />
    </button>
  )
}

export const OrganizationSettingsPanel: React.FC<OrganizationSettingsPanelProps> = ({ organization, embedded = false, children }) => {
  // 必须以 settings 为默认 ns。原先 `['organization','settings']` 下带中文 defaultValue 的
  // `t('settings.xxx')` 会在 organization 未命中后直接回落 defaultValue，不再查 settings。
  const { t } = useTranslation('settings')
  const {
    updateOrganization,
    deleteOrganization,
    leaveOrganization,
    transferOwnership,
    loadOrganizations,
    loadMembers,
    members,
    isLoadingMembers,
    isMutating,
    isLoading,
    currentUserRole,
  } = useOrganizationStore(
    useShallow((s) => ({
      updateOrganization: s.updateOrganization,
      deleteOrganization: s.deleteOrganization,
      leaveOrganization: s.leaveOrganization,
      transferOwnership: s.transferOwnership,
      loadOrganizations: s.loadOrganizations,
      loadMembers: s.loadMembers,
      members: s.members,
      isLoadingMembers: s.isLoadingMembers,
      isMutating: s.isMutating,
      isLoading: s.isLoading,
      currentUserRole: s.currentUserRole,
    }))
  )
  const user = useAuthStore((s) => s.user)

  const rawOrganizationName = normalizeString(organization.name, '').trim()
  const organizationName = rawOrganizationName || t('organization.untitled')
  const organizationDescription = normalizeString(organization.description, '')
  const [name, setName] = useState(rawOrganizationName)
  const [description, setDescription] = useState(organizationDescription)
  const [formError, setFormError] = useState('')
  const [dangerError, setDangerError] = useState('')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteInputValue, setDeleteInputValue] = useState('')
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)
  const [transferError, setTransferError] = useState('')
  // 团队资料默认只读展示，点「编辑资料」才进入编辑态（与个人资料一致，不再一进来就是表单）。
  const [isEditing, setIsEditing] = useState(false)
  const [logoDraft, setLogoDraft] = useState<OrgLogoDraft | null>(null)
  const [showCashRecharge, setShowCashRecharge] = useState(false)
  const lastOrganizationIdRef = useRef(organization.id)
  const transferInFlightRef = useRef(false)

  const isOwner = user?.id === organization.owner_id
  const isDefault = organization.is_default
  const isPersonal = organization.type === 'personal'
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' as const : null)
  const canManageOrganization = canManageOrganizationFn(effectiveRole)
  const savedLogoUrl = typeof organization.settings?.logo_url === 'string'
    ? organization.settings.logo_url
    : undefined
  const previewLogoUrl = resolveOrgLogoDraftPreview(logoDraft, savedLogoUrl)

  useEffect(() => {
    if (!isOwner) return
    try {
      if (sessionStorage.getItem('settings-open-cash-recharge') !== '1') return
      sessionStorage.removeItem('settings-open-cash-recharge')
      setShowCashRecharge(true)
    } catch {
      // ignore
    }
  }, [isOwner, organization.id])

  useEffect(() => {
    const switchedOrganization = lastOrganizationIdRef.current !== organization.id
    lastOrganizationIdRef.current = organization.id
    setFormError('')
    if (switchedOrganization) {
      setName(rawOrganizationName)
      setDescription(organizationDescription)
      setLogoDraft(null)
      setDangerError('')
      setDeleteDialogOpen(false)
      setDeleteInputValue('')
      setLeaveConfirmOpen(false)
      setTransferDialogOpen(false)
      setTransferError('')
      setIsEditing(false)
      setShowCashRecharge(false)
      return
    }
    // 只读态始终跟 props（含 organization.updated WS）；编辑中才保留本地草稿。
    if (!isEditing) {
      setName(rawOrganizationName)
      setDescription(organizationDescription)
    }
  }, [isEditing, rawOrganizationName, organizationDescription, organization.id])

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError('')
    if (!name.trim()) {
      setFormError(t('settings.validation.nameRequired'))
      return
    }
    try {
      // settings 整包替换：改 logo 时必须带上现有键，避免清掉 allow_member_yolo 等。
      await updateOrganization(organization.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        ...logoSettingsFromDraft(logoDraft, organization.settings),
      })
      toast({ title: t('settings.actions.saved') })
      setLogoDraft(null)
      setIsEditing(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (
        message.includes('ORGANIZATION_NAME_CONFLICT') ||
        message.includes('已存在同名组织') ||
        /organization with this name already exists/i.test(message)
      ) {
        setFormError(t('settings.errors.nameConflict'))
      } else {
        setFormError(message || t('settings.errors.updateFailed'))
      }
    }
  }

  const handleCancelEdit = () => {
    setName(rawOrganizationName)
    setDescription(organizationDescription)
    setLogoDraft(null)
    setFormError('')
    setIsEditing(false)
  }

  const handleTransferOwnership = async (newOwnerUserId: string) => {
    if (transferInFlightRef.current) return
    transferInFlightRef.current = true
    setTransferError('')
    try {
      await transferOwnership(organization.id, newOwnerUserId)
      toast({ title: t('organization.transferSuccess') })
      setTransferDialogOpen(false)
      void Promise.all([
        loadOrganizations(),
        loadMembers(organization.id),
      ])
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : t('organization.transferFailed'))
    } finally {
      transferInFlightRef.current = false
    }
  }

  const handleDelete = async () => {
    setDangerError('')
    if (deleteInputValue !== organizationName) {
      const mismatchError = t('settings.validation.nameMismatch')
      setDangerError(mismatchError)
      throw new Error(mismatchError)
    }
    try {
      await deleteOrganization(organization.id)
      toast({
        title: t('settings.actions.deleteSuccess', { name: organizationName }),
        variant: 'destructive',
        duration: 8000,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('settings.errors.deleteFailed')
      setDangerError(message)
      throw new Error(message)
    }
  }

  const handleLeave = async () => {
    setDangerError('')
    try {
      await leaveOrganization(organization.id)
      toast({ title: t('settings.actions.leaveSuccess') })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('settings.errors.leaveFailed')
      setDangerError(message)
      throw new Error(message)
    }
  }

  // ：组织准入天花板已移至「AI 服务开关」页（OrganizationMemberYoloSetting）。

  const isDirty = name !== rawOrganizationName ||
    description !== organizationDescription ||
    logoDraft !== null

  useEffect(() => {
    const unregister = useSettingsSpaceStore.getState().registerDirtyChecker(() => isDirty)
    return unregister
  }, [isDirty])

  if (showCashRecharge && isOwner) {
    const rechargeBody = (
      <OrganizationCashRechargePanel
        organization={organization}
        onBack={() => setShowCashRecharge(false)}
      />
    )
    if (embedded) return rechargeBody
    return (
      <SettingsPanelLayout>
        <SettingsPanelHeader
          icon={<CreditCard className="h-4 w-4" />}
          title={t('billing.cashWallet.recharge.title')}
          subtitle={organizationName}
        />
        {rechargeBody}
      </SettingsPanelLayout>
    )
  }

  const body = (
    <>
      <div className="space-y-6">
      {isEditing ? (
      <form onSubmit={handleUpdate}>
        <SettingsSectionCard bodyClassName="space-y-4">
        <OrganizationAvatarUploader
          organizationId={organization.id}
          organizationName={name || organization.name}
          canManage={canManageOrganization}
          currentLogo={previewLogoUrl}
          disabled={isLoading}
          onLogoUploaded={(url) => setLogoDraft({ type: 'set', url })}
          onLogoRemoved={() => setLogoDraft({ type: 'clear' })}
        />

        {/* 名称 */}
        <div className="space-y-1">
          <label className={SETTINGS_LABEL}>
            {t('settings.fields.name')} <span className="text-destructive/80">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('settings.fields.namePlaceholder')}
            maxLength={100}
            disabled={!canManageOrganization || isLoading}
            className={cn('w-full', SETTINGS_CONTROL)}
          />
          <p className={SETTINGS_HINT}>
            {t('settings.fields.nameHint', { count: name.length })}
          </p>
        </div>

        {/* 描述 */}
        <div className="space-y-1">
          <label className={SETTINGS_LABEL}>{t('settings.fields.description')}</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('settings.fields.descriptionPlaceholder')}
            maxLength={500}
            rows={3}
            disabled={!canManageOrganization || isLoading}
            className={cn(
              'w-full resize-none',
              SETTINGS_TEXTAREA
            )}
          />
          <p className={SETTINGS_HINT}>
            {t('settings.fields.descriptionHint', { count: description.length })}
          </p>
        </div>

        {isOwner && !isPersonal ? (
          <div className="overflow-hidden rounded-interactive border border-border/20 divide-y divide-border/20">
            <OrganizationEditEntryRow
              label={t('settings.danger.transferTitle')}
              onClick={() => {
                setTransferError('')
                setTransferDialogOpen(true)
                void loadMembers(organization.id)
              }}
              disabled={isLoading}
            />
            <OrganizationEditEntryRow
              label={t('settings.danger.deleteTitle')}
              onClick={() => {
                setDangerError('')
                setDeleteInputValue('')
                setDeleteDialogOpen(true)
              }}
              disabled={isDefault || isLoading}
              destructive
            />
          </div>
        ) : null}

        {!canManageOrganization && (
          <p className={SETTINGS_HINT}>
            {t('settings.permissions.ownerOnly')}
          </p>
        )}

        {formError ? <StatusNotice tone="danger" size="sm" description={formError} /> : null}
        {dangerError && isEditing ? (
          <p className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{dangerError}</p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancelEdit}
            disabled={isLoading}
            className={SETTINGS_CONTROL_SM}
          >
            {t('settings.actions.cancel')}
          </Button>
          {canManageOrganization && (
            <Button
              type="submit"
              size="sm"
              disabled={isLoading || !name.trim() || !isDirty}
              className={cn(SETTINGS_CONTROL, 'transition-opacity', !isDirty && 'opacity-40')}
            >
              {isLoading ? t('settings.actions.saving') : t('settings.actions.save')}
            </Button>
          )}
        </div>
        </SettingsSectionCard>
      </form>
      ) : (
        <SettingsSectionCard>
          <div className="flex items-start gap-4">
            {previewLogoUrl ? (
              <img
                src={previewLogoUrl}
                alt=""
                className="h-14 w-14 shrink-0 rounded-interactive object-cover bg-muted/30"
              />
            ) : (
              <OrganizationIdentityAvatar
                name={organizationName}
                seed={organization.id}
                size={56}
                className="shrink-0 !rounded-[8px]"
              />
            )}
            <div className="min-w-0 flex-1 pt-0.5">
              <h2 className="truncate text-title font-semibold text-foreground">
                {organizationName}
              </h2>
              {organizationDescription.trim() ? (
                <p className={cn(SETTINGS_HINT, 'mt-1 line-clamp-3 whitespace-pre-wrap break-words')}>
                  {organizationDescription.trim()}
                </p>
              ) : null}
            </div>
            {canManageOrganization && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditing(true)}
                className={cn('shrink-0 gap-1.5 text-muted-foreground/60 hover:text-foreground', SETTINGS_CONTROL_SM)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t('settings.actions.edit', { defaultValue: '编辑资料' })}
              </Button>
            )}
          </div>

          <div className="mt-4 border-t border-border/30 pt-2">
            <OrganizationIdRow organizationId={organization.id} />
            {!isOwner && !isPersonal ? (
              <div className="mt-2 border-t border-border/20 pt-3">
                <SettingsRow
                  label={t('settings.danger.leaveTitle')}
                  control={(
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDangerError('')
                        setLeaveConfirmOpen(true)
                      }}
                      disabled={isLoading}
                      className={cn(
                        'gap-1.5 text-destructive/80 hover:bg-destructive/5 hover:text-destructive',
                        SETTINGS_CONTROL_SM,
                      )}
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      {t('settings.actions.leave')}
                    </Button>
                  )}
                />
              </div>
            ) : null}
          </div>
        </SettingsSectionCard>
      )}

      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child
        return React.cloneElement(child as ReactElement<{ isOwner?: boolean; onOpenCashRecharge?: () => void }>, {
          isOwner,
          onOpenCashRecharge: isOwner ? () => setShowCashRecharge(true) : undefined,
        })
      })}
      </div>

      <SettingsNameConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open)
          if (!open) {
            setDeleteInputValue('')
            setDangerError('')
          }
        }}
        title={t('settings.confirm.title')}
        subtitle={t('settings.confirm.subtitle')}
        items={[
          t('settings.confirm.items.organization', { name: organizationName }),
          t('settings.confirm.items.spaces'),
          t('settings.confirm.items.records'),
          t('settings.confirm.items.members'),
          t('settings.confirm.items.userPortrait'),
        ]}
        warning={t('settings.confirm.warning')}
        inputLabel={t('settings.confirm.inputLabel')}
        inputPlaceholder={organizationName}
        inputValue={deleteInputValue}
        onInputChange={setDeleteInputValue}
        expectedValue={organizationName}
        error={dangerError}
        isLoading={isLoading}
        confirmText={t('settings.actions.confirmDelete')}
        cancelText={t('settings.actions.cancel')}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title={t('settings.danger.leaveTitle')}
        description={t('settings.danger.leaveDescConfirm')}
        confirmText={t('settings.actions.leave')}
        cancelText={t('settings.actions.cancel')}
        onConfirm={handleLeave}
        isLoading={isLoading}
      />

      <OrganizationOwnershipTransferDialog
        open={transferDialogOpen}
        organizationName={organizationName}
        currentOwnerId={organization.owner_id}
        members={members}
        isLoading={isMutating}
        isLoadingMembers={isLoadingMembers}
        error={transferError}
        onOpenChange={(open) => {
          if (!open && isMutating) return
          setTransferDialogOpen(open)
          if (!open) setTransferError('')
        }}
        onConfirm={(newOwnerUserId) => void handleTransferOwnership(newOwnerUserId)}
      />
    </>
  )

  if (embedded) return body

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Building2 className="h-4 w-4" />}
        title={t('sections.teamGroup', { ns: 'settings' })}
        subtitle={organizationName}
      />
      {body}
    </SettingsPanelLayout>
  )
}
