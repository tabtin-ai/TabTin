import { Menu, MenuItem, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import * as path from 'path'
import type { ContextMenuContext } from '../types'
import { t } from '../i18n'
import { BROWSER_CONTEXT_MENU_ADD_TO_CONTEXT_CHANNEL } from '../../../shared/browser-context-menu-channels'
import { createLogger } from '../../logger'

const log = createLogger('ContextMenu')

export function appendPageActionItems(
  menu: Menu,
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  const { webContents, mainWindow, viewId } = ctx
  const pageUrl = webContents.getURL()
  const isHttpUrl = pageUrl && /^https?:\/\//i.test(pageUrl)
  const selectionText = params.selectionText?.trim() ?? ''

  if (selectionText && isHttpUrl) {
    menu.append(new MenuItem({
      label: t('addToContext'),
      click: () => {
        if (webContents.isDestroyed() || mainWindow.isDestroyed()) return
        mainWindow.webContents.send(BROWSER_CONTEXT_MENU_ADD_TO_CONTEXT_CHANNEL, {
          viewId,
          selectionText,
        })
      },
    }))
    menu.append(new MenuItem({ type: 'separator' }))
  }

  menu.append(new MenuItem({
    label: t('savePageAs'),
    accelerator: 'CmdOrCtrl+S',
    enabled: Boolean(isHttpUrl),
    click: async () => {
      if (webContents.isDestroyed() || !isHttpUrl) return

      let defaultName = 'page.html'
      try { defaultName = `${new URL(pageUrl).hostname}.html` } catch { /* ignore */ }

      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName,
        filters: [
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'MHTML', extensions: ['mhtml', 'mht'] },
        ],
      })

      if (result.canceled || !result.filePath || webContents.isDestroyed()) return

      const saveType = result.filePath.endsWith('.mhtml') || result.filePath.endsWith('.mht')
        ? 'MHTML' as const
        : 'HTMLComplete' as const

      webContents.savePage(result.filePath, saveType).catch((err) => {
        log.error(`savePage 失败 type=${saveType}:`, err)
      })
    },
  }))

  menu.append(new MenuItem({
    label: t('print'),
    accelerator: 'CmdOrCtrl+P',
    click: () => {
      if (!webContents.isDestroyed()) {
        webContents.print({ silent: false, printBackground: true }, (success, reason) => {
          if (!success && reason) {
            log.warn('print 失败:', reason)
          }
        })
      }
    },
  }))

  menu.append(new MenuItem({
    label: t('captureScreenshot'),
    click: async () => {
      if (webContents.isDestroyed()) return

      let defaultName = 'screenshot.png'
      try {
        const host = new URL(webContents.getURL()).hostname
        defaultName = `${host}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
      } catch { /* ignore */ }

      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName,
        filters: [
          { name: 'PNG', extensions: ['png'] },
          { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        ],
      })

      if (result.canceled || !result.filePath || webContents.isDestroyed()) return

      try {
        const image = await webContents.capturePage()
        const ext = path.extname(result.filePath).toLowerCase()
        const buffer = ext === '.jpg' || ext === '.jpeg'
          ? image.toJPEG(90)
          : image.toPNG()

        await writeFile(result.filePath, buffer)
        log.info(`screenshot 已保存: ${path.basename(result.filePath)}`)
      } catch (err) {
        log.error('screenshot 失败:', err)
      }
    },
  }))
}
