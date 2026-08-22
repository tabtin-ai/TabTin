import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import { createShowWidgetTool, type BakeAndUploadFn } from './show-widget.js'
import { jsonError } from '../capability/core/_utils.js'
import {
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  NO_UI_SESSION,
} from '../engine/errors/error-kinds.js'
import {
  buildLocalFileArtifactBlock,
  statLocalFileArtifact,
  type BuildArtifactUrl,
} from '../capability/core/local-file-artifact.js'

// ─── Schema ──────────────────────────────────────────────────────────

const presentToUserInputSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        // 字段 desc 只留硬契约；别名归一化细节见工具说明 / jsonError hint。
        // P3：勿写英文词 description，语言检测会判 mixed。
        description: '单项；字段约定见本工具说明。',
      },
      minItems: 1,
      // 阶段 6.6 议题 3 翻译：保留 kind 类型字面量。
      description: '要展示的内容块数组。kind：`image` / `table_preview` / `resource_ref` / `file` / `local_file`。',
    },
    summary: { type: 'string', description: '展示内容的简短文本摘要。' },
    title: { type: 'string', description: '可选的内容块标题。' },
  },
  required: ['items', 'summary'],
} as unknown as Tool['inputSchema']

// ─── Factory ─────────────────────────────────────────────────────────

export interface PresentationToolsDeps {
  emitStreamEvent?: (event: StreamEvent) => void
  /**
   * ** RB1**：host 装配期烘进的 per-runtime organizationId，透传给
   * `show_widget` 的烤图 OSS 上传（见 ShowWidgetToolDeps.organizationId）。
   */
  organizationId?: string
  /**
   * 宿主注入的可展示资源类型全集。`resource_ref` 校验用此集合判定合法
   * resource_type——runtime 不内置具体产品资源名。
   */
  supportedResourceTypes: ReadonlySet<string>
  /**
   * 宿主注入的 auto_open 策略：给定 resource_type 返回是否在 Space 工作区自动打开。
   */
  autoOpenPolicy: (resourceType: string) => boolean
  /** 当前执行 Workspace，用于标明 resource_ref 的真实归属。 */
  spaceId?: string
  /**
   * 透传给 `show_widget` 的烤图 + OSS 上传回调（见 ShowWidgetToolDeps.bakeAndUpload）。
   */
  bakeAndUpload?: BakeAndUploadFn
  /** 本地文件交付：由工作目录相对路径构造 artifact 打开 URL。 */
  buildLocalFileArtifactUrl?: BuildArtifactUrl
}

export function createPresentationTools(deps: PresentationToolsDeps): Tool[] {
  // Widget Wave 2：show_widget 与 present_to_user 同属"展示"语义簇，挂在
  // 同一个 factory 下。这样 Electron / Daemon ToolProvider（widget 项目无权
  // 直接修改）继续调 createPresentationTools 就自动拿到 widget 工具——
  // 别人 wiring 文件 0 改动，避免触发"修了 ElectronToolProvider 跟别人
  // 项目冲突"的工作树污染。
  return [createPresentToUserTool(deps), createShowWidgetTool(deps)]
}

// ─── present_to_user ─────────────────────────────────────────────────

function readStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readObjectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeResourceRefItem(item: Record<string, unknown>): Record<string, unknown> {
  const metadata = readObjectField(item.metadata)
  const resourceType =
    readStringField(item.resource_type) ??
    readStringField(metadata?.resource_type) ??
    readStringField(metadata?.type)
  const resourceId =
    readStringField(item.resource_id) ??
    readStringField(item.ref)

  return {
    ...item,
    ...(resourceType ? { resource_type: resourceType } : {}),
    ...(resourceId ? { resource_id: resourceId } : {}),
  }
}

function normalizeImageItem(item: Record<string, unknown>): Record<string, unknown> {
  const raw = readStringField(item.url) ?? readStringField(item.image_url)
  const url = raw ? unescapeJsonUrlEscapes(raw) : undefined
  return {
    ...item,
    ...(url ? { url } : {}),
  }
}

/** LLM 常从 JSON stdout 抄出字面量 `\u0026`，浏览器无法加载，还原为 `&`。 */
function unescapeJsonUrlEscapes(url: string): string {
  return url.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

interface PresentItemValidationResult {
  item?: Record<string, unknown>
  error?: string
}

function createPresentToUserTool(deps: PresentationToolsDeps): Tool {
  const SUPPORTED_KINDS = new Set(['image', 'table_preview', 'resource_ref', 'file', 'local_file'])
  const MAX_TABLE_ROWS = 200

  return {
    name: 'present_to_user',
    policyActionKind: 'object_read',
    // P2 字符预算 ≤500（low-risk）：教学细节（别名形态 / 平台 CLI 禁令展开）
    // 下沉到 jsonError hint / skill，description 只留硬契约。
    description:
      '把结构化富内容以交互 UI 块展示给用户。' +
      'item.kind 仅限 image / table_preview / resource_ref / file / local_file。' +
      'image：{kind,url,summary}（image_url 别名会规范化）。' +
      'local_file：{kind,relative_path,summary?}，用于交付工作目录内已存在文件；只接受相对路径。' +
      'resource_ref：{kind,resource_type,resource_id,summary}（兼容 ref+metadata.type）；出卡时尝试在 Space 打开。' +
      '**禁止**对刚生成的 AI 图再调本工具（有 UI 时客户端已自动展示，重复会双图/加载失败）。' +
      '自由形态可视化走 show_widget；需后续编辑的表/文档走平台创建工具。',
    inputSchema: presentToUserInputSchema,
    isReadOnly: true,
    disablePreStart: true,
    isWriteOp: (input: unknown): boolean => containsLocalFilePresentItem(input),
    extractPolicyParams: (input: unknown): Record<string, unknown> => {
      const path = firstLocalFileRelativePath(input)
      return path ? { relative_path: path, path } : {}
    },
    isConcurrencySafe: (input: unknown): boolean => !containsLocalFilePresentItem(input),
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = input as {
        items: Array<Record<string, unknown>>
        summary: string
        title?: string
      }

      if (!params.items || !Array.isArray(params.items) || params.items.length === 0) {
        return jsonError('items array is required and cannot be empty', {
          error_kind: MISSING_REQUIRED_PARAM,
          hint: 'Pass at least one presentable item with a supported kind and summary.',
        })
      }

      const accepted: Array<Record<string, unknown>> = []
      const errors: string[] = []

      for (let i = 0; i < params.items.length; i++) {
        const validation = await validatePresentItem({
          item: params.items[i],
          index: i,
          summary: params.summary,
          supportedKinds: SUPPORTED_KINDS,
          supportedResourceTypes: deps.supportedResourceTypes,
          maxTableRows: MAX_TABLE_ROWS,
          workspaceRoot: context.workspaceRoot,
          buildLocalFileArtifactUrl: deps.buildLocalFileArtifactUrl,
        })
        if (validation.error) errors.push(validation.error)
        if (validation.item) accepted.push(validation.item)
      }

      if (accepted.length === 0) {
        return jsonError(
          // 多条 item 全部 invalid 时把列表化错误塞 message —— LLM 能从 message
          // 一行看到全部失败原因；errors 数组也透传到 metadata 方便前端展开。
          `All ${params.items.length} item(s) failed validation: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? `; (+${errors.length - 3} more)` : ''}`,
          {
            error_kind: INVALID_PARAM_FORMAT,
            errors,
            hint: 'Fix each item to use a supported kind and required fields, or use show_widget for free-form visual content.',
          },
        )
      }

      // Wave 2: 走 ToolContext.emitRichContentBlock 拼 ContentBlock 三件套。
      // present_to_user 的 items 是同一逻辑组（共享 title / summary），用 groupId 关联，
      // 让 UI 可以把多条 block 聚合成一个 panel 渲染。groupId 用 tool_call_id 兜底——
      // 同一次 present_to_user 调用产出的所有 block 共用 group。
      const emitRich = context.emitRichContentBlock
      if (!emitRich) {
        return jsonError(
          'present_to_user requires a connected UI session. Rich content cannot be delivered in headless mode.',
          {
            error_kind: NO_UI_SESSION,
            hint: 'Do not call present_to_user in headless mode; summarize the content in plain text instead.',
          },
        )
      }

      const groupId = `present_to_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      for (const item of accepted) {
        emitPresentItem(emitRich, item, params, groupId, deps.spaceId)
      }

      const result: Record<string, unknown> = {
        success: true,
        accepted: accepted.length,
        summary: params.summary,
        llm_message:
          `Presented ${accepted.length} rich content block(s) to the user. ` +
          'The user can see the accepted content now. Continue with the next step. Do not call present_to_user again with the same items unless the user asks for changes.',
        _blocks: accepted,
        _title: params.title,
      }

      if (errors.length > 0) {
        result.partial_errors = errors
        result.llm_message =
          `Presented ${accepted.length} rich content block(s) to the user. ` +
          `Some items were not presented: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? `; (+${errors.length - 3} more)` : ''}. ` +
          'Continue with the accepted content and fix invalid items only if needed.'
      }

      return {
        content: JSON.stringify(result),
        llmStripKeys: ['_blocks', '_title'],
      }
    },
  }
}

function containsLocalFilePresentItem(input: unknown): boolean {
  return firstLocalFileRelativePath(input) !== undefined
}

function firstLocalFileRelativePath(input: unknown): string | undefined {
  const items = (input as { items?: unknown })?.items
  if (!Array.isArray(items)) return undefined
  for (const item of items) {
    const candidate = item as { kind?: unknown; relative_path?: unknown }
    if (candidate.kind === 'local_file' && typeof candidate.relative_path === 'string') {
      const relativePath = candidate.relative_path.trim()
      if (relativePath.length > 0) return relativePath
    }
  }
  return undefined
}

async function validatePresentItem(args: {
  item: Record<string, unknown>
  index: number
  summary: string
  supportedKinds: Set<string>
  supportedResourceTypes: ReadonlySet<string>
  maxTableRows: number
  workspaceRoot?: string
  buildLocalFileArtifactUrl?: BuildArtifactUrl
}): Promise<PresentItemValidationResult> {
  let item = args.item
  const kind = item.kind as string | undefined
  if (!kind || !args.supportedKinds.has(kind)) {
    return { error: `Item ${args.index}: invalid kind "${kind}". Must be one of: ${[...args.supportedKinds].join(', ')}` }
  }

  if (kind === 'image') {
    item = normalizeImageItem(item)
  }

  const urlError = validatePresentItemUrl(item, kind, args.index)
  if (urlError) return { error: urlError }

  const tableError = validateTablePreviewItem(item, kind, args.index, args.maxTableRows)
  if (tableError) return { error: tableError }

  if (kind === 'local_file') {
    const localFileResult = await validateLocalFileItem(
      item,
      args.index,
      args.workspaceRoot,
      args.buildLocalFileArtifactUrl,
    )
    if (localFileResult.error) return { error: localFileResult.error }
    item = localFileResult.item!
  }

  if (kind === 'resource_ref') {
    item = normalizeResourceRefItem(item)
    const refError = validateResourceRefItem(item, args.index, args.supportedResourceTypes)
    if (refError) return { error: refError }
  }

  if (!item.summary || (typeof item.summary === 'string' && item.summary.trim() === '')) {
    item.summary = args.summary
  }
  return { item }
}

async function validateLocalFileItem(
  item: Record<string, unknown>,
  index: number,
  workspaceRoot: string | undefined,
  buildLocalFileArtifactUrl: BuildArtifactUrl | undefined,
): Promise<PresentItemValidationResult> {
  if (!buildLocalFileArtifactUrl) {
    return { error: `Item ${index}: local_file is unavailable in this runtime` }
  }

  const target = await statLocalFileArtifact(workspaceRoot, item.relative_path)
  if (!target.ok) {
    return { error: `Item ${index}: ${target.error}` }
  }

  const block = buildLocalFileArtifactBlock({
    fileType: target.fileType,
    mimeType: target.mimeType,
    relativePath: target.relativePath,
    fileSize: target.fileSize,
    buildUrl: buildLocalFileArtifactUrl,
    summary: item.summary as string | undefined,
    selfCheckSummary: item.self_check_summary as string | undefined,
    autoRegister: true,
    autoOpen: item.open_behavior === 'silent' ? false : true,
  })

  return {
    item: {
      kind: 'local_file',
      summary: block.summary,
      __local_file_block: block,
    },
  }
}

function validatePresentItemUrl(
  item: Record<string, unknown>,
  kind: string,
  index: number,
): string | undefined {
  if (kind !== 'image' && kind !== 'file') return undefined
  if (kind === 'image' && typeof item.url !== 'string') {
    return `Item ${index}: image requires url (or alias image_url)`
  }
  if (typeof item.url !== 'string') return undefined
  const url = item.url
  const isSecure = url.startsWith('https://')
  const isLocalDev = url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')
  return isSecure || isLocalDev
    ? undefined
    : `Item ${index}: url must use https:// (or http://localhost for development)`
}

function validateTablePreviewItem(
  item: Record<string, unknown>,
  kind: string,
  index: number,
  maxTableRows: number,
): string | undefined {
  if (kind !== 'table_preview') return undefined
  if (!Array.isArray(item.columns)) return `Item ${index}: table_preview requires columns array`
  if (Array.isArray(item.rows) && item.rows.length > maxTableRows) {
    item.rows = (item.rows as unknown[]).slice(0, maxTableRows)
  }
  return undefined
}

function validateResourceRefItem(
  item: Record<string, unknown>,
  index: number,
  supportedResourceTypes: ReadonlySet<string>,
): string | undefined {
  const rt = item.resource_type as string | undefined
  if (!rt || !supportedResourceTypes.has(rt)) {
    return (
      `Item ${index}: invalid resource_type "${rt}". ` +
      `For resource_ref, use { kind: "resource_ref", resource_type: "table", resource_id: "<tableId>", summary: "..." }. ` +
      `If you already have { ref, metadata: { type } }, it will be normalized. Supported resource_type: ${[...supportedResourceTypes].join(', ')}`
    )
  }
  if (!item.resource_id) {
    return (
      `Item ${index}: resource_ref requires resource_id (or alias ref). ` +
      `Example: { kind: "resource_ref", resource_type: "table", resource_id: "<tableId>", summary: "Imported table" }`
    )
  }
  return undefined
}

function makePresentAutoOpenToken(): string {
  return `present-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function emitPresentItem(
  emitRich: NonNullable<ToolContext['emitRichContentBlock']>,
  item: Record<string, unknown>,
  params: { summary: string; title?: string },
  groupId: string,
  resourceSpaceId?: string,
): void {
  const kind = (item.kind as
    | 'image' | 'table_preview' | 'resource_ref' | 'file' | 'local_file' | 'widget'
    | 'cli_output_table' | 'cli_output_record' | 'search_results'
    | 'memory_card' | 'document_excerpt')
  const summary = typeof item.summary === 'string' && item.summary.length > 0
    ? item.summary
    : params.summary
  if (kind === 'local_file') {
    const block = item.__local_file_block as
      | { kind: 'file'; summary: string; payload: Record<string, unknown> }
      | undefined
    if (block) {
      emitRich({
        kind: block.kind,
        summary: block.summary,
        groupId,
        payload: {
          ...block.payload,
          ...(params.title ? { title: params.title } : {}),
        },
      })
    }
    return
  }
  const { kind: _kindStripped, summary: _summaryStripped, ...payloadRest } = item as {
    kind?: unknown; summary?: unknown; [k: string]: unknown
  }
  void _kindStripped; void _summaryStripped
  // auto_open 由宿主注入的 autoOpenPolicy 决策——runtime 不内置具体产品资源特判。
  const resourceType = kind === 'resource_ref'
    ? (readStringField(payloadRest.resource_type)
      ?? readStringField((payloadRest.metadata as Record<string, unknown> | undefined)?.type))
    : undefined
  const shouldRegister = kind === 'resource_ref' && resourceType !== 'slide'
  const shouldAutoOpen =
    shouldRegister &&
    (payloadRest.open_behavior === 'focus' || payloadRest.auto_open === true)
  emitRich({
    kind,
    summary,
    groupId,
    payload: {
      ...payloadRest,
      ...(params.title ? { title: params.title } : {}),
      ...(kind === 'resource_ref' && resourceSpaceId && !payloadRest.space_id
        ? { space_id: resourceSpaceId }
        : {}),
      // 显式交付物默认只登记到任务标签，不抢焦点；只有明确 focus 才自动展开。
      ...(shouldRegister
        ? { auto_register: true, auto_register_token: makePresentAutoOpenToken() }
        : {}),
      ...(shouldAutoOpen
        ? { auto_open: true, auto_open_token: makePresentAutoOpenToken() }
        : {}),
    },
  })
}
