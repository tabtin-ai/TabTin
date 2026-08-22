import type { WebContents } from 'electron'

type EventListener = (...args: any[]) => void

type WebContentsEventTarget = Pick<WebContents, 'on' | 'removeListener'>

export interface CrawlViewWebContentsEventBindings {
  onDidStartLoading: () => void
  onDidFinishLoad: () => void
  onDidStopLoading: () => void
  onDidFailLoad: (
    event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => void
  onDidStartNavigation: (event: unknown, url: string) => void
  onDidNavigateInPage: (event: unknown, url: string) => void
  onDidFrameNavigate: (event: any) => void
  onDidFailProvisionalLoad: (
    event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => void
  onWillNavigate: (event: unknown, url: string) => void
  onPageTitleUpdated: (event: unknown, title: string) => void
  onPageFaviconUpdated: (event: unknown, favicons: string[]) => void
  onDidChangeThemeColor: (event: unknown, color: string) => void
  onConsoleMessage: (event: any) => void
}

export function bindCrawlViewWebContentsEvents(
  webContents: WebContentsEventTarget,
  bindings: CrawlViewWebContentsEventBindings,
): () => void {
  const listeners: Array<{ eventName: string; listener: EventListener }> = []
  const eventTarget = webContents as unknown as {
    on: (eventName: string, listener: EventListener) => void
    removeListener: (eventName: string, listener: EventListener) => void
  }

  const add = (eventName: string, listener: EventListener): void => {
    eventTarget.on(eventName, listener)
    listeners.push({ eventName, listener })
  }

  add('did-start-loading', bindings.onDidStartLoading)
  add('did-finish-load', bindings.onDidFinishLoad)
  add('did-stop-loading', bindings.onDidStopLoading)
  add('did-fail-load', bindings.onDidFailLoad)
  add('did-start-navigation', bindings.onDidStartNavigation)
  add('did-navigate-in-page', bindings.onDidNavigateInPage)
  add('did-frame-navigate', bindings.onDidFrameNavigate)
  add('did-fail-provisional-load', bindings.onDidFailProvisionalLoad)
  add('will-navigate', bindings.onWillNavigate)
  add('page-title-updated', bindings.onPageTitleUpdated)
  add('page-favicon-updated', bindings.onPageFaviconUpdated)
  add('did-change-theme-color', bindings.onDidChangeThemeColor)
  add('console-message', bindings.onConsoleMessage)

  return () => {
    for (const { eventName, listener } of listeners) {
      eventTarget.removeListener(eventName, listener)
    }
  }
}
