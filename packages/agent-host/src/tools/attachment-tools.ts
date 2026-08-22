import type {
  Tool,
  ToolContext,
  ToolResult,
} from '@tabtin/agent-runtime'
import {
  joinApiPath,
  jsonError,
  MISSING_REQUIRED_PARAM,
  RESOURCE_NOT_FOUND,
  RUNTIME_MISCONFIG,
  toJsonErrorMetadata,
  translateBackendError,
} from '@tabtin/agent-runtime/tools'

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const WORKSPACE_ATTACHMENTS_DIR = 'attachments'

export interface SaveAttachmentToWorkspaceInput {
  fileId: string
  sourceUrl: string
  filename: string
  mimeType?: string
  expectedSize?: number
  workspaceRoot: string
  abortSignal: AbortSignal
}

export interface SaveAttachmentToWorkspaceResult {
  relativePath: string
  size: number
  mimeType: string
}

export interface AttachmentToolsDeps {
  apiBaseUrl: string
  apiAuthToken?: string
  organizationId?: string
  saveToWorkspace: (
    input: SaveAttachmentToWorkspaceInput,
  ) => Promise<SaveAttachmentToWorkspaceResult>
}

interface FileDetailResponse {
  success?: boolean
  message?: string
  data?: {
    file_id?: string
    file_name?: string
    file_size?: number
    mime_type?: string
    access_url?: string
    cdn_url?: string
  } | null
}

type FileDetail = NonNullable<FileDetailResponse['data']>
type FileDetailLookup =
  | { ok: true; detail: FileDetail | null }
  | { ok: false; result: ToolResult }

const saveAttachmentInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file_id: {
      type: 'string',
      description: 'The FileRecord UUID from the uploaded attachment context.',
    },
  },
  required: ['file_id'],
} as unknown as Tool['inputSchema']

export function createAttachmentTools(deps: AttachmentToolsDeps): Tool[] {
  return [createSaveAttachmentTool(deps)]
}

function createSaveAttachmentTool(deps: AttachmentToolsDeps): Tool {
  return {
    name: 'save_attachment',
    description:
      `将 chat 已上传附件的**原始字节**保真保存到当前 Workspace 的 \`${WORKSPACE_ATTACHMENTS_DIR}/\` 目录。` +
      '用户要求打开、预览、保存或继续处理上传的 HTML/PDF/Office 等原文件时，先用本工具；' +
      '禁止根据 `<context type="attached">` 或 `parse_document` 的有损文本摘要重建文件。\n\n' +
      '保存本身只把附件放入工作目录，不会自动向用户重复展示附件。' +
      '要读取或分析图片等内容，保存后调用 `read_file`；' +
      '只有用户明确要求打开或交付原文件时，才用 `present_to_user` 的 `local_file` item。' +
      'HTML/HTM **渲染预览**（在浏览器里看页面）则调用 ' +
      '`run_terminal_command` + `tabtin browser open --url <relative_path或file://绝对路径>`，' +
      '不要用 `present_to_user` 打开 HTML 源码卡片冒充渲染预览。',
    inputSchema: saveAttachmentInputSchema,
    isReadOnly: false,
    policyActionKind: 'file',
    extractPath: () => WORKSPACE_ATTACHMENTS_DIR,
    executionTimeoutMs: 90_000,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const fileId = (input as { file_id?: unknown } | null)?.file_id
      if (typeof fileId !== 'string' || fileId.trim().length === 0) {
        return jsonError('file_id is required', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'file_id',
          hint: 'Use the exact file_id from the uploaded attachment context.',
        })
      }
      if (!context.workspaceRoot) {
        return jsonError('The current runtime has no Workspace root.', {
          error_kind: RUNTIME_MISCONFIG,
          hint: 'Open or select a Workspace before saving the attachment.',
        })
      }

      try {
        const lookup = await fetchFileDetail(deps, fileId.trim(), context.abortSignal)
        if (!lookup.ok) return lookup.result
        const detail = lookup.detail
        if (!detail) {
          return jsonError('The uploaded attachment does not exist or is no longer accessible.', {
            error_kind: RESOURCE_NOT_FOUND,
            file_id: fileId.trim(),
            hint: 'Use a file_id from the current conversation attachment context.',
          })
        }
        if (
          typeof detail.file_size === 'number'
          && detail.file_size > MAX_ATTACHMENT_BYTES
        ) {
          return jsonError('The uploaded attachment is too large to save into the Workspace.', {
            error_kind: 'file_too_large',
            file_id: fileId.trim(),
            size_bytes: detail.file_size,
            max_bytes: MAX_ATTACHMENT_BYTES,
          })
        }

        const sourceUrl = detail.cdn_url || detail.access_url
        if (!sourceUrl) {
          return jsonError('The uploaded attachment has no downloadable source URL.', {
            error_kind: RESOURCE_NOT_FOUND,
            file_id: fileId.trim(),
          })
        }

        const filename = detail.file_name || fileId.trim()
        const saved = await deps.saveToWorkspace({
          fileId: fileId.trim(),
          sourceUrl,
          filename,
          mimeType: detail.mime_type,
          expectedSize: detail.file_size,
          workspaceRoot: context.workspaceRoot,
          abortSignal: context.abortSignal,
        })

        const basename = saved.relativePath.split('/').pop() || filename
        const isHtml = isHtmlAttachment(basename, saved.mimeType)

        return {
          content: JSON.stringify({
            success: true,
            file_id: fileId.trim(),
            relative_path: saved.relativePath,
            filename: basename,
            file_size: saved.size,
            mime_type: saved.mimeType,
            ...(isHtml
              ? {
                  next_command: `tabtin browser open --url ${saved.relativePath}`,
                  hint:
                    'HTML preview uses the built-in browser. Call run_terminal_command with ' +
                    `tabtin browser open --url ${saved.relativePath} ` +
                    '(Workspace-relative path or file:// absolute path under the Workspace). ' +
                    'Do NOT use present_to_user local_file for rendered HTML preview — it opens the source/file card.',
                }
              : {
                  next_tool: 'read_file',
                  hint:
                    'Use read_file with relative_path to inspect or analyze the attachment. ' +
                    'Only call present_to_user when the user explicitly asks to open or receive the original file.',
                }),
          }),
        }
      } catch (error) {
        const translated = translateBackendError({
          error,
          toolName: 'save_attachment',
          operation: 'uploaded attachment save',
          fallbackMessage: 'The uploaded attachment could not be saved into the Workspace.',
        })
        return jsonError(translated.message, toJsonErrorMetadata(translated))
      }
    },
  }
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.')
  if (idx < 0) return ''
  return filename.slice(idx).toLowerCase()
}

function isHtmlAttachment(filename: string, mimeType?: string): boolean {
  if (HTML_EXTENSIONS.has(extensionOf(filename))) return true
  return typeof mimeType === 'string' && mimeType.toLowerCase().includes('text/html')
}

async function fetchFileDetail(
  deps: AttachmentToolsDeps,
  fileId: string,
  abortSignal: AbortSignal,
): Promise<FileDetailLookup> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.apiAuthToken) headers.Authorization = `Bearer ${deps.apiAuthToken}`
  if (deps.organizationId) headers['X-TabTin-Organization-Id'] = deps.organizationId

  const response = await fetch(
    joinApiPath(deps.apiBaseUrl, `/services/oss/files/${encodeURIComponent(fileId)}`),
    {
      headers,
      signal: AbortSignal.any([abortSignal, AbortSignal.timeout(30_000)]),
    },
  )
  const body = await response.json().catch(() => null) as FileDetailResponse | null
  if (!response.ok) {
    const translated = translateBackendError({
      status: response.status,
      body,
      toolName: 'save_attachment',
      operation: 'uploaded attachment metadata read',
      fallbackMessage: 'The uploaded attachment metadata could not be loaded.',
    })
    return {
      ok: false,
      result: jsonError(translated.message, toJsonErrorMetadata(translated)),
    }
  }
  return {
    ok: true,
    detail: body?.success && body.data ? body.data : null,
  }
}
