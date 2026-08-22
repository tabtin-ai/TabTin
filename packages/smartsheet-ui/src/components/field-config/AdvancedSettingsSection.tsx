/**
 * AdvancedSettingsSection - 高级设置可折叠区域
 *
 * 包含列宽、可见性角色、验证规则（最小/最大长度、正则、规则描述）。
 * 高级字段验证选项。
 * 受控组件，所有状态由父组件传入。
 */

import React from 'react'
import { Button } from '../button'
import { Checkbox } from '../checkbox'
import { Input } from '../input'
import { Label } from '../label'
import { useTranslation } from 'react-i18next'

const VISIBILITY_ROLE_OPTIONS = [
  { value: 'owner', defaultLabel: '所有者' },
  { value: 'admin', defaultLabel: '管理员' },
  { value: 'editor', defaultLabel: '编辑者' },
  { value: 'viewer', defaultLabel: '查看者' },
  { value: 'all', defaultLabel: '所有人' },
] as const

export interface AdvancedSettingsSectionProps {
  showAdvanced: boolean
  onToggle: () => void
  width: number | ''
  minLength: number | ''
  maxLength: number | ''
  pattern: string
  validationMessage: string
  visibilityRoles: string[]
  onWidthChange: (v: number | '') => void
  onMinLengthChange: (v: number | '') => void
  onMaxLengthChange: (v: number | '') => void
  onPatternChange: (v: string) => void
  onValidationMessageChange: (v: string) => void
  onVisibilityRolesChange: (v: string[]) => void
  /** link 等结构字段不展示文本验证规则 */
  hideValidationRules?: boolean
}

export const AdvancedSettingsSection: React.FC<AdvancedSettingsSectionProps> = ({
  showAdvanced,
  onToggle,
  width,
  minLength,
  maxLength,
  pattern,
  validationMessage,
  visibilityRoles,
  onWidthChange,
  onMinLengthChange,
  onMaxLengthChange,
  onPatternChange,
  onValidationMessageChange,
  onVisibilityRolesChange,
  hideValidationRules = false,
}) => {
  const { t } = useTranslation('field')

  const handleNumericChange = (
    setter: (v: number | '') => void,
  ) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    if (raw === '') {
      setter('')
    } else {
      const numeric = Number(raw)
      if (!Number.isNaN(numeric)) setter(numeric)
    }
  }

  const handleRoleChange = (roleValue: string, checked: boolean | 'indeterminate') => {
    onVisibilityRolesChange(
      (() => {
        if (roleValue === 'all') {
          return checked ? ['all'] : []
        }
        const filtered = visibilityRoles.filter((item) => item !== 'all')
        if (checked) {
          return [...filtered, roleValue]
        }
        return filtered.filter((item) => item !== roleValue)
      })(),
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <span className="text-body font-medium text-muted-foreground">
          {t('fieldSettingPanel.advancedSettings', { defaultValue: '高级设置' })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onToggle}>
          {showAdvanced
            ? t('fieldSettingPanel.collapse', { defaultValue: '收起' })
            : t('fieldSettingPanel.expand', { defaultValue: '展开' })}
        </Button>
      </div>

      {showAdvanced && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="field-width">
              {t('fieldSettingPanel.columnWidthLabel', { defaultValue: '列宽' })}
            </Label>
            <Input
              id="field-width"
              type="number"
              min="100"
              max="800"
              placeholder={t('fieldSettingPanel.columnWidthPlaceholder', {
                defaultValue: '默认自适应（100-800）',
              })}
              value={width}
              onChange={handleNumericChange(onWidthChange)}
            />
            <p className="text-body text-muted-foreground">
              {t('fieldSettingPanel.columnWidthHelp', {
                defaultValue: '设置列宽，范围 100-800 像素，留空为默认宽度',
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-body font-medium">
              {t('fieldSettingPanel.visibilityRoles', { defaultValue: '可见性角色' })}
            </Label>
            <div className="grid grid-cols-2 gap-2">
              {VISIBILITY_ROLE_OPTIONS.map((role) => (
                <label
                  key={role.value}
                  className="flex items-center gap-2 rounded border border-border/60 bg-background px-3 py-2 text-body cursor-pointer"
                >
                  <Checkbox
                    checked={
                      role.value === 'all'
                        ? visibilityRoles.includes('all')
                        : visibilityRoles.includes(role.value)
                    }
                    onCheckedChange={(checked) => handleRoleChange(role.value, checked)}
                  />
                  <span>
                    {t(`fieldSettingPanel.visibility.${role.value}`, {
                      defaultValue: role.defaultLabel,
                    })}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-body text-muted-foreground">
              {t('fieldSettingPanel.visibilityHelp', {
                defaultValue: '选择"所有人"会覆盖其他角色选择',
              })}
            </p>
          </div>

          {!hideValidationRules && (
            <div className="space-y-2">
              <Label className="text-body font-medium">
                {t('fieldSettingPanel.validationRules', { defaultValue: '验证规则' })}
              </Label>
              <div className="space-y-2 rounded border border-border/60 bg-background px-3 py-3">
                <div className="space-y-1">
                  <Label htmlFor="field-validation-message" className="text-body text-muted-foreground">
                    {t('fieldSettingPanel.validationMessageLabel', { defaultValue: '规则描述' })}
                  </Label>
                  <Input
                    id="field-validation-message"
                    placeholder={t('fieldSettingPanel.validationMessagePlaceholder', {
                      defaultValue: '如：请输入数字工号',
                    })}
                    value={validationMessage}
                    onChange={(e) => onValidationMessageChange(e.target.value)}
                  />
                  <p className="text-body text-muted-foreground">
                    {t('fieldSettingPanel.validationMessageHelp', {
                      defaultValue: '校验失败时展示给填写者；留空则使用默认提示',
                    })}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="field-min-length" className="text-body text-muted-foreground">
                      {t('fieldSettingPanel.minLength', { defaultValue: '最小长度' })}
                    </Label>
                    <Input
                      id="field-min-length"
                      type="number"
                      min="0"
                      value={minLength}
                      onChange={handleNumericChange(onMinLengthChange)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="field-max-length" className="text-body text-muted-foreground">
                      {t('fieldSettingPanel.maxLength', { defaultValue: '最大长度' })}
                    </Label>
                    <Input
                      id="field-max-length"
                      type="number"
                      min="0"
                      value={maxLength}
                      onChange={handleNumericChange(onMaxLengthChange)}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="field-pattern" className="text-body text-muted-foreground">
                    {t('fieldSettingPanel.patternLabel', { defaultValue: '正则表达式' })}
                  </Label>
                  <Input
                    id="field-pattern"
                    placeholder={t('fieldSettingPanel.patternPlaceholder', {
                      defaultValue: '如 ^[0-9]+$ 或 ^[A-Z]{2}\\d{4}$',
                    })}
                    value={pattern}
                    onChange={(e) => onPatternChange(e.target.value)}
                  />
                  <p className="text-body text-muted-foreground">
                    {t('fieldSettingPanel.patternHelp', {
                      defaultValue:
                        '填写裸正则（不要带 /.../）。整串只能是数字用 ^[0-9]+$；从开头是数字用 [0-9]+',
                    })}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
