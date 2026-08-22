/**
 * 应用菜单（macOS 菜单栏）构建与本地化。
 *
 * Help 子菜单是自定义 label（非 Electron role），必须按系统语言显式本地化。
 * 旧实现硬编码中文，会在英文 macOS 上出现 Edit/View 英文、Help 中文。
 *
 * 这里刻意跟随 `app.getLocale()`（系统语言），而不是渲染进程应用内语言偏好：
 * 菜单栏其余自定义项（Edit / View）也是系统侧英文文案；应用内容语言
 * （设置 → 语言习惯）不应把原生菜单栏单独改成中文。
 */

import { Menu, app } from 'electron'
import { createLogger } from './logger'
import { getMainWindow } from './window-manager'

const log = createLogger('ApplicationMenu')

export type ApplicationMenuLocale =
  | 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP'
  | 'ko-KR' | 'de-DE' | 'fr-FR' | 'es-ES'

export interface ApplicationMenuHelpLabels {
  help: string
  exportDiagnostics: string
  copyDiagnostics: string
}

const HELP_LABELS: Record<ApplicationMenuLocale, ApplicationMenuHelpLabels> = {
  'zh-CN': {
    help: '帮助',
    exportDiagnostics: '导出诊断日志',
    copyDiagnostics: '复制诊断日志到剪贴板',
  },
  'zh-TW': {
    help: '說明',
    exportDiagnostics: '匯出診斷日誌',
    copyDiagnostics: '複製診斷日誌到剪貼簿',
  },
  'en-US': {
    help: 'Help',
    exportDiagnostics: 'Export Diagnostic Logs',
    copyDiagnostics: 'Copy Diagnostic Logs to Clipboard',
  },
  'ja-JP': {
    help: 'ヘルプ',
    exportDiagnostics: '診断ログを書き出す',
    copyDiagnostics: '診断ログをクリップボードにコピー',
  },
  'ko-KR': {
    help: '도움말',
    exportDiagnostics: '진단 로그 내보내기',
    copyDiagnostics: '진단 로그를 클립보드에 복사',
  },
  'de-DE': {
    help: 'Hilfe',
    exportDiagnostics: 'Diagnoseprotokolle exportieren',
    copyDiagnostics: 'Diagnoseprotokolle in die Zwischenablage kopieren',
  },
  'fr-FR': {
    help: 'Aide',
    exportDiagnostics: 'Exporter les journaux de diagnostic',
    copyDiagnostics: 'Copier les journaux de diagnostic dans le presse-papiers',
  },
  'es-ES': {
    help: 'Ayuda',
    exportDiagnostics: 'Exportar registros de diagnóstico',
    copyDiagnostics: 'Copiar registros de diagnóstico al portapapeles',
  },
}

export function resolveApplicationMenuLocale(raw?: string | null): ApplicationMenuLocale {
  const value = (raw || '').toLowerCase()
  if (
    value === 'zh-tw'
    || value === 'zh-hk'
    || value === 'zh-mo'
    || value === 'zh-hant'
    || value.startsWith('zh-hant')
  ) {
    return 'zh-TW'
  }
  if (value.startsWith('zh')) return 'zh-CN'
  if (value.startsWith('ja')) return 'ja-JP'
  if (value.startsWith('ko')) return 'ko-KR'
  if (value.startsWith('de')) return 'de-DE'
  if (value.startsWith('fr')) return 'fr-FR'
  if (value.startsWith('es')) return 'es-ES'
  return 'en-US'
}

export function resolveApplicationMenuHelpLabels(raw?: string | null): ApplicationMenuHelpLabels {
  return HELP_LABELS[resolveApplicationMenuLocale(raw)]
}

let allowMainDevTools = false
let currentLocale: ApplicationMenuLocale = 'en-US'
let menuInstalled = false

function detectSystemLocale(): ApplicationMenuLocale {
  try {
    return resolveApplicationMenuLocale(app.getLocale())
  } catch {
    return 'en-US'
  }
}

function buildTemplate(labels: ApplicationMenuHelpLabels): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          registerAccelerator: false,
          click: (_item, browserWindow) => {
            ;(browserWindow as Electron.BrowserWindow | undefined)?.webContents.undo()
          },
        },
        {
          label: 'Redo',
          accelerator: 'Shift+CmdOrCtrl+Z',
          registerAccelerator: false,
          click: (_item, browserWindow) => {
            ;(browserWindow as Electron.BrowserWindow | undefined)?.webContents.redo()
          },
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' as const },
              { label: 'Speech', submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }] },
            ]
          : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(allowMainDevTools
          ? [
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
              { type: 'separator' as const },
            ]
          : []),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: labels.help,
      submenu: [
        {
          // 面向测试：一键把客户端诊断日志打包导出，随 bug 反馈发给研发。
          // 菜单在主进程，导出编排在渲染进程（那里有环形缓冲/面包屑/上下文），
          // 因此这里只向主窗口发事件触发。
          label: labels.exportDiagnostics,
          click: () => {
            const win = getMainWindow()
            if (!win || win.isDestroyed()) {
              log.warn('导出诊断日志：主窗口不存在或已销毁，忽略触发')
              return
            }
            log.info('导出诊断日志：菜单触发，向主窗口发送 diagnostics:trigger-export')
            win.webContents.send('diagnostics:trigger-export')
          },
        },
        {
          label: labels.copyDiagnostics,
          click: () => {
            const win = getMainWindow()
            if (!win || win.isDestroyed()) {
              log.warn('复制诊断日志：主窗口不存在或已销毁，忽略触发')
              return
            }
            log.info('复制诊断日志：菜单触发，向主窗口发送 diagnostics:trigger-copy')
            win.webContents.send('diagnostics:trigger-copy')
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ]
}

function installMenu(): void {
  const labels = HELP_LABELS[currentLocale]
  const appMenu = Menu.buildFromTemplate(buildTemplate(labels))
  Menu.setApplicationMenu(appMenu)
  menuInstalled = true
}

/**
 * 启动期安装应用菜单。Help 文案跟随系统 locale。
 */
export function setupApplicationMenu(options: { allowMainDevTools: boolean }): void {
  allowMainDevTools = options.allowMainDevTools
  currentLocale = detectSystemLocale()
  installMenu()
  log.info(`应用菜单已安装 locale=${currentLocale}`)
}

/**
 * 测试 / 运维入口：按给定 locale 重建菜单。
 * 生产路径只在启动时读系统语言；不跟随应用内语言偏好。
 */
export function setApplicationMenuLocale(locale: string): void {
  const next = resolveApplicationMenuLocale(locale)
  if (menuInstalled && next === currentLocale) return
  currentLocale = next
  if (!menuInstalled) return
  installMenu()
  log.info(`应用菜单已按语言重建 locale=${currentLocale}`)
}
