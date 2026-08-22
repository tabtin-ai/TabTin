import { Menu, MenuItem, clipboard } from 'electron'
import type { ContextMenuContext } from '../types'
import { t } from '../i18n'

export function appendMediaItems(
  menu: Menu,
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  const { webContents } = ctx
  const flags = params.mediaFlags
  const isPaused = flags?.isPaused ?? false
  const isMuted = flags?.isMuted ?? false

  menu.append(new MenuItem({
    label: isPaused ? t('play') : t('pause'),
    click: () => {
      if (!webContents.isDestroyed()) {
        webContents.executeJavaScript(`
          (function() {
            var el = document.elementFromPoint(${params.x}, ${params.y});
            if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
              el.paused ? el.play() : el.pause();
            }
          })()
        `).catch(() => {})
      }
    },
  }))
  menu.append(new MenuItem({
    label: isMuted ? t('unmute') : t('mute'),
    click: () => {
      if (!webContents.isDestroyed()) {
        webContents.executeJavaScript(`
          (function() {
            var el = document.elementFromPoint(${params.x}, ${params.y});
            if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
              el.muted = !el.muted;
            }
          })()
        `).catch(() => {})
      }
    },
  }))
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({
    label: t('copyMediaAddress'),
    click: () => clipboard.writeText(params.srcURL),
  }))
}
