/**
 * 资源检测工具
 *
 * 获取当前页面检测到的媒体/静态资源列表（视频、M3U8、音频、图片、字体、文档等）。
 * 这是 Browser Runtime 的 Level 0 标准 API —— 任何 App 声明 browser 依赖即可消费。
 *
 * @author TabTin Team
 */

import type { AgentTool } from '../types'
import { ToolErrorCode } from '../types/errors'
import { standardizeLegacyResult } from '../utils/tool-output'
import { resolveResourceDetectionAPI } from '../utils/runtime-bridge'
import { resolveViewId } from '../utils/resolve-view-id'
import { t } from '../i18n'

export type {
  ResourceContentRef,
  ResourceAuthContextRef,
  ResourceErrorInfo,
  ResourceCaptureStatus,
  ResourceCapability,
  ResourceCategory,
  ResourceSource,
  DetectedResource,
  ResourceRecord,
  ResourceDetectionSummary,
  GetDetectedResourcesInput,
  GetDetectedResourcesOutput,
  ListResourcesInput,
  ListResourcesOutput,
  InspectResourceInput,
  InspectResourceOutput,
  CaptureResourceInput,
  CaptureResourceOutput,
  StreamInfo,
  StreamVariant,
  MediaElementInfo,
  DownloadResourceInput,
  DownloadResourceOutput,
  ParseM3U8Input,
  ParseM3U8Output,
  ParseStreamInput,
  ParseStreamOutput,
  M3U8Segment,
  DownloadStreamInput,
  DownloadStreamOutput,
  DownloadBatchInput,
  DownloadBatchOutput
} from '../types/resource-detection'

import type {
  GetDetectedResourcesInput,
  GetDetectedResourcesOutput,
  ListResourcesInput,
  ListResourcesOutput,
  InspectResourceInput,
  InspectResourceOutput,
  CaptureResourceInput,
  CaptureResourceOutput,
} from '../types/resource-detection'

export const getDetectedResourcesTool: AgentTool<GetDetectedResourcesInput, GetDetectedResourcesOutput> = {
  name: 'get_detected_resources',
  description: t('tools.resourceDetection.getResources.description'),
  parameters: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description: t('tools.resourceDetection.getResources.params.runId')
      },
      viewId: {
        type: 'string',
        description: t('tools.resourceDetection.getResources.params.viewId')
      },
      category: {
        type: 'string',
        enum: ['video', 'hls', 'dash', 'audio', 'image', 'font', 'document'],
        description: t('tools.resourceDetection.getResources.params.category')
      },
      limit: {
        type: 'number',
        description: t('tools.resourceDetection.getResources.params.limit')
      },
      probeMedia: {
        type: 'boolean',
        description: '是否同时探测页面中的 <video>/<audio> 元素（可发现 blob: URL 和 MediaSource 资源）。默认 false'
      },
      hideSegments: {
        type: 'boolean',
        description: '是否隐藏 HLS/DASH 等流媒体分片'
      },
      crawlTabId: {
        type: 'string',
        description: t('tools.resourceDetection.getResources.params.crawlTabId')
      }
    },
    required: []
  },
  async execute(input: GetDetectedResourcesInput): Promise<GetDetectedResourcesOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.getResources) {
      return standardizeLegacyResult({
        success: false,
        error: t('errors.ipcNotAvailable'),
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as GetDetectedResourcesOutput
    }

    const viewId = resolveViewId(input)
    if (!viewId) {
      return standardizeLegacyResult({
        success: false,
        error: t('errors.runIdRequired'),
        error_code: ToolErrorCode.INVALID_PARAMETER
      }) as unknown as GetDetectedResourcesOutput
    }

    try {
      const result = await api.getResources({
        viewId,
        category: input.category,
        limit: input.limit ?? 100,
        probeMedia: input.probeMedia,
        hideSegments: input.hideSegments ?? true
      })
      return standardizeLegacyResult(result) as unknown as GetDetectedResourcesOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as GetDetectedResourcesOutput
    }
  }
}

export const listResourcesTool: AgentTool<ListResourcesInput, ListResourcesOutput> = {
  name: 'list_resources',
  description: t('tools.resource.list.description'),
  parameters: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      viewId: { type: 'string' },
      category: {
        type: 'string',
        enum: ['video', 'hls', 'dash', 'audio', 'image', 'font', 'document']
      },
      captureStatus: {
        type: 'string',
        enum: ['metadata_only', 'content_cached', 'page_bound_blob', 'stream_manifest', 'downloaded', 'unsupported', 'failed']
      },
      capability: {
        type: 'string',
        enum: ['preview', 'download', 'import', 'sendToAgent', 'parse', 'streamDownload']
      },
      limit: { type: 'number' },
      probeMedia: { type: 'boolean' },
      hideSegments: { type: 'boolean' },
      crawlTabId: { type: 'string' }
    },
    required: []
  },
  async execute(input: ListResourcesInput): Promise<ListResourcesOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.listResources && !api?.getResources) {
      return standardizeLegacyResult({
        success: false,
        error: t('errors.ipcNotAvailable'),
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as ListResourcesOutput
    }

    const viewId = resolveViewId(input)
    if (!viewId) {
      return standardizeLegacyResult({
        success: false,
        error: t('errors.runIdRequired'),
        error_code: ToolErrorCode.INVALID_PARAMETER
      }) as unknown as ListResourcesOutput
    }

    const executor = api.listResources || api.getResources!
    try {
      const result = await executor({
        viewId,
        category: input.category,
        captureStatus: input.captureStatus,
        capability: input.capability,
        limit: input.limit ?? 100,
        probeMedia: input.probeMedia,
        hideSegments: input.hideSegments ?? true
      } as any)
      return standardizeLegacyResult(result) as unknown as ListResourcesOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as ListResourcesOutput
    }
  }
}

export const inspectResourceTool: AgentTool<InspectResourceInput, InspectResourceOutput> = {
  name: 'inspect_resource',
  description: t('tools.resource.inspect.description'),
  parameters: {
    type: 'object',
    properties: {
      resourceId: { type: 'string', description: t('tools.resource.inspect.params.resourceId') },
      viewId: { type: 'string' },
      crawlTabId: { type: 'string' }
    },
    required: ['resourceId']
  },
  async execute(input: InspectResourceInput): Promise<InspectResourceOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.inspectResource) {
      return standardizeLegacyResult({
        success: false,
        error: 'inspect_resource API not available in current runtime — use CLI: tabtin browser resource inspect',
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as InspectResourceOutput
    }

    try {
      const result = await api.inspectResource({
        resourceId: input.resourceId,
        viewId: resolveViewId(input)
      })
      return standardizeLegacyResult(result) as unknown as InspectResourceOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as InspectResourceOutput
    }
  }
}

export const captureResourceTool: AgentTool<CaptureResourceInput, CaptureResourceOutput> = {
  name: 'capture_resource',
  description: t('tools.resource.capture.description'),
  parameters: {
    type: 'object',
    properties: {
      resourceId: { type: 'string' },
      url: { type: 'string' },
      viewId: { type: 'string' },
      crawlTabId: { type: 'string' },
      force: { type: 'boolean' }
    },
    required: []
  },
  async execute(input: CaptureResourceInput): Promise<CaptureResourceOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.captureResource) {
      return standardizeLegacyResult({
        success: false,
        error: 'capture_resource API not available in current runtime — use CLI: tabtin browser resource capture',
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as CaptureResourceOutput
    }

    try {
      const result = await api.captureResource({
        resourceId: input.resourceId,
        url: input.url,
        viewId: resolveViewId(input),
        force: input.force
      })
      return standardizeLegacyResult(result) as unknown as CaptureResourceOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as CaptureResourceOutput
    }
  }
}

export const resourceDetectionTools = [
  getDetectedResourcesTool,
  listResourcesTool,
  inspectResourceTool,
  captureResourceTool
]
