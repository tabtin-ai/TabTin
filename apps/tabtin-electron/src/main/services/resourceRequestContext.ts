import { session as electronSession } from 'electron'

import type { ResourceAuthContextRef, ResourceRecord } from '@tabtin/action-tools/types'

import { getViewFactory } from '../view-factory'

type ResourceSessionInput = {
  viewId?: string
  resource?: Pick<ResourceRecord, 'viewId' | 'authContextRef'> | null
}

export function resolveResourceRequestSession(input: ResourceSessionInput): Electron.Session | undefined {
  const authContext: ResourceAuthContextRef | undefined = input.resource?.authContextRef
  const candidateViewIds = [
    input.viewId,
    authContext?.viewId,
    input.resource?.viewId
  ].filter((value): value is string => Boolean(value))

  for (const candidateViewId of candidateViewIds) {
    //  Phase 3: 容器无关取页面 WebContents（WCV 与 webview guest 通吃）
    const wc = getViewFactory().getWebContents(candidateViewId)
    const liveSession = (wc && !wc.isDestroyed() ? wc.session : undefined) as Electron.Session | undefined
    if (liveSession) {
      return liveSession
    }
  }

  const partition = authContext?.sessionPartition
  if (partition && partition !== 'shared') {
    try {
      return electronSession.fromPartition(partition)
    } catch {
      // Fall back to defaultSession / undefined below.
    }
  }

  if (partition === 'shared' || authContext?.requiresSession) {
    return electronSession.defaultSession
  }

  return undefined
}

export function buildNetRequestOptions(
  url: string,
  requestSession?: Electron.Session
): Electron.ClientRequestConstructorOptions {
  return requestSession
    ? { url, method: 'GET', redirect: 'follow', session: requestSession }
    : { url, method: 'GET', redirect: 'follow' }
}
