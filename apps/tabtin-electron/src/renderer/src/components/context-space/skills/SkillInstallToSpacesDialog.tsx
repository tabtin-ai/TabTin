import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
/**
 * 本机 / 市场 fork 后「安装到哪些 Space」确认框。
 * Skill 本体先变成「我的」；启用仍按 Space，用户勾选目标。
 */
import React, { useEffect, useState } from 'react'
import {
  Dialog, DialogContent, DialogFooter, DialogScrollBody,
  Button,
} from '@components/ui'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ContextDialogHeader } from '../ContextDialogHeader'
import {
  SkillSpacePicker,
  useDefaultSkillEnableSpaceIds,
} from './SkillSpacePicker'

export interface SkillInstallToSpacesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
  organizationId: string | null
  skillName: string
  /** 确认后回调选中的 Space id 列表（至少 1 个）。 */
  onConfirm: (spaceIds: string[]) => void | Promise<void>
  isLoading?: boolean
}

export const SkillInstallToSpacesDialog: React.FC<SkillInstallToSpacesDialogProps> = ({
  open,
  onOpenChange,
  spaceId,
  organizationId,
  skillName,
  onConfirm,
  isLoading = false,
}) => {
  const { t } = useTranslation('context')
  const defaults = useDefaultSkillEnableSpaceIds(spaceId, organizationId)
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<string[]>(defaults)

  useEffect(() => {
    if (open) setSelectedSpaceIds(defaults)
  }, [open, defaults])

  const canSubmit = selectedSpaceIds.length > 0 && !isLoading

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col overflow-hidden">
        <ContextDialogHeader
          className="shrink-0 px-0 pt-0"
          icon={<Download className="h-7 w-7" />}
          title={t('skills.installToSpaces.title')}
          description={t('skills.installToSpaces.description', { name: skillName })}
        />
        <DialogScrollBody className="space-y-3 py-2">
          <p className={CANVAS_TEXT_META}>
            {t('skills.installToSpaces.hint')}
          </p>
          <SkillSpacePicker
            spaceId={spaceId}
            organizationId={organizationId}
            enabled
            selectedSpaceIds={selectedSpaceIds}
            onSelectedSpaceIdsChange={setSelectedSpaceIds}
          />
        </DialogScrollBody>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            {t('skills.installToSpaces.cancel')}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => { void onConfirm(selectedSpaceIds) }}
          >
            {isLoading
              ? t('skills.installToSpaces.installing')
              : t('skills.installToSpaces.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
SkillInstallToSpacesDialog.displayName = 'SkillInstallToSpacesDialog'
