/**
 * 资源下载与 M3U8 解析工具
 *
 * 为 Agent 提供主动资源获取能力：
 * - download_resource: 下载指定 URL 的资源到本地（支持大文件、自定义 headers）
 * - parse_m3u8: 解析 HLS m3u8 playlist，提取分片地址和流信息
 *
 * 与 get_detected_resources 配合使用：先检测 → 再下载/解析
 *
 * @author TabTin Team
 */

import type { AgentTool } from '../types'
import { ToolErrorCode } from '../types/errors'
import { standardizeLegacyResult } from '../utils/tool-output'
import { resolveResourceDetectionAPI } from '../utils/runtime-bridge'
import { t } from '../i18n'

import type {
  DownloadResourceInput,
  DownloadResourceOutput,
  ParseM3U8Input,
  ParseM3U8Output,
  ParseStreamInput,
  ParseStreamOutput,
  DownloadStreamInput,
  DownloadStreamOutput,
  DownloadBatchInput,
  DownloadBatchOutput,
} from '../types/resource-detection'

export const downloadResourceTool: AgentTool<DownloadResourceInput, DownloadResourceOutput> = {
  name: 'download_resource',
  description: t('tools.download.resource.description'),
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: t('tools.download.resource.params.url')
      },
      resourceId: {
        type: 'string',
        description: '统一资源 ID。提供后优先按 resourceId 下载。'
      },
      filename: {
        type: 'string',
        description: t('tools.download.resource.params.filename')
      },
      headers: {
        type: 'object',
        description: t('tools.download.resource.params.headers')
      },
      viewId: {
        type: 'string',
        description: '目标视图 ID（优先使用）'
      },
      crawlTabId: {
        type: 'string',
        description: '由 runtime 注入的 View ID（viewId 的别名，向后兼容）'
      }
    },
    required: []
  },
  async execute(input: DownloadResourceInput): Promise<DownloadResourceOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.downloadResource) {
      return standardizeLegacyResult({
        success: false,
        error: 'download_resource API not available in current runtime — use CLI: tabtin browser resource download',
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as DownloadResourceOutput
    }

    if (!input.resourceId && !input.url) {
      return standardizeLegacyResult({
        success: false,
        error: 'resourceId 或 url 至少需要提供一项',
        error_code: ToolErrorCode.INVALID_PARAMETER
      }) as unknown as DownloadResourceOutput
    }

    try {
      const result = await api.downloadResource({
        resourceId: input.resourceId,
        url: input.url,
        filename: input.filename,
        headers: input.headers,
        viewId: input.viewId || input.crawlTabId
      })
      return standardizeLegacyResult(result) as unknown as DownloadResourceOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as DownloadResourceOutput
    }
  }
}

export const parseM3U8Tool: AgentTool<ParseM3U8Input, ParseM3U8Output> = {
  name: 'parse_m3u8',
  description: t('tools.download.parseM3U8.description'),
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: t('tools.download.parseM3U8.params.url')
      },
      resourceId: {
        type: 'string',
        description: '统一资源 ID。提供后优先按 resourceId 解析。'
      },
      headers: {
        type: 'object',
        description: t('tools.download.parseM3U8.params.headers')
      },
      viewId: {
        type: 'string',
        description: '目标视图 ID（优先使用）'
      },
      crawlTabId: {
        type: 'string',
        description: '由 runtime 注入的 View ID（viewId 的别名，向后兼容）'
      }
    },
    required: []
  },
  async execute(input: ParseM3U8Input): Promise<ParseM3U8Output> {
    const api = resolveResourceDetectionAPI()
    if (!api?.parseM3U8) {
      return standardizeLegacyResult({
        success: false,
        error: 'parse_m3u8 API not available in current runtime — use CLI: tabtin browser stream parse',
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as ParseM3U8Output
    }

    if (!input.resourceId && !input.url) {
      return standardizeLegacyResult({
        success: false,
        error: 'resourceId 或 url 至少需要提供一项',
        error_code: ToolErrorCode.INVALID_PARAMETER
      }) as unknown as ParseM3U8Output
    }

    try {
      const result = await api.parseM3U8({
        resourceId: input.resourceId,
        url: input.url,
        headers: input.headers,
        viewId: input.viewId || input.crawlTabId
      })
      return standardizeLegacyResult(result) as unknown as ParseM3U8Output
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as ParseM3U8Output
    }
  }
}

export const parseStreamTool: AgentTool<ParseStreamInput, ParseStreamOutput> = {
  name: 'parse_stream',
  description: t('tools.resource.parseStream.description'),
  parameters: {
    type: 'object',
    properties: {
      resourceId: { type: 'string', description: t('tools.resource.parseStream.params.resourceId') },
      url: { type: 'string', description: t('tools.resource.parseStream.params.url') },
      headers: { type: 'object', description: t('tools.resource.parseStream.params.headers') },
      viewId: { type: 'string', description: '目标视图 ID（优先使用）' },
      crawlTabId: { type: 'string', description: '由 runtime 注入的 View ID（viewId 的别名，向后兼容）' }
    },
    required: []
  },
  async execute(input: ParseStreamInput): Promise<ParseStreamOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.parseStream) {
      return standardizeLegacyResult({
        success: false,
        error: 'parse_stream API not available in current runtime — use CLI: tabtin browser stream parse',
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as ParseStreamOutput
    }

    if (!input.resourceId && !input.url) {
      return standardizeLegacyResult({
        success: false,
        error: 'resourceId 或 url 至少需要提供一项',
        error_code: ToolErrorCode.INVALID_PARAMETER
      }) as unknown as ParseStreamOutput
    }

    try {
      const result = await api.parseStream({
        resourceId: input.resourceId,
        url: input.url,
        headers: input.headers,
        viewId: input.viewId || input.crawlTabId
      })
      return standardizeLegacyResult(result) as unknown as ParseStreamOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as ParseStreamOutput
    }
  }
}

export const downloadStreamTool: AgentTool<DownloadStreamInput, DownloadStreamOutput> = {
  name: 'download_stream',
  description: t('tools.download.stream.description'),
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: t('tools.download.stream.params.url')
      },
      resourceId: {
        type: 'string',
        description: '统一资源 ID。提供后优先按 resourceId 下载。'
      },
      quality: {
        type: 'string',
        description: t('tools.download.stream.params.quality')
      },
      filename: {
        type: 'string',
        description: t('tools.download.stream.params.filename')
      },
      outputPath: {
        type: 'string',
        description: '显式输出路径（CLI --output 映射；Electron 仅允许系统下载目录内路径）'
      },
      headers: {
        type: 'object',
        description: t('tools.download.stream.params.headers')
      },
      concurrency: {
        type: 'number',
        description: t('tools.download.stream.params.concurrency')
      },
      viewId: {
        type: 'string',
        description: '目标视图 ID（优先使用）'
      },
      crawlTabId: {
        type: 'string',
        description: '由 runtime 注入的 View ID（viewId 的别名，向后兼容）'
      }
    },
    required: []
  },
  async execute(input: DownloadStreamInput): Promise<DownloadStreamOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.downloadStream) {
      return standardizeLegacyResult({
        success: false,
        error: 'download_stream API not available in current runtime — use CLI: tabtin browser stream download',
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as DownloadStreamOutput
    }

    if (!input.resourceId && !input.url) {
      return standardizeLegacyResult({
        success: false,
        error: 'resourceId 或 url 至少需要提供一项',
        error_code: ToolErrorCode.INVALID_PARAMETER
      }) as unknown as DownloadStreamOutput
    }

    try {
      const result = await api.downloadStream({
        resourceId: input.resourceId,
        url: input.url,
        quality: input.quality,
        filename: input.filename,
        outputPath: input.outputPath,
        headers: input.headers,
        concurrency: input.concurrency,
        viewId: input.viewId || input.crawlTabId,
        signal: input.signal,
      })
      return standardizeLegacyResult(result) as unknown as DownloadStreamOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as DownloadStreamOutput
    }
  }
}

export const downloadBatchTool: AgentTool<DownloadBatchInput, DownloadBatchOutput> = {
  name: 'download_batch',
  description: t('tools.download.batch.description'),
  parameters: {
    type: 'object',
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: t('tools.download.batch.params.urls')
      },
      resourceIds: {
        type: 'array',
        items: { type: 'string' },
        description: '统一资源 ID 列表'
      },
      headers: {
        type: 'object',
        description: t('tools.download.batch.params.headers')
      },
      concurrency: {
        type: 'number',
        description: t('tools.download.batch.params.concurrency')
      },
      viewId: {
        type: 'string',
        description: '目标视图 ID（优先使用）'
      },
      crawlTabId: {
        type: 'string',
        description: '由 runtime 注入的 View ID（viewId 的别名，向后兼容）'
      }
    },
    required: []
  },
  async execute(input: DownloadBatchInput): Promise<DownloadBatchOutput> {
    const api = resolveResourceDetectionAPI()
    if (!api?.downloadBatch) {
      return standardizeLegacyResult({
        success: false,
        error: 'download_batch API not available in current runtime — use CLI: tabtin browser resource download-batch',
        error_code: ToolErrorCode.IPC_NOT_AVAILABLE
      }) as unknown as DownloadBatchOutput
    }

    if ((!input.urls || input.urls.length === 0) && (!input.resourceIds || input.resourceIds.length === 0)) {
      return standardizeLegacyResult({
        success: false,
        error: 'resourceIds 或 urls 至少需要提供一项',
        error_code: ToolErrorCode.INVALID_PARAMETER
      }) as unknown as DownloadBatchOutput
    }

    try {
      const result = await api.downloadBatch({
        resourceIds: input.resourceIds,
        urls: input.urls,
        headers: input.headers,
        concurrency: input.concurrency,
        viewId: input.viewId || input.crawlTabId
      })
      return standardizeLegacyResult(result) as unknown as DownloadBatchOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR
      }) as unknown as DownloadBatchOutput
    }
  }
}

export const resourceDownloadTools = [
  downloadResourceTool,
  parseM3U8Tool,
  parseStreamTool,
  downloadStreamTool,
  downloadBatchTool
]
