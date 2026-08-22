/**
 * Reveal-in-file-manager label by host OS + active locale.
 * Keys (chat.openFile.*):
 *   - darwin  → revealInFinder   (en: Reveal in Finder / zh: 在 Finder 中显示)
 *   - win32   → revealInExplorer (en: Reveal in File Explorer / zh: 在文件资源管理器中显示)
 *   - else    → revealInOs       (en: Reveal in file manager / zh: 在文件管理器中显示)
 * defaultValue 用英文，与仓库其它 i18n 回退一致；正式文案以 locale JSON 为准。
 */

export type HostPlatform = 'darwin' | 'win32' | 'linux' | 'unknown'

export function getHostPlatform(
  getPlatform: (() => string) | undefined = typeof window !== 'undefined'
    ? window.tabtin?.getPlatform
    : undefined,
  userAgentPlatform: string = typeof navigator !== 'undefined'
    ? navigator.platform || ''
    : '',
): HostPlatform {
  try {
    const p = getPlatform?.()
    if (p === 'darwin' || p === 'win32' || p === 'linux') return p
  } catch {
    // fall through
  }
  if (/Mac|Macintosh/i.test(userAgentPlatform)) return 'darwin'
  if (/Win/i.test(userAgentPlatform)) return 'win32'
  if (/Linux/i.test(userAgentPlatform)) return 'linux'
  return 'unknown'
}

type Translate = (key: string, options?: { defaultValue?: string }) => string

export function resolveRevealInOsLabel(
  t: Translate,
  platform: HostPlatform = getHostPlatform(),
): string {
  if (platform === 'darwin') {
    return t('card.openFile.revealInFinder', { defaultValue: 'Reveal in Finder' })
  }
  if (platform === 'win32') {
    return t('card.openFile.revealInExplorer', {
      defaultValue: 'Reveal in File Explorer',
    })
  }
  return t('card.openFile.revealInOs', { defaultValue: 'Reveal in file manager' })
}
