import type { WebContents } from 'electron'

type AutofillDomReadyHandler = (tabId: string, webContents: WebContents) => Promise<void> | void

let handler: AutofillDomReadyHandler | null = null

export function registerAutofillDomReadyHandler(next: AutofillDomReadyHandler | null): void {
  handler = next
}

export async function dispatchAutofillDomReady(tabId: string, webContents: WebContents): Promise<void> {
  await handler?.(tabId, webContents)
}
