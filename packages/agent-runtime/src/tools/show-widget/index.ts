/**
 * 重构来源：packages/agent-runtime/src/tools/show-widget.ts（行 1-48、52-137、316-322、435-711）
 * 拆分时间：2026-04-30
 * 重构原因：show-widget.ts 711 行单文件过大，按职责拆分
 * 职责：show_widget 工具 factory 主干 —— schema / 类型 / 工具入口 `createShowWidgetTool`
 *       + execute 主体（校验 + prepare 分派 + emit RICH_CONTENT + 烤图 + OSS 上传）。
 *       实现依赖：
 *         - ./sanitizer              （不直接导入，供 mermaid-compiler 内部调用）
 *         - ./mermaid-compiler       （prepareWidgetSource / PreparedWidgetSource / WidgetFormat）
 *         - ./tool-call-id-finder    （findToolCallIdHeuristically / __resetShowWidgetUsedRefsForTests）
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 *
 * 原文件顶部设计文档注释（必须原样保留，供后续维护者理解 Wave 2/2.5/4/6 决策脉络）：
 *
 * ─────────────────────────────────────────────────────────────────────
 * show_widget — Widget Wave 2 工具（widget RFC §三 3.1 / §四 4.1）。
 *
 * 业务目标：让 Agent 在对话里 emit "可视化 widget"（SVG / HTML / Mermaid），
 * LLM 边吐 widget source token，前端 sandbox iframe 边流式更新——这是
 * widget 项目用户第一次能感知到差异的 Wave。
 *
 * 与 `present_to_user` 是**互补**关系：
 *   - `present_to_user`：4 类预定义 kind（image / table_preview / resource_ref / file），受限 schema
 *   - `show_widget`：自由 SVG / HTML 代码，最终落 `RichContentBlock { kind: 'widget' }`
 *
 * 当前范围（Wave 2 → Wave 7 全部 Done 的产品形态）：
 *   1. SVG / HTML / Mermaid 三格式流式渲染（chat 内 sandbox iframe + srcdoc + 严 CSP）
 *   2. 工具 execute() emit RICH_CONTENT block 含 code + image_url：
 *      - Wave 4 烤图链路通了（见 ./bake-upload.ts）——Electron 走 OffscreenWindowPool
 *        loadFile 临时 HTML + capturePage；Daemon 走 page.setContent + page.screenshot；
 *        结果上传 OSS 拿 https url 写进 image_url 字段
 *      - 烤图失败时 image_url 为空字符串（不是 undefined，让移动端显式判"失败"而非"未到"）
 *   3. 移动端拉历史显示 image_url（Wave 4），失败时回落 summary 文字
 *   4. Wave 6 落地 HTML(no-script) + Mermaid 编译时转 SVG（见 ./mermaid-compiler.ts）
 *   5. Wave 7 落地 sendPrompt 完整版（wrapper 注入 `window.sendPrompt`、
 *      trusted gesture 窗口、频次限制、audit log——见 packages/widget-tokens/src/wrapper.ts
 *      的 buildSendPromptBootstrap + apps/tabtin-electron/.../widgetSendPromptHandler.ts）
 *
 * 关键防线（widget RFC §七 🔴 高严重度）：
 *   - **`isReadOnly: false`**：防 preStartedTools 在 LLM 流式期间提前 execute 烤脏图。
 *     真正决定"流式 tool_use 到达时是否进入 preStartedTools 池"的判断在
 *     `query.ts` 的 tool_use 流式处理分支：`preStartCandidate?.isReadOnly && !preStartCandidate.disablePreStart`
 *     —— `isReadOnly=true` 才会被预启动。widget 工具天生不是 idempotent read
 *     （emit 状态变更事件 + 持久化），必须 `isReadOnly: false`。
 *     （`tool-orchestration.ts` 的 `isConcurrencySafe` 也读 `isReadOnly`，但那是
 *     并发批次划分语义，与 preStart 是不同代码路径——技术 Review 提醒避免行号张冠李戴。）
 *     配套测试见 show-widget.test.ts。
 *   - **`llmStripKeys: ['_block']`**：巨型 SVG（5KB+）回流到 LLM next-turn
 *     history 会浪费 context。`_block` 只在前端持久化路径上有用（blocks_json
 *     由独立 RICH_CONTENT 事件驱动，不依赖 result.content），LLM 看 success +
 *     widget_id + summary 就够。
 *     **历史教训**：v1 用 dotted path `['_block.code', '_block.image_url']`，
 *     `stripKeysFromResult` (engine/tool-system.ts) 的实现只支持顶层 key，
 *     dotted path 默默 no-op，整个 5KB SVG 全部回流 LLM history——技术 review
 *     发现的真 P0 bug。修法：把整个 `_block` 标 strip（与 `present_to_user`
 *     用 `['_blocks', '_title']` 顶层路径一致）。
 *
 * 流式协议（与 Wave 1 `tool_call_args_delta` 配套）：
 *   - LLM 流式吐 args delta → query.ts emit `agent.stream.tool_call_args_delta`
 *     → 前端 toolCallArgsDeltaHandler 累积到 in-memory buffer
 *     → RichWidget 子组件 subscribe buffer 流式更新 iframe srcdoc
 *   - tool 真正 execute 时 emit RICH_CONTENT 进 blocks_json 持久化
 *   - 流式中间态**不**进 blocks_json（关注点分离，避免半截垃圾）
 * ─────────────────────────────────────────────────────────────────────
 */

import type {
  StreamEvent,
} from '../../engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../../engine/contracts/tools.js';
import {
  prepareWidgetSource,
  type PreparedWidgetSource,
  type WidgetFormat,
} from './mermaid-compiler.js'
import { findToolCallIdHeuristically } from './tool-call-id-finder.js'
import type { BakeAndUploadFn } from './bake-upload.js'
import { jsonError } from '../../capability/core/_utils.js'
import {
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  NO_UI_SESSION,
  PARAM_TOO_LARGE,
  WIDGET_RENDER_FAILED,
} from '../../engine/errors/error-kinds.js'

// Re-export 测试出口：show-widget.test.ts / show-widget-wave4.test.ts 需要能在
// beforeEach 调 __resetShowWidgetUsedRefsForTests 清跨测试残留的 WeakSet 状态。
// barrel（../show-widget.ts）通过 `export *` 透传本 re-export。
export { __resetShowWidgetUsedRefsForTests } from './tool-call-id-finder.js'
export type { BakeAndUploadFn, BakeAndUploadResult, BakeWidgetInput } from './bake-upload.js'

// ─── Schema ──────────────────────────────────────────────────────────

const SUPPORTED_FORMATS = new Set<string>(['svg', 'html', 'mermaid'])

/** 单条 widget code 上限（与 RFC §七风险登记"超长 widget code 拒绝（限制 8KB）"对齐）。 */
const MAX_CODE_BYTES = 8 * 1024

// **字段顺序很重要**（Wave 2.5 自修复：产品 Review P1-4）：
//   - LLM 倾向按 `properties` object key 声明顺序输出 tool_use args（OpenAI/
//     Anthropic 流式输出大致遵循 schema 顺序）
//   - `loading_message` 必须在 `code` **之前** —— 这样 LLM 流式吐 args 时先吐完
//     `loading_message`，RichWidget 在 partial 期间从 buffer 提取 loading_message
//     显示给用户；待 `code` 字段开始流入时再切到 SVG 流式渲染
//   - 旧顺序（loading_message 在 code 之后）让 Agent 自定义 loading_message 永远
//     被 SVG iframe 显示覆盖，"自定义文案"功能事实上失效
// 阶段 6.6 议题 3 翻译 + 瘦身：保留 SVG / HTML / Mermaid 缩写 + tag 引用，
// 自然语言翻译成中文；format / loading_message / code 同步瘦身。
const showWidgetInputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '可选标题，显示在画布上方。' },
    summary: {
      type: 'string',
      description: '必填。移动端兜底与无障碍标签用的人类可读摘要。',
    },
    format: {
      type: 'string',
      enum: ['svg', 'html', 'mermaid'],
      description:
        '格式。`svg`：自由绘图；`html`：静态无脚本 UI；`mermaid`：流程图等（编译为 SVG）。',
    },
    loading_message: {
      type: 'string',
      description:
        // 必须在 `code` 之前流式吐出，详见 showWidgetInputSchema 上方注释。
        '流式生成源码时的占位文案；须在 `code` **之前**流出，否则会被画布覆盖。',
    },
    code: {
      type: 'string',
      description:
        '源码。SVG：完整 `<svg>` 含 `viewBox`。HTML：静态片段，禁 `<script>`/`<iframe>`/`<object>`/`<embed>`/`<form>`。Mermaid：编译为 SVG。',
    },
    group_id: {
      type: 'string',
      description: '可选分组标识，多 widget 聚到一张卡。',
    },
    group_title: {
      type: 'string',
      description: '可选分组标题。',
    },
  },
  required: ['summary', 'format', 'code'],
} as unknown as Tool['inputSchema']

// ─── Factory ─────────────────────────────────────────────────────────

export interface ShowWidgetToolDeps {
  emitStreamEvent?: (event: StreamEvent) => void
  /**
   * ** RB1**：host 在装配 ToolProvider 时烘进的 per-runtime organizationId。
   * 烤图上传 OSS 时按此归属，不再从运行时 `ToolContext` 读 organizationId
   * （切 Space 会重建 runtime，故为常量，可安全烘焙）。
   */
  organizationId?: string
  /**
   * ** 批4**：宿主注入的烤图 + OSS 上传回调。runtime 不再直连
   * 业务包做 offscreen 渲染 / theme 解析 / OSS 上传；未注入时 image_url 留空
   * （桌面端 iframe 仍可渲染 widget，移动端走 summary fallback）。
   */
  bakeAndUpload?: BakeAndUploadFn
}

interface ShowWidgetInput {
  title?: string
  summary: string
  format: string
  code: string
  loading_message?: string
  group_id?: string
  group_title?: string
}

/**
 * Generates a deterministic-enough widget id when caller does not supply one.
 * Format: `wgt_<base36 timestamp>_<6-char random>`.
 */
function generateWidgetId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `wgt_${ts}_${rand}`
}

function validateShowWidgetInput(
  input: unknown,
): { ok: true; params: Partial<ShowWidgetInput>; summary: string; format: string; code: string; codeBytes: number } | { ok: false; result: ToolResult } {
  const params = input as Partial<ShowWidgetInput> | null
  if (!params || typeof params !== 'object') {
    return {
      ok: false,
      result: jsonError('show_widget requires an object input', {
        error_kind: INVALID_PARAM_FORMAT,
        hint: 'Call show_widget with an object containing summary, format, and code.',
      }),
    }
  }
  const summary = typeof params.summary === 'string' ? params.summary.trim() : ''
  const format = typeof params.format === 'string' ? params.format : ''
  const code = typeof params.code === 'string' ? params.code : ''
  if (!summary) return { ok: false, result: missingWidgetSummaryResult() }
  if (!SUPPORTED_FORMATS.has(format)) return { ok: false, result: unsupportedWidgetFormatResult(format) }
  if (!code) return { ok: false, result: missingWidgetCodeResult() }
  const codeBytes = new TextEncoder().encode(code).length
  if (codeBytes > MAX_CODE_BYTES) return { ok: false, result: widgetCodeTooLargeResult(codeBytes) }
  return { ok: true, params, summary, format, code, codeBytes }
}

function missingWidgetSummaryResult(): ToolResult {
  return jsonError(
    'summary is required (used as mobile fallback + accessibility label)',
    {
      error_kind: MISSING_REQUIRED_PARAM,
      field: 'summary',
      hint: 'Provide a short summary that describes the widget for fallback display and accessibility.',
    },
  )
}

function unsupportedWidgetFormatResult(format: string): ToolResult {
  return jsonError(
    `unsupported format "${format}". Supported formats: ${[...SUPPORTED_FORMATS].join(', ')}.`,
    {
      error_kind: INVALID_PARAM_FORMAT,
      field: 'format',
      supported: [...SUPPORTED_FORMATS],
      hint: 'Use one of the supported widget formats and convert the source if needed.',
    },
  )
}

function missingWidgetCodeResult(): ToolResult {
  return jsonError('code is required: SVG, HTML, or Mermaid source', {
    error_kind: MISSING_REQUIRED_PARAM,
    field: 'code',
    hint: 'Provide the complete SVG, HTML, or Mermaid source in code.',
  })
}

function widgetCodeTooLargeResult(codeBytes: number): ToolResult {
  return jsonError(
    `widget code too large: ${codeBytes} bytes > ${MAX_CODE_BYTES} bytes (8KB cap). ` +
      'Split into multiple widgets or simplify the source.',
    {
      error_kind: PARAM_TOO_LARGE,
      field: 'code',
      size: codeBytes,
      limit: MAX_CODE_BYTES,
      hint: 'Simplify the widget source or split the content into multiple smaller widgets.',
    },
  )
}

async function prepareWidgetOrError(format: string, code: string): Promise<
  | { ok: true; prepared: PreparedWidgetSource }
  | { ok: false; result: ToolResult }
> {
  try {
    return { ok: true, prepared: await prepareWidgetSource(format as WidgetFormat, code) }
  } catch (err) {
    // 把真实编译/校验异常放进 error，让 LLM 能自修复；不再吞成空话。
    const rawRenderError = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      result: jsonError(rawRenderError, {
        error_kind: WIDGET_RENDER_FAILED,
        format,
        hint: 'Fix the widget source for the selected format, then call show_widget again with valid code.',
      }),
    }
  }
}

function buildWidgetPayload(args: {
  widgetId: string
  prepared: PreparedWidgetSource
  format: string
  imageUrl: string
  toolCallId: string | undefined
  params: Partial<ShowWidgetInput>
}): Record<string, unknown> {
  const widgetPayload: Record<string, unknown> = {
    widget_id: args.widgetId,
    format: args.format,
    code: args.prepared.renderCode,
    image_url: args.imageUrl,
  }
  if (args.toolCallId) widgetPayload.tool_call_id = args.toolCallId
  if (args.params.title) widgetPayload.title = args.params.title
  if (args.params.loading_message) widgetPayload.loading_message = args.params.loading_message
  if (args.params.group_id) widgetPayload.group_id = args.params.group_id
  if (args.params.group_title) widgetPayload.group_title = args.params.group_title
  if (args.prepared.sourceCode) {
    widgetPayload.source_code = args.prepared.sourceCode
    widgetPayload.mermaid_source = args.prepared.sourceCode
    widgetPayload.rendered_code = args.prepared.renderCode
  }
  return widgetPayload
}

function buildWidgetToolResult(args: {
  widgetId: string
  summary: string
  format: string
  codeBytes: number
  widgetPayload: Record<string, unknown>
  bakingError: string | undefined
  bakedImagePath: string | undefined
}): ToolResult {
  const block: Record<string, unknown> = {
    type: 'tabtin_rich_content',
    kind: 'widget',
    summary: args.summary,
    ...args.widgetPayload,
  }
  const result: Record<string, unknown> = {
    success: true,
    widget_id: args.widgetId,
    summary: args.summary,
    llm_message:
      `Widget rendered successfully (${args.format}, ${args.codeBytes} bytes). ` +
      'The user can see it inline now. Continue with the next step. Do not call show_widget again with the same widget unless the user asks for changes.',
    _block: block,
  }
  appendWidgetBakeOutcome(result, args.bakingError, args.bakedImagePath)
  return {
    content: JSON.stringify(result),
    llmStripKeys: ['_block'],
  }
}

function appendWidgetBakeOutcome(
  result: Record<string, unknown>,
  bakingError: string | undefined,
  bakedImagePath: string | undefined,
): void {
  if (bakingError) {
    result._mobile_fallback_unavailable = bakingError
    result._mobile_fallback_note =
      'Widget rendered successfully on desktop (iframe). Static fallback image upload failed; ' +
      'mobile users may see a placeholder with summary instead of the live widget. ' +
      'This is a non-critical infrastructure issue — DO NOT retry the widget, DO NOT apologize ' +
      'to the user, DO NOT provide a text fallback. The widget is functional. Continue with ' +
      'the original conversation flow.'
    result.llm_message = result._mobile_fallback_note
  }
  if (bakedImagePath) result.output_path = bakedImagePath
}

export function createShowWidgetTool(deps: ShowWidgetToolDeps): Tool {
  return {
    name: 'show_widget',
    policyActionKind: 'object_read',
    description:
      '在 chat 里渲染内联视觉 widget（架构图、流程图、状态卡片、对比视图），从 LLM token 流式生成。' +
      '**用途**：自由形态 svg / html / mermaid 可视化；空间化表达比文字更清晰时。' +
      '画前读 canonical skill `platform:visualization/tabtin-widget`。' +
      '**不是**：image / table_preview / resource_ref / file 四类预定义展示块。' +
      '必填：`summary`（移动端 fallback / a11y）、`format: "svg" | "html" | "mermaid"`、`code`。',
    inputSchema: showWidgetInputSchema,
    /**
     * Widget Wave 2 — RFC §七 🔴 high-severity defence.
     *
     * **Must remain `false`**: the `query.ts` tool_use streaming branch
     * (`preStartCandidate?.isReadOnly && !preStartCandidate.disablePreStart`)
     * lets `isReadOnly: true` tools enter the `preStartedTools` pool —
     * they would be triggered while the LLM is still streaming args.
     * show_widget would then capture the **partial SVG** mid-stream and
     * persist a half-baked image. Keep this flag explicit; the accompanying
     * unit test `show-widget.test.ts` asserts it.
     */
    isReadOnly: false,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const validated = validateShowWidgetInput(input)
      if (!validated.ok) return validated.result
      const { params, summary, format, code, codeBytes } = validated

      const preparedResult = await prepareWidgetOrError(format, code)
      if (!preparedResult.ok) return preparedResult.result
      const { prepared } = preparedResult

      // Wave 2: 走 ToolContext.emitRichContentBlock 拼 ContentBlock 三件套。
      // 同时 deps.emitStreamEvent 这条 fallback 路径在新协议下需要工具自己拼 envelope，
      // 太复杂；W2 简化：show_widget **强制要求** ToolContext 注入 emitRichContentBlock，
      // 否则按"无 UI session"失败。daemon / electron 都已经在 query.ts 把 helper 注入进来。
      const emitRich = context.emitRichContentBlock
      if (!emitRich) {
        return jsonError(
          'show_widget requires a connected UI session. Widgets cannot be delivered in headless mode.',
          {
            error_kind: NO_UI_SESSION,
            hint: 'Do not call show_widget in headless mode; describe the visual output in plain text instead.',
          },
        )
      }

      const widgetId = generateWidgetId()

      // Widget Wave 2.5：启发式找 toolCallId 让前端能把 placeholder 替换成
      // final block。找不到也不阻塞 emit——前端 fallback 到 append 路径。
      const toolCallId = findToolCallIdHeuristically(context.messages, code)

      // Widget Wave 4 烤图 + OSS 上传链路 —— 由宿主注入的 deps.bakeAndUpload 实现
      // （ 批4）。回调返回 { imageUrl, bakingError, bakedImagePath }；
      // 烤图失败时 imageUrl 为空字符串，走移动端 fallback（见下方 block.image_url 契约注释）。
      // 未注入烤图通道时同样 imageUrl 留空——桌面端 iframe 不依赖烤图产物。
      // organizationId 由 host 在装配期烘进 deps（ RB1），透传到 OSS 上传。
      const { imageUrl, bakingError, bakedImagePath } = deps.bakeAndUpload
        ? await deps.bakeAndUpload({
            widgetId,
            renderCode: prepared.renderCode,
            renderFormat: prepared.renderFormat,
            organizationId: deps.organizationId,
          })
        : { imageUrl: '', bakingError: 'widget bake channel not injected', bakedImagePath: undefined }

      // Wave 4：emit final tabtin_rich_content (kind='widget') 含 image_url（成功时）
      // 或空字符串（失败兜底）。**契约**：image_url 为空字符串 / 缺失字段 ＝ 烤图失败
      // ——B 子 Agent 在移动端按这字段判断 fallback。
      //
      // Wave 2: payload 字段全部塞到 tabtin_rich_content.payload（schema 允许 record(unknown)）。
      // type='rich_content' 已经被 envelope helper 改写为 'tabtin_rich_content'，工具不再
      // 自己写 type / kind 顶层字段，统一通过 emitRichContentBlock 参数携带。
      const widgetPayload = buildWidgetPayload({
        widgetId,
        prepared,
        format,
        imageUrl,
        toolCallId,
        params,
      })

      emitRich({
        kind: 'widget',
        summary,
        ...(params.group_id ? { groupId: params.group_id } : {}),
        payload: widgetPayload,
      })

      // 兼容老的持久化路径生成的 `_block` 字段——原 blocks collector 已删，
      // 但 ToolResult.llmStripKeys: ['_block'] 仍被多处消费方期望。
      // W2 仍生成 `_block` 兼容形态，等 W4-W6 各端跟进新协议时统一删。
      // **dogfood baking_error 复盘**：烤图失败的语义边界很重要 ——
      //
      // **桌面端**：widget 通过 iframe 直接渲染 `code`（SVG/HTML/Mermaid），
      // **完全不依赖**烤图产物 image_url。烤图失败 = 桌面端用户**仍然能看到完整
      // 交互 widget**。
      //
      // **移动端 fallback**：移动端不能跑 iframe，需要烤好的 PNG 退化成"静态
      // 截图 + summary"。烤图失败 = 移动端用户看到 placeholder + summary。
      //
      // 旧字段名 `baking_error` 让 LLM 误以为"widget 整体渲染失败"，触发它道歉
      // + 给 fallback 文本表格（实际 widget 在桌面端好好的，纯属误导）。
      //
      // 新字段名 `_mobile_fallback_unavailable` + 强引导文案，明确告诉 LLM：
      //   1. 桌面端渲染没事，**不要**重试 widget、**不要**给文本 fallback、**不要**
      //      道歉
      //   2. 这只影响移动端用户看到静态截图的体验（不影响功能）
      //   3. 字段下划线前缀提示这是元信息，不是业务结果
      //
      // W1.3 / A3-H3：烤图链路上传失败但本地 PNG 已写入时，把本地路径透出
      // 给 LLM —— 下一轮 LLM 看到 `output_path` 可以让 Agent 选择重试上传 /
      // 把文件挪到沙箱让用户下载，而不是"成果直接丢失"。
      //
      // **字段名对齐**：与 `tabvideo_export` / `tabvideo_render_mg` 失败回执
      // 一致，同 wave 三个修复使用同一契约字段，方便上层统一识别"上传失败
      // 但本地文件仍可访问"。
      return buildWidgetToolResult({
        widgetId,
        summary,
        format,
        codeBytes,
        widgetPayload,
        bakingError,
        bakedImagePath,
      })
    },
  }
}

// ─── Public re-export for the presentation tools factory ─────────────

/**
 * Convenience export so callers can ask for "the widget tool" without depending
 * on the internal factory naming. `presentation-tools.ts` `createPresentationTools`
 * also includes this tool so existing tool providers (Electron / Daemon) pick
 * it up automatically without touching their wiring code.
 */
export const SHOW_WIDGET_TOOL_NAME = 'show_widget'
