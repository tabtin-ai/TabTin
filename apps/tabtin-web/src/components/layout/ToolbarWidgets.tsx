import { useUIStore, type ThemePreference } from '@/stores/ui-store'
import { Sun, Moon, Monitor, Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'

const THEME_ICONS: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

const THEME_CYCLE: ThemePreference[] = ['light', 'dark', 'system']

export function LanguageToggle() {
  const { t } = useTranslation('common')

  const toggleLanguage = () => {
    const next = i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN'
    i18n.changeLanguage(next)
    localStorage.setItem('tabtin_language', next)
  }

  return (
    <button
      onClick={toggleLanguage}
      className="flex items-center justify-center h-8 w-8 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted"
      title={t('switchLanguage')}
    >
      <Languages className="h-4 w-4" />
    </button>
  )
}

export function ThemeToggle() {
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  const { t } = useTranslation('common')

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme)
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]
    setTheme(next)
  }

  const ThemeIcon = THEME_ICONS[theme]

  return (
    <button
      onClick={cycleTheme}
      className="flex items-center justify-center h-8 w-8 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted"
      title={t('theme')}
    >
      <ThemeIcon className="h-4 w-4" />
    </button>
  )
}
