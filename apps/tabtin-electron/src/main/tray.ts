import { app, Menu, Notification, Tray, type BrowserWindow } from 'electron'

import { configService } from './services/ConfigService'
import { resolveStartupUiLocale, type StartupUiLocale } from './startup-ui-locale'
import { createTrayNativeImage } from './tray-icon'
import { isTrayModeEnabled, shouldUseTraySetContextMenu } from './tray-policy'

export interface TrayLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface TrayControllerOptions {
  /** 应用图标路径（可为 1024 Dock 图）；创建托盘时会去白底并缩到菜单栏尺寸 */
  icon: string
  log: TrayLogger
  /** 唤回已隐藏/最小化的主窗口（不新建、不 loadURL） */
  restoreMainWindow: () => BrowserWindow | null
  /** 主窗口不存在（被销毁）时的兜底重建，复用 app 'activate' 的创建逻辑 */
  recreateMainWindow: () => void
}

export { createTrayNativeImage } from './tray-icon'

export interface TrayController {
  /** 按当前配置创建 / 销毁托盘图标（设置切换与启动时都走这一个入口） */
  syncFromSettings: () => void
  destroy: () => void
  isActive: () => boolean
  /** 窗口因点 X 被隐藏后调用：首次隐藏弹一次「仍在后台运行」系统通知 */
  notifyHiddenToTray: () => void
}

interface TrayLabels {
  tooltip: string
  open: string
  quit: string
  hiddenHintTitle: string
  hiddenHintBody: string
}

const TRAY_LABELS: Record<StartupUiLocale, TrayLabels> = {
  'zh-CN': {
      tooltip: 'TabTin',
      open: '打开 TabTin',
      quit: '退出',
      hiddenHintTitle: 'TabTin 仍在后台运行',
      hiddenHintBody: '窗口已隐藏。点击托盘 / 菜单栏图标，或点击任务栏 / Dock 图标可重新打开。可在设置中关闭此行为。',
  },
  'zh-TW': {
    tooltip: 'TabTin', open: '開啟 TabTin', quit: '結束', hiddenHintTitle: 'TabTin 仍在背景執行',
    hiddenHintBody: '視窗已隱藏。點擊系統匣 / 選單列圖示，或工作列 / Dock 圖示即可重新開啟。你可以在設定中關閉此行為。',
  },
  'en-US': {
    tooltip: 'TabTin',
    open: 'Open TabTin',
    quit: 'Quit',
    hiddenHintTitle: 'TabTin is still running',
    hiddenHintBody: 'The window was hidden. Click the tray or menu bar icon to reopen it, or use the taskbar / Dock. You can change this in Settings.',
  },
  'ja-JP': {
    tooltip: 'TabTin', open: 'TabTin を開く', quit: '終了', hiddenHintTitle: 'TabTin はバックグラウンドで実行中です',
    hiddenHintBody: 'ウィンドウは非表示になりました。トレイ / メニューバー、タスクバー / Dock のアイコンをクリックすると再度開けます。この動作は設定で変更できます。',
  },
  'ko-KR': {
    tooltip: 'TabTin', open: 'TabTin 열기', quit: '종료', hiddenHintTitle: 'TabTin이 백그라운드에서 실행 중입니다',
    hiddenHintBody: '창이 숨겨졌습니다. 트레이 / 메뉴 막대 또는 작업 표시줄 / Dock 아이콘을 클릭하여 다시 열 수 있습니다. 설정에서 이 동작을 변경할 수 있습니다.',
  },
  'de-DE': {
    tooltip: 'TabTin', open: 'TabTin öffnen', quit: 'Beenden', hiddenHintTitle: 'TabTin wird im Hintergrund ausgeführt',
    hiddenHintBody: 'Das Fenster wurde ausgeblendet. Klicken Sie zum Öffnen auf das Taskleisten-/Menüleistensymbol oder auf das Symbol in der Taskleiste/im Dock. Dieses Verhalten können Sie in den Einstellungen ändern.',
  },
  'fr-FR': {
    tooltip: 'TabTin', open: 'Ouvrir TabTin', quit: 'Quitter', hiddenHintTitle: 'TabTin s’exécute toujours en arrière-plan',
    hiddenHintBody: 'La fenêtre a été masquée. Cliquez sur l’icône de la barre d’état / des menus ou sur celle de la barre des tâches / du Dock pour la rouvrir. Ce comportement peut être modifié dans les paramètres.',
  },
  'es-ES': {
    tooltip: 'TabTin', open: 'Abrir TabTin', quit: 'Salir', hiddenHintTitle: 'TabTin sigue ejecutándose en segundo plano',
    hiddenHintBody: 'La ventana se ha ocultado. Haz clic en el icono de la bandeja / barra de menús o en el de la barra de tareas / Dock para volver a abrirla. Puedes cambiar este comportamiento en Ajustes.',
  },
}

function resolveTrayLabels(): TrayLabels {
  return TRAY_LABELS[resolveStartupUiLocale()]
}

export function createTrayController(options: TrayControllerOptions): TrayController {
  let tray: Tray | null = null

  const showMainWindow = (): void => {
    if (options.restoreMainWindow()) {
      return
    }
    options.log.info('[Tray] 主窗口不存在，重建后显示')
    options.recreateMainWindow()
  }

  const quitFromTray = (): void => {
    // 退出前先把窗口拉回前台：exit guard / 运行中任务确认等对话框都挂在
    // 主窗口上，窗口隐藏时用户会看不到确认框、误以为退出卡死。
    showMainWindow()
    app.quit()
  }

  const create = (): void => {
    if (tray) return
    const labels = resolveTrayLabels()
    try {
      const trayIcon = createTrayNativeImage(options.icon)
      if (trayIcon.isEmpty()) {
        options.log.error('[Tray] 托盘图标为空，跳过创建:', options.icon)
        return
      }
      tray = new Tray(trayIcon)
    } catch (err) {
      options.log.error('[Tray] 创建托盘图标失败:', err)
      tray = null
      return
    }
    tray.setToolTip(labels.tooltip)
    const menu = Menu.buildFromTemplate([
      { label: labels.open, click: showMainWindow },
      { type: 'separator' },
      { label: labels.quit, click: quitFromTray },
    ])
    // 左键唤回主窗口；右键弹「打开 / 退出」。
    // macOS：setContextMenu 会吞左键，改用 right-click + popUpContextMenu。
    tray.on('click', () => {
      showMainWindow()
    })
    if (shouldUseTraySetContextMenu(process.platform)) {
      tray.setContextMenu(menu)
    } else {
      tray.on('right-click', (_event, bounds) => {
        tray?.popUpContextMenu(menu, bounds)
      })
    }
    options.log.info('[Tray] 托盘图标已创建')
  }

  const destroy = (): void => {
    if (!tray) return
    try {
      tray.destroy()
    } catch (err) {
      options.log.warn('[Tray] 销毁托盘图标时出错:', err)
    }
    tray = null
    options.log.info('[Tray] 托盘图标已销毁')
  }

  const syncFromSettings = (): void => {
    if (isTrayModeEnabled(process.platform, configService.get('settings'))) {
      create()
    } else {
      destroy()
    }
  }

  const notifyHiddenToTray = (): void => {
    const settings = configService.get('settings')
    if (settings?.trayHideHintShown) return
    configService.update('settings', { trayHideHintShown: true })
    if (!Notification.isSupported()) return
    const labels = resolveTrayLabels()
    try {
      const hint = new Notification({
        title: labels.hiddenHintTitle,
        body: labels.hiddenHintBody,
      })
      hint.on('click', showMainWindow)
      hint.show()
    } catch (err) {
      options.log.warn('[Tray] 首次隐藏提示通知失败:', err)
    }
  }

  return {
    syncFromSettings,
    destroy,
    isActive: () => tray !== null,
    notifyHiddenToTray,
  }
}
