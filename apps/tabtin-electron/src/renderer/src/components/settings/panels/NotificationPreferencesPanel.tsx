/**
 * NotificationPreferencesPanel — 账号级通知偏好面板（个人设置 → 系统通知）
 *
 * 产品口径（2026-07 重设计）：客户端**只能真实控制「按分类要不要通知」**。
 * 桌面横幅是否弹、Dock 角标是否显示等属于系统/宿主行为，应用层无法可靠开关，
 * 因此不提供「通知总控 / 角标 / 声音 / 免打扰」这类看得见却管不着的开关。
 * 整页就是一组分类开关，无需再套分类标题或权限提示——每类选择「要提醒」或「保持安静」。
 *
 * 后端映射（main/services/notification）：show() 真正读取的是
 *   userPrefs.enabled（全局闸门）+ categoryOverrides[cat].desktopEnabled/soundEnabled。
 * 所以：
 *   - 分类开 → 写 categoryOverrides[cat] = { desktopEnabled: true, soundEnabled: true }
 *   - 分类关 → 写 { desktopEnabled: false, soundEnabled: false }（该类彻底安静）
 *   - 全局闸门 enabled/desktopEnabled/soundEnabled 恒为开、dnd 恒为关，由分类接管。
 *
 * 这一份偏好对当前用户在本机的所有 organization 一致生效。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { SettingsSectionHeader } from '../SettingsSectionHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsRow, SettingsRowGroup } from '../SettingsRow'
import { SETTINGS_SELECT_TRIGGER } from '../settingsUi'

interface CategoryOverride {
  desktopEnabled?: boolean
  soundEnabled?: boolean
  desktopDelivery?: DesktopDelivery
}

type DesktopDelivery = 'never' | 'unfocused' | 'always'

const CATEGORY_KEYS = [
  { key: 'collaboration', labelKey: 'categoryCollaboration' },
  { key: 'organization', labelKey: 'categoryOrganization' },
  { key: 'account', labelKey: 'categoryAccount' },
  { key: 'tracker.run', labelKey: 'categoryTracker' },
  { key: 'im', labelKey: 'categoryIm' },
  { key: 'download', labelKey: 'categoryDownload' },
  { key: 'system.update', labelKey: 'categorySystem' },
  { key: 'extension', labelKey: 'categoryExtension' },
] as const

const AGENT_RESULT_KEY = 'agent.task.result'
const AGENT_SWITCH_KEYS = [
  { key: 'agent.task.interruption', labelKey: 'agentInterruptions' },
  { key: 'agent.hitl', labelKey: 'agentWaitingForMe' },
] as const

function resolveAgentResultDelivery(override: CategoryOverride | undefined): DesktopDelivery {
  if (override?.desktopDelivery) return override.desktopDelivery
  if (override?.desktopEnabled === false) return 'never'
  return 'always'
}

interface NotificationPreferencesPanelProps {
  /** 嵌入模式：只渲染分类开关列表，由「系统权限」页提供页眉与分组标题。 */
  embedded?: boolean
}

export const NotificationPreferencesPanel: React.FC<NotificationPreferencesPanelProps> = ({ embedded = false }) => {
  const { t } = useTranslation(['settings', 'common'])

  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, CategoryOverride>>({})
  // 旧版本可能存了「总控关闭 / 免打扰开启」的全局状态；新 UI 不再暴露这些开关，
  // 若不归一，用户会全静默且无处可开。加载时一次性把全局闸门归位，交由分类接管。
  const normalizedRef = useRef(false)

  useEffect(() => {
    if (!window.tabtin?.notification) return
    window.tabtin.notification.getPrefs().then((p) => {
      if (!p) return
      setCategoryOverrides((p.categoryOverrides ?? {}) as Record<string, CategoryOverride>)
      if (!normalizedRef.current) {
        normalizedRef.current = true
        const needsNormalize =
          p.enabled === false ||
          p.desktopEnabled === false ||
          p.soundEnabled === false ||
          p.dndEnabled === true
        if (needsNormalize) {
          void window.tabtin?.notification
            ?.setPrefs({ enabled: true, desktopEnabled: true, soundEnabled: true, dndEnabled: false })
            .catch(() => {})
        }
      }
    }).catch(() => {})

    // IA Phase 2：主进程在"其它设备 WS 回灌 / 多窗口本地改动"后广播最新偏好，
    // 这里只刷新本地分类状态（不回调 setPrefs，天然不成回声环）。
    const unsubscribePrefs = window.tabtin.notification.onPrefsChanged?.((p) => {
      if (p) setCategoryOverrides((p.categoryOverrides ?? {}) as Record<string, CategoryOverride>)
    })

    return () => {
      unsubscribePrefs?.()
    }
  }, [])

  const setCategoryEnabled = useCallback((category: string, enabled: boolean) => {
    // 单个「要不要通知」开关同时控制桌面与声音——关闭即该类彻底安静。
    const nextOverride: CategoryOverride = { desktopEnabled: enabled, soundEnabled: enabled }
    setCategoryOverrides((prev) => ({ ...prev, [category]: nextOverride }))
    void window.tabtin?.notification
      ?.setPrefs({ categoryOverrides: { [category]: nextOverride } })
      .catch(() => {})
  }, [])

  const setAgentResultDelivery = useCallback((delivery: DesktopDelivery) => {
    const nextOverride: CategoryOverride = {
      desktopDelivery: delivery,
      desktopEnabled: delivery !== 'never',
      soundEnabled: delivery !== 'never',
    }
    setCategoryOverrides((prev) => ({ ...prev, [AGENT_RESULT_KEY]: nextOverride }))
    void window.tabtin?.notification
      ?.setPrefs({ categoryOverrides: { [AGENT_RESULT_KEY]: nextOverride } })
      .catch(() => {})
  }, [])

  const resolveOverride = useCallback((category: string) => (
    categoryOverrides[category] ?? (
      category.startsWith('agent.') ? categoryOverrides['agent.task'] : undefined
    )
  ), [categoryOverrides])

  const agentRows = (
    <SettingsRowGroup>
      <SettingsRow
        label={t('notifications.agentTaskResults')}
        controlClassName="w-full sm:w-[180px]"
        control={(
          <Select
            value={resolveAgentResultDelivery(resolveOverride(AGENT_RESULT_KEY))}
            onValueChange={(value) => setAgentResultDelivery(value as DesktopDelivery)}
          >
            <SelectTrigger className={SETTINGS_SELECT_TRIGGER} aria-label={t('notifications.agentTaskResults')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">{t('notifications.deliveryNever')}</SelectItem>
              <SelectItem value="unfocused">{t('notifications.deliveryUnfocused')}</SelectItem>
              <SelectItem value="always">{t('notifications.deliveryAlways')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      />
      {AGENT_SWITCH_KEYS.map((cat) => {
        const categoryLabel = t(`notifications.${cat.labelKey}`)
        const on = resolveOverride(cat.key)?.desktopEnabled ?? true
        return (
          <SettingsRow
            key={cat.key}
            label={categoryLabel}
            control={(
              <Switch
                checked={on}
                onCheckedChange={(v: boolean) => setCategoryEnabled(cat.key, v)}
                aria-label={t('notifications.categoryToggle', {
                  defaultValue: '{{category}} 通知',
                  category: categoryLabel,
                })}
              />
            )}
          />
        )
      })}
    </SettingsRowGroup>
  )

  const rows = (
    <div className="space-y-2">
      {agentRows}
      <SettingsRowGroup>
        {CATEGORY_KEYS.map((cat) => {
          const categoryLabel = t(`notifications.${cat.labelKey}`)
          const on = categoryOverrides[cat.key]?.desktopEnabled ?? true
          return (
            <SettingsRow
              key={cat.key}
              label={categoryLabel}
              control={(
                <Switch
                  checked={on}
                  onCheckedChange={(v: boolean) => setCategoryEnabled(cat.key, v)}
                  aria-label={t('notifications.categoryToggle', {
                    defaultValue: '{{category}} 通知',
                    category: categoryLabel,
                  })}
                />
              )}
            />
          )
        })}
      </SettingsRowGroup>
    </div>
  )

  if (embedded) {
    return rows
  }

  return (
    <SettingsPanelLayout>
      <SettingsSectionHeader
        section="notifications"
        subtitle={t('notifications.userSubtitle')}
      />
      {rows}
    </SettingsPanelLayout>
  )
}
