/**
 * ProfileFormShell — 档案侧边面板内的表单壳子
 *
 * 提供统一的"滚动内容 + 底部固定保存栏"layout。
 * 子表单（identity / rules / workingDir）只关心字段渲染和 dirty / submit 逻辑。
 */
import React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL } from '@components/settings/settingsUi'

export interface ProfileFormShellProps {
  children: React.ReactNode
  /** 表单是否有未保存修改 */
  dirty: boolean
  /** 是否正在保存 */
  saving: boolean
  /** 是否禁用保存（除 dirty 外的额外条件，如校验失败） */
  saveDisabled?: boolean
  /** 错误信息（红字显示在保存栏上方） */
  error?: string | null
  /** 成功提示（淡绿色显示在保存栏上方，会自动淡出） */
  success?: string | null
  /** 提交回调 */
  onSubmit: () => void | Promise<void>
}

export const ProfileFormShell: React.FC<ProfileFormShellProps> = ({
  children,
  dirty,
  saving,
  saveDisabled = false,
  error,
  success,
  onSubmit,
}) => {
  const { t } = useTranslation('space')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || saving || saveDisabled) return
    void onSubmit()
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto py-1 space-y-5">
        {children}
      </div>

      <div className="shrink-0 pt-3 mt-2">
        {error && (
          <p className="mb-2 text-caption text-destructive">{error}</p>
        )}
        {success && (
          <p className="mb-2 text-caption text-success">{success}</p>
        )}
        <div className="flex items-center justify-end gap-3">
          {dirty && !saving && (
            <span className="text-caption text-muted-foreground/60">
              {t('security.unsavedChanges', { defaultValue: '有未保存的更改' })}
            </span>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={!dirty || saving || saveDisabled}
            className={cn(
              SETTINGS_CONTROL,
              'transition-opacity',
              (!dirty || saveDisabled) && 'opacity-40',
            )}
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin shrink-0" />
                {t('actions.saving', { defaultValue: '保存中…' })}
              </>
            ) : (
              t('actions.save', { defaultValue: '保存' })
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}
