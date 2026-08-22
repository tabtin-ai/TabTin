/**
 * TabDoc Host Runtime — 一次性 bootstrap
 *
 * 类比 @tabtin/table-host-runtime，负责初始化 TabDoc 共享包的运行时依赖：
 * - 创建 AppHostClient（HTTP 传输层）
 * - 配置 TabDocEditorConfig（auth / collab / image-upload / event-stream）
 * - 配置 TabData 嵌入块渲染器（可选）
 */
import { createDirectAppClient } from '@tabtin/app-host-sdk/host'
import { AppHostClient } from '@tabtin/app-host-sdk'
import type { AppHttpRequest, AppHttpResponse, AppHttpTransport } from '@tabtin/contracts/app'
import type {
  TabDocEditorConfig,
  TabDocImageUploadPort,
  TabDocAuthPort,
  TabDocCollabConfig,
  TabDocEventStreamPort,
  TabDocRuntimeMonitorPort,
} from '@tabtin/tabdoc-ui'
import { configureTabDataBlockView, type TabDataBlockRenderProps } from '@tabtin/tabdoc-ui/editor'

export interface TabDocHostRuntimeOptions {
  appId?: string
  baseApiUrl: string
  organizationId?: string | null
  spaceId?: string | null
  auth: TabDocAuthPort
  collab: TabDocCollabConfig
  imageUpload: TabDocImageUploadPort
  eventStream?: TabDocEventStreamPort
  runtimeMonitor?: TabDocRuntimeMonitorPort
  dragTypeMeta?: string
  chatContextDragType?: string
  fileRefDragType?: string
  navigate?: (target: { type: string; id: string }) => void
  request: (req: AppHttpRequest) => Promise<AppHttpResponse>
  renderTableEmbed?: (props: TabDataBlockRenderProps) => React.ReactNode
}

export function initializeTabDocHostRuntime(options: TabDocHostRuntimeOptions): {
  client: AppHostClient
  config: TabDocEditorConfig
} {
  const client = createDirectAppClient({
    appId: options.appId ?? 'tabdoc',
    spaceId: options.spaceId ?? null,
    organizationId: options.organizationId ?? null,
    baseApiUrl: options.baseApiUrl,
    getAccessToken: () => options.auth.getAccessToken(),
    httpTransport: options.request as AppHttpTransport,
    navigate: options.navigate,
  })

  const config: TabDocEditorConfig = {
    auth: options.auth,
    collab: options.collab,
    imageUpload: options.imageUpload,
    eventStream: options.eventStream,
    runtimeMonitor: options.runtimeMonitor,
    apiBaseUrl: options.baseApiUrl,
    dragTypeMeta: options.dragTypeMeta,
    chatContextDragType: options.chatContextDragType,
    fileRefDragType: options.fileRefDragType,
  }

  if (options.renderTableEmbed) {
    configureTabDataBlockView({
      renderTableEmbed: options.renderTableEmbed,
    })
  }

  return { client, config }
}
