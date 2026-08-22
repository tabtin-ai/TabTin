import { withTimeout, DEFAULT_IPC_TIMEOUT } from '../utils/withTimeout'
import type { OpenIntentHints } from '@shared/open-intent'

type CreateViewInput = {
  crawlspaceId: string
  viewId?: string
  url: string
  title?: string
  runId?: string
  spaceId?: string
  isPreview?: boolean
  kind: 'workspace-view'
  profile: string
  partition: string
  sessionMode?: string
  allowPrivateHostNavigation?: boolean
  localPreviewRoot?: string
  openIntentHints?: OpenIntentHints
  proxy?: {
    server: string
    username?: string
    password?: string
  }
}

class CrawlspaceViewClient {
  async createView(input: CreateViewInput): Promise<{ success: boolean; viewId?: string; error?: string } | null> {
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return null
    return withTimeout(ipc.invoke('crawlspace:createView', input), DEFAULT_IPC_TIMEOUT, 'crawlspace:createView')
  }
}

export const crawlspaceViewClient = new CrawlspaceViewClient()
