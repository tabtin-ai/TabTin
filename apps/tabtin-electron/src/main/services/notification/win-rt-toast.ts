/**
 * Windows WinRT Toast — bypass Electron Notification when WPN registration fails .
 *
 * Preprod 诊断：Electron `Notification.show()` 会触发 `show` 事件，但
 * `wpndatabase` / 设置应用列表不更新；同 AUMID 的 WinRT `ToastNotificationManager`
 * 可正常出横幅。此处用 Windows PowerShell 加载 WinRT（无额外原生依赖）。
 */

import { spawn } from 'node:child_process'
import { createLogger } from '../../logger'

const log = createLogger('WinRtToast')

export interface WinRtToastInput {
  title: string
  body: string
  /** AppUserModelID，须与 app.setAppUserModelId / 开始菜单快捷方式一致 */
  aumid: string
  silent?: boolean
  /**
   * App 图标 file:// URL（与 macOS Electron Notification 使用同一套 static/icon.png）。
   * 写入 ToastGeneric appLogoOverride，缩小与 Mac 横幅的视觉差。
   */
  iconFileUrl?: string
  /**
   * 横幅停留秒数，对齐 macOS 系统横幅「数秒后收入通知中心」。
   * WinRT XML 只有 short(~7s)/long(~25s)；再用 ExpirationTime 收到更接近 Mac 的量级。
   */
  bannerSeconds?: number
  /**
   * 点击横幅时的 protocol 激活 URL（如 tabtin://notify?d=...）。
   * WinRT 在 Electron 外投递，必须靠系统协议唤起应用，不能依赖 Electron Notification click。
   */
  launchUrl?: string
}

/** 默认与 macOS 横幅观感接近的短停留（秒）。 */
export const WIN_TOAST_BANNER_SECONDS_DEFAULT = 5

export function escapeToastXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildToastXml(input: WinRtToastInput): string {
  const title = escapeToastXml(input.title.slice(0, 120))
  const body = escapeToastXml(input.body.slice(0, 250))
  const silentAttr = input.silent ? ' silent="true"' : ''
  // duration=short：接近 Mac 短横幅；勿用 long / reminder（会明显长于 Mac）。
  const logo = input.iconFileUrl
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeToastXml(input.iconFileUrl)}"/>`
    : ''
  const launch = input.launchUrl?.trim()
    ? ` activationType="protocol" launch="${escapeToastXml(input.launchUrl.trim())}"`
    : ''
  return (
    `<toast duration="short"${launch}>` +
    `<audio${silentAttr}/>` +
    `<visual><binding template="ToastGeneric">` +
    logo +
    `<text hint-style="title">${title}</text>` +
    `<text hint-style="body">${body}</text>` +
    `</binding></visual></toast>`
  )
}

function buildPowerShellScript(aumid: string, xml: string, bannerSeconds: number): string {
  // 单引号字符串：把嵌入的 ' 翻倍即可。
  const aumidLit = `'${aumid.replace(/'/g, "''")}'`
  const xmlLit = `'${xml.replace(/'/g, "''")}'`
  const seconds = Math.max(3, Math.min(15, Math.round(bannerSeconds)))
  return [
    '$ErrorActionPreference = \'Stop\'',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml(${xmlLit})`,
    `$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${aumidLit})`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    // 与 macOS 横幅类似：数秒后从屏幕消失（仍可能留在通知中心，取决于系统设置）
    `$toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds(${seconds})`,
    `$notifier.Show($toast)`,
    `Write-Output ('ok:' + [string]$notifier.Setting)`,
  ].join('; ')
}

/**
 * Fire-and-forget WinRT toast. Resolves when PowerShell exits (does not wait for user dismiss).
 */
export function showWindowsRtToast(input: WinRtToastInput): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, detail: 'not-win32' })
  }
  if (!input.aumid.trim()) {
    return Promise.resolve({ ok: false, detail: 'empty-aumid' })
  }

  const bannerSeconds = input.bannerSeconds ?? WIN_TOAST_BANNER_SECONDS_DEFAULT
  const xml = buildToastXml(input)
  const script = buildPowerShellScript(input.aumid.trim(), xml, bannerSeconds)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      log.warn('WinRT toast powershell timeout', { aumid: input.aumid })
      resolve({ ok: false, detail: 'timeout' })
    }, 8_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      log.error('WinRT toast spawn failed', { error: String(err) })
      resolve({ ok: false, detail: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const detail = (stdout || stderr || `exit:${code ?? '?'}`).trim()
      const ok = code === 0 && detail.startsWith('ok:')
      if (!ok) {
        log.warn('WinRT toast failed', { code, detail: detail.slice(0, 300) })
      } else {
        log.info('WinRT toast shown', {
          aumid: input.aumid,
          setting: detail.slice(3),
          title: input.title.slice(0, 80),
        })
      }
      resolve({ ok, detail })
    })
  })
}

export const __testing = {
  buildToastXml,
  buildPowerShellScript,
  escapeToastXml,
}
