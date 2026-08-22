/**
 * Bridge a BrowserView loadURL preview block back into the existing renderer
 * Preview flow.
 *
 * guardLoadURL remains pure; this helper is the main-process side effect.
 */

import type { BrowserWindow, WebContents } from 'electron'
import type { OpenIntent, OpenIntentHints } from '../shared/open-intent'
import { guardLoadURL } from '../shared/guard-load-url'
import { isBlockedExternalAppProtocol } from './external-protocol-guard'
import { createLogger } from './logger'
import { sendResourceOpenFallback } from './resource-open-fallback'

const log = createLogger('BlockedPreviewLoad')

type PreviewIntent = Extract<OpenIntent, { kind: 'preview' }>

export interface HandleBlockedPreviewLoadInput {
  url: string
  source: string
  intent: PreviewIntent
  mainWindow: BrowserWindow | null | undefined
  filename?: string
  mimeType?: string
  assetId?: string
}

export interface GuardDirectLoadURLInput extends OpenIntentHints {
  url: string
  source: string
  mainWindow: BrowserWindow | null | undefined
}

export type GuardDirectLoadURLResult =
  | { action: 'allow' }
  | { action: 'block-preview'; intent: PreviewIntent; fallbackSent: boolean }

export function handleBlockedPreviewLoad(input: HandleBlockedPreviewLoadInput): boolean {
  const sent = sendResourceOpenFallback(input.mainWindow, {
    url: input.url,
    source: input.source,
    filename: input.filename,
    mimeType: input.mimeType,
    assetId: input.assetId,
  })
  if (!sent) {
    log.warn('Preview fallback IPC 未发送', {
      source: input.source,
      previewKind: input.intent.previewKind,
    })
  }
  return sent
}

export function guardDirectLoadURL(input: GuardDirectLoadURLInput): GuardDirectLoadURLResult {
  const { url, source, mainWindow, filename, mimeType, assetId } = input
  const decision = guardLoadURL({ url, source, filename, mimeType, assetId })
  if (decision.action === 'allow') {
    return { action: 'allow' }
  }

  const fallbackSent = handleBlockedPreviewLoad({
    url,
    source,
    intent: decision.intent,
    mainWindow,
    filename,
    mimeType,
    assetId,
  })

  return { action: 'block-preview', intent: decision.intent, fallbackSent }
}

const guardedWillNavigate = new WeakSet<WebContents>()

function blockExternalAppProtocolNavigation(
  event: { preventDefault: () => void },
  url: string,
  source: string,
): boolean {
  if (!isBlockedExternalAppProtocol(url)) return false
  event.preventDefault()
  let scheme = 'unknown'
  try {
    scheme = new URL(url).protocol.toLowerCase()
  } catch {
    // ignore
  }
  log.warn('已阻止外部应用协议导航', { source, scheme })
  return true
}

export function installPreviewGuardWillNavigate(
  webContents: WebContents,
  getMainWindow: () => BrowserWindow | null | undefined,
  source: string,
  getOpenIntentHints?: () => OpenIntentHints | undefined,
): void {
  if (guardedWillNavigate.has(webContents)) return
  guardedWillNavigate.add(webContents)

  webContents.on('will-navigate', (event, url) => {
    if (blockExternalAppProtocolNavigation(event, url, source)) return

    const hints = getOpenIntentHints?.()
    const decision = guardLoadURL({ url, ...hints, source })
    if (decision.action !== 'block-preview') return

    event.preventDefault()
    handleBlockedPreviewLoad({
      url,
      source,
      intent: decision.intent,
      mainWindow: getMainWindow(),
      ...hints,
    })
  })

  // iframe / 子 frame 唤起自定义协议时走 will-frame-navigate，不会进 will-navigate
  webContents.on('will-frame-navigate', (event) => {
    blockExternalAppProtocolNavigation(event, event.url, `${source}.frame`)
  })
}
