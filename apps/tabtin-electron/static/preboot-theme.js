(() => {
  const COLOR_SCHEMES = {
    blue: { light: '215 65% 52%', dark: '215 65% 62%' },
    teal: { light: '178 55% 42%', dark: '178 55% 55%' },
    orange: { light: '28 75% 52%', dark: '28 75% 60%' },
    rose: { light: '350 55% 52%', dark: '350 55% 62%' },
    slate: { light: '220 10% 42%', dark: '220 10% 60%' },
    violet: { light: '270 16% 38%', dark: '270 16% 55%' },
    sky: { light: '194 76% 50%', dark: '194 70% 58%' },
  }

  const UI_KEYS = ['tabtin-prefs-ui', 'tabtin-ui-store']

  const readState = () => {
    for (const key of UI_KEYS) {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) continue
        const parsed = JSON.parse(raw)
        return parsed && (parsed.state || parsed)
      } catch {
        // Ignore broken local preferences; the boot screen should still render.
      }
    }
    return {}
  }

  const state = readState()
  const theme = ['system', 'light', 'dark'].includes(state.theme) ? state.theme : 'system'
  const isDark = theme === 'dark' || (
    theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )
  const schemeId = Object.prototype.hasOwnProperty.call(COLOR_SCHEMES, state.colorScheme)
    ? state.colorScheme
    : 'orange'
  const accent = COLOR_SCHEMES[schemeId][isDark ? 'dark' : 'light']

  const root = document.documentElement
  root.classList.toggle('dark', isDark)
  root.dataset.colorScheme = schemeId
  root.style.setProperty('--primary', accent)
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--ring', accent)
})()
