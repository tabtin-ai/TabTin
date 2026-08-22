import type { WebContents } from 'electron'
import { getViewFactory } from '../view-factory'
import { matchesRelayDomain } from './cookie-scope'

const RELOAD_TIMEOUT_MS = 15_000

export type RefreshLoginRelayTabResult =
  | { ok: true }
  | { ok: false; errorCode: 'target_tab_unavailable' | 'target_tab_mismatch' | 'reload_failed' }

function partitionName(partition: string): string {
  return partition.startsWith('persist:')
    ? partition.slice('persist:'.length)
    : partition
}

function resolveTarget(
  tabId: string,
  expectedPartition: string,
  expectedDomain: string,
):
  | { ok: true; webContents: WebContents }
  | { ok: false; errorCode: 'target_tab_unavailable' | 'target_tab_mismatch' } {
  const factory = getViewFactory()
  const state = factory.getViewState(tabId)
  const webContents = factory.getWebContents(tabId)
  if (!state || !webContents || webContents.isDestroyed()) {
    return { ok: false, errorCode: 'target_tab_unavailable' }
  }
  if (partitionName(state.config.partition) !== partitionName(expectedPartition)) {
    return { ok: false, errorCode: 'target_tab_mismatch' }
  }
  try {
    if (!matchesRelayDomain(new URL(webContents.getURL()).hostname, expectedDomain)) {
      return { ok: false, errorCode: 'target_tab_mismatch' }
    }
  } catch {
    return { ok: false, errorCode: 'target_tab_mismatch' }
  }
  return { ok: true, webContents }
}

function waitForReload(webContents: WebContents): Promise<RefreshLoginRelayTabResult> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: RefreshLoginRelayTabResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      webContents.removeListener('did-finish-load', onFinish)
      webContents.removeListener('did-fail-load', onFailure)
      webContents.removeListener('destroyed', onDestroyed)
      resolve(result)
    }
    const onFinish = () => finish({ ok: true })
    const onFailure = () => finish({ ok: false, errorCode: 'reload_failed' })
    const onDestroyed = () => finish({ ok: false, errorCode: 'target_tab_unavailable' })
    const timeout = setTimeout(() => finish({ ok: false, errorCode: 'reload_failed' }), RELOAD_TIMEOUT_MS)

    webContents.once('did-finish-load', onFinish)
    webContents.once('did-fail-load', onFailure)
    webContents.once('destroyed', onDestroyed)
    try {
      webContents.reloadIgnoringCache()
    } catch {
      finish({ ok: false, errorCode: 'reload_failed' })
    }
  })
}

export async function refreshLoginRelayTab(input: {
  tabId: string
  expectedPartition: string
  expectedDomain: string
}): Promise<RefreshLoginRelayTabResult> {
  const target = resolveTarget(input.tabId, input.expectedPartition, input.expectedDomain)
  if (!target.ok) return target
  return waitForReload(target.webContents)
}
