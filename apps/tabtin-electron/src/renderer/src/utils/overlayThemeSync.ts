/**
 * overlay 子窗口 / overlay view 是独立 renderer，document 不会自动带上主窗口的
 * 主题（dark class / data-color-scheme / --accent 等）。这里提供主题快照的读取与
 * 应用：主 renderer 广播快照，overlay renderer 镜像到自己的 documentElement。
 */
export type OverlayThemeSnapshot = {
  isDark: boolean
  colorScheme: string | null
  accent: string | null
  ring: string | null
}

export function readThemeSnapshot(): OverlayThemeSnapshot {
  const root = document.documentElement
  return {
    isDark: root.classList.contains('dark'),
    colorScheme: root.dataset.colorScheme ?? null,
    accent: root.style.getPropertyValue('--accent') || null,
    ring: root.style.getPropertyValue('--ring') || null,
  }
}

export function applyThemeSnapshot(snapshot: OverlayThemeSnapshot): void {
  const root = document.documentElement
  root.classList.toggle('dark', snapshot.isDark)
  if (snapshot.colorScheme) {
    root.dataset.colorScheme = snapshot.colorScheme
  } else {
    delete root.dataset.colorScheme
  }
  if (snapshot.accent) {
    root.style.setProperty('--accent', snapshot.accent)
  } else {
    root.style.removeProperty('--accent')
  }
  if (snapshot.ring) {
    root.style.setProperty('--ring', snapshot.ring)
  } else {
    root.style.removeProperty('--ring')
  }
}
