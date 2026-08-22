import type { BrowserActionResult } from '@tabtin/browser-core'

/** Explicit application seam consumed by local transports. */
export interface BrowserApplicationPort {
  execute(actionId: string, body: unknown): Promise<BrowserActionResult | null>
  ensureTab(url?: string): Promise<string>
  executeSessionCommand(actionId: string, body: unknown): Promise<BrowserActionResult>
  executeNetworkCommand(actionId: string, body: unknown): Promise<BrowserActionResult>
  executeDownloadCommand(actionId: string, body: unknown): Promise<BrowserActionResult>
  executePageCommand(actionId: string, body: unknown): Promise<BrowserActionResult>
  executePrintCommand(body: unknown): Promise<BrowserActionResult>
  executeBatchCommand(body: unknown): Promise<BrowserActionResult>
  getActiveJobCount(): number
  shutdownJobs(): void
}
