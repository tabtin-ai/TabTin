import React, { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Moon, Sun, Monitor } from 'lucide-react'
import { useAuthStore, selectIsAuthenticated } from '@/stores/useAuthStore'
import { useI18nStore } from '@/stores/useI18nStore'
import { useUIStore, type UIFontSize } from '@/stores/useUIStore'
import { useTranslation } from 'react-i18next'
import { LANGUAGE_NATIVE_LABELS, SUPPORTED_LANGUAGES, type LanguagePreference } from '@/i18n/language'
import { COLOR_SCHEMES } from '@/constants/color-schemes'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@components/ui'
import { ChipTabBar } from '@components/common/ChipTabBar'
import { SettingsSectionHeader } from '../SettingsSectionHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsRow, SettingsRowGroup } from '../SettingsRow'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SETTINGS_SELECT_TRIGGER } from '../settingsUi'
import { cn } from '@utils/cn'

const FONT_SIZE_OPTIONS: Array<{ value: UIFontSize; labelKey: string }> = [
  { value: 'small', labelKey: 'general.fontSizeSmall' },
  { value: 'default', labelKey: 'general.fontSizeDefault' },
  { value: 'large', labelKey: 'general.fontSizeLarge' },
]

interface DesktopBehaviorSettings {
  minimizeToTray: boolean
  autoStart: boolean
}

/**
 * 桌面行为（设备级，走主进程 app-config.json，不进后端 ui_settings）：
 * 后台常驻 Windows/macOS 展示；开机自启 Windows/macOS 展示。
 */
const useDesktopBehaviorSettings = () => {
  const platform = window.tabtin?.getPlatform?.() ?? ''
  const supportsTray = platform === 'win32' || platform === 'darwin'
  const supportsAutoStart = platform === 'win32' || platform === 'darwin'
  const available = Boolean(window.tabtin?.appSettings) && (supportsTray || supportsAutoStart)

  const [settings, setSettings] = useState<DesktopBehaviorSettings | null>(null)

  useEffect(() => {
    if (!available) return
    let cancelled = false
    window.tabtin.appSettings.get()
      .then((value) => { if (!cancelled) setSettings(value) })
      .catch(() => { /* 主进程不可用时不展示该区块 */ })
    return () => { cancelled = true }
  }, [available])

  const updateSetting = (partial: Partial<DesktopBehaviorSettings>) => {
    // 乐观更新：开关即时反馈；主进程 set 内同步生效（托盘/登录项）
    setSettings(prev => (prev ? { ...prev, ...partial } : prev))
    void window.tabtin.appSettings.set(partial).catch(() => {
      void window.tabtin.appSettings.get().then(setSettings).catch(() => {})
    })
  }

  return { supportsTray, supportsAutoStart, settings, updateSetting }
}

const THEME_OPTIONS = [
  { value: 'light' as const, labelKey: 'general.themeLight', icon: Sun },
  { value: 'dark' as const, labelKey: 'general.themeDark', icon: Moon },
  { value: 'system' as const, labelKey: 'general.themeSystem', icon: Monitor },
]

export const LanguagePanel: React.FC = () => {
  const { t } = useTranslation('settings')
  const { t: tTheme } = useTranslation('theme')
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const { preference, setPreference, saveToServer } = useI18nStore(useShallow(state => ({
    preference: state.preference,
    setPreference: state.setPreference,
    saveToServer: state.saveToServer,
  })))
  const theme = useUIStore(s => s.theme)
  const setTheme = useUIStore(s => s.setTheme)
  const colorScheme = useUIStore(s => s.colorScheme)
  const resolvedTheme = useUIStore(s => s.resolvedTheme)
  const setColorScheme = useUIStore(s => s.setColorScheme)
  const uiFontSize = useUIStore(s => s.uiFontSize)
  const setUIFontSize = useUIStore(s => s.setUIFontSize)

  const isMac = useMemo(() => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || ''), [])
  const zoomShortcut = isMac ? '⌘ +/−' : 'Ctrl +/−'
  const desktopBehavior = useDesktopBehaviorSettings()

  const languageOptions = useMemo<Array<{ value: LanguagePreference; label: string; description?: string }>>(() => {
    return [
      { value: 'system' as LanguagePreference, label: t('general.system'), description: t('general.systemHint') },
      ...SUPPORTED_LANGUAGES.map((lang) => ({
        value: lang as LanguagePreference,
        label: LANGUAGE_NATIVE_LABELS[lang],
      })),
    ]
  }, [t])

  const handleLanguageChange = (value: LanguagePreference) => {
    // 乐观本地应用：语言切换即时生效且已本地持久化，界面立刻可见，无需提示。
    setPreference(value)
    if (!isAuthenticated) return
    // 后台静默同步到服务端（跨设备一致），自带重试且永不抛错，
    // 既不弹「已保存」噪音，也不会在偶发失败时弹「保存失败」打断用户。
    void saveToServer(value)
  }

  return (
    <SettingsPanelLayout>
      <SettingsSectionHeader section="language" subtitle={t('general.description')} />

      <SettingsSectionCard>
        <SettingsRowGroup>
            <SettingsRow
              label={t('general.themeSection')}
              description={t('general.themeHint', { defaultValue: '选择浅色、深色或跟随系统外观。' })}
              control={(
                <ChipTabBar
                  items={THEME_OPTIONS.map(opt => ({
                    value: opt.value,
                    label: t(opt.labelKey),
                    Icon: opt.icon,
                  }))}
                  value={theme}
                  onValueChange={setTheme}
                  ariaLabel={t('general.themeSection')}
                />
              )}
            />

            <SettingsRow
              label={t('general.colorSchemeSection')}
              description={t('general.colorSchemeHint')}
              control={(
                <div className="flex items-center gap-1.5">
                  {COLOR_SCHEMES.map(scheme => {
                    const preview = resolvedTheme === 'dark' ? scheme.accentDark : scheme.accentLight
                    const isActive = scheme.id === colorScheme
                    return (
                      <button
                        key={scheme.id}
                        type="button"
                        onClick={() => setColorScheme(scheme.id)}
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-interactive transition-colors',
                          isActive ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                        )}
                        title={tTheme(`colorScheme.descriptions.${scheme.id}`)}
                        aria-label={tTheme(`colorScheme.options.${scheme.id}`)}
                        aria-pressed={isActive}
                      >
                        <span
                          className={cn(
                            'h-4 w-4 rounded-full border transition-transform',
                            isActive ? 'scale-110 border-transparent ring-1 ring-accent/30' : 'border-border/40',
                          )}
                          style={{ backgroundColor: `hsl(${preview})` }}
                        />
                      </button>
                    )
                  })}
                </div>
              )}
            />

            <SettingsRow
              label={t('general.fontSizeSection')}
              description={t('general.fontSizeHint', { shortcut: zoomShortcut })}
              control={(
                <ChipTabBar
                  items={FONT_SIZE_OPTIONS.map(opt => ({
                    value: opt.value,
                    label: t(opt.labelKey),
                  }))}
                  value={uiFontSize}
                  onValueChange={setUIFontSize}
                  ariaLabel={t('general.fontSizeSection')}
                />
              )}
            />

            <SettingsRow
              label={t('general.languageSection')}
              description={languageOptions.find(option => option.value === preference)?.description}
              control={(
                <Select value={preference} onValueChange={(value) => handleLanguageChange(value as LanguagePreference)}>
                  <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER, 'w-44')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {languageOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
        </SettingsRowGroup>
      </SettingsSectionCard>

      {desktopBehavior.settings && (
        <SettingsSectionCard title={t('general.desktopBehaviorSection')}>
          <SettingsRowGroup>
            {desktopBehavior.supportsTray && (
              <SettingsRow
                label={t('general.desktopBehaviorTray')}
                description={t('general.desktopBehaviorTrayHint')}
                control={(
                  <Switch
                    checked={desktopBehavior.settings.minimizeToTray}
                    onCheckedChange={(checked) => desktopBehavior.updateSetting({ minimizeToTray: checked })}
                    aria-label={t('general.desktopBehaviorTray')}
                  />
                )}
              />
            )}
            {desktopBehavior.supportsAutoStart && (
              <SettingsRow
                label={t('general.desktopBehaviorAutoStart')}
                description={t('general.desktopBehaviorAutoStartHint')}
                control={(
                  <Switch
                    checked={desktopBehavior.settings.autoStart}
                    onCheckedChange={(checked) => desktopBehavior.updateSetting({ autoStart: checked })}
                    aria-label={t('general.desktopBehaviorAutoStart')}
                  />
                )}
              />
            )}
          </SettingsRowGroup>
        </SettingsSectionCard>
      )}
    </SettingsPanelLayout>
  )
}
