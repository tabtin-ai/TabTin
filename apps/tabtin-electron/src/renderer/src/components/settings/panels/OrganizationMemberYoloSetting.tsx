import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Organization } from '@tabtin/app-shell'
import { ConfirmDialog, Switch, toast } from '@components/ui'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { SettingsSectionCard } from '../SettingsSectionCard'

/** ：组织准入天花板 —— 允许成员在对话里选宽松审批档（ auto / full_access）。 */
export const OrganizationMemberYoloSetting: React.FC<{
  organization: Organization
  canManageOrganization: boolean
}> = ({ organization, canManageOrganization }) => {
  const { t } = useTranslation('settings')
  const updateOrganization = useOrganizationStore(useShallow((s) => s.updateOrganization))
  const isLoading = useOrganizationStore(useShallow((s) => s.isLoading))
  const allowMemberYolo = organization.settings?.allow_member_yolo === true
  const [confirmYoloOpen, setConfirmYoloOpen] = useState(false)

  const persistMemberYolo = useCallback(async (value: boolean) => {
    try {
      await updateOrganization(organization.id, {
        settings: { ...(organization.settings ?? {}), allow_member_yolo: value },
      })
      toast({ title: t('settings.actions.saved') })
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t('settings.errors.updateFailed'),
        variant: 'destructive',
      })
    }
  }, [organization.id, organization.settings, t, updateOrganization])

  const handleMemberYoloToggle = useCallback((checked: boolean) => {
    if (checked === allowMemberYolo) return
    if (checked) setConfirmYoloOpen(true)
    else void persistMemberYolo(false)
  }, [allowMemberYolo, persistMemberYolo])

  return (
    <>
      <SettingsSectionCard
        title={t('organization:yolo.allowMemberLabel')}
        subtitle={(
          <>
            <p>{t('organization:yolo.allowMemberHint')}</p>
            {!canManageOrganization ? (
              <p className="mt-1.5">{t('organization:yolo.ownerOnlyHint')}</p>
            ) : null}
          </>
        )}
        subtitleAsTooltip
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-body text-foreground-secondary">
            {allowMemberYolo
              ? t('organizationServices.yolo.enabled', { defaultValue: '已开放' })
              : t('organizationServices.yolo.disabled', { defaultValue: '未开放' })}
          </span>
          <Switch
            checked={allowMemberYolo}
            onCheckedChange={handleMemberYoloToggle}
            disabled={!canManageOrganization || isLoading}
            aria-label={t('organization:yolo.allowMemberLabel')}
          />
        </div>
      </SettingsSectionCard>

      <ConfirmDialog
        open={confirmYoloOpen}
        onOpenChange={setConfirmYoloOpen}
        title={t('organization:yolo.confirmTitle')}
        description={t('organization:yolo.confirmBody')}
        variant="destructive"
        onConfirm={() => persistMemberYolo(true)}
      />
    </>
  )
}

OrganizationMemberYoloSetting.displayName = 'OrganizationMemberYoloSetting'
