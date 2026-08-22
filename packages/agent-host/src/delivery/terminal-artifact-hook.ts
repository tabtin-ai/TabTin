/**
 * Host `afterToolResult` hook —— `run_terminal_command` 交付物卡。
 *
 * **定位**：core shell（agent-runtime `capability/core/shell.ts`）不再认识
 * browser/table/oss 业务；它只把执行事实（command / 完整脱敏 stdout / exitCode /
 * outputFilePath）附在 `ToolResult.hostMetadata` 上。业务识别 + 建卡全部收敛到这个
 * 宿主注册的 `afterToolResult` hook（Electron / Daemon 在 `composeHooks(...)` 注册；
 * 子 Agent 经 fork-query compose 父 hooks 一并继承）。
 *
 * **行为**：
 * - OSS：exitCode===0 且命中 `tabtin oss upload` → 发 oss_file 卡。
 * - Table/Doc create：命中 `tabtin table|doc create` 且能解析出 id → 发
 *   `resource_ref`（artifact_kind=platform_resource）；含 207 partial（exit≠0
 *   但 detail 有 table_id）。 / ；不进 agent-runtime。
 * - Browser→Table / `task_episode` 自动发卡已随  命令下线与  移除。
 * - canonical 保真：summary 同时写到 execution 与 raw 两个视图的 `llmContextContent`
 *   （见 `ToolHookExecutionResult.rawResult`），使 `buildToolResultBlockSets` 的
 *   canonical 分支保留 `rawResult.content`（完整 envelope）。
 * - 消费完清空 `hostMetadata`（execution + raw），杜绝完整 stdout 泄漏。
 */
import type { EngineHooks, ToolResult } from '@tabtin/agent-runtime'
import type { ContentBlockStart } from '@tabtin/agent-wire'
import { buildOssFileArtifactBlockFromUpload } from './oss-file-artifact.js'
import { buildMediaImageArtifactBlocks } from './media-image-artifact.js'
import { buildPlatformResourceArtifactBlockFromCreate } from './platform-resource-artifact.js'

const TERMINAL_TOOL_NAME = 'run_terminal_command'

/** `tabtin_rich_content` 块（展示词汇——完全在 host 侧，core 引擎不感知）。 */
type RichContentBlock = Extract<ContentBlockStart['block'], { type: 'tabtin_rich_content' }>

/**
 * host 侧 rich-content 发卡语义（展示词汇留在 host）：`{kind,summary,groupId?,payload?}`
 * → 构造 `tabtin_rich_content` 块，经 core 的通用 `emitDetachedMiniMessage` 原语发送。
 * 块构造与原 `tool-stream-emitter.ts::makeRichContentBlockEmitter` 字节一致
 * （`group_id` / `payload` 的可选拼法保持一致）。
 */
type RichContentEmit = (args: {
  kind: RichContentBlock['kind']
  summary: string
  groupId?: string
  payload?: Record<string, unknown>
  messageId?: string
}) => void

interface TerminalCommandHostMetadata {
  command: string
  fullOutput: string
  exitCode: number
  outputFilePath: string
}

/**
 * 从 `ToolResult.hostMetadata` 读出 shell 附带的终端执行元数据；形状不符返回 null。
 * shell 侧写入的字段是它自己的执行事实（非业务），这里按结构守卫读取。
 */
function readTerminalHostMetadata(
  hostMetadata: Record<string, unknown> | undefined,
): TerminalCommandHostMetadata | null {
  if (!hostMetadata) return null
  const { command, fullOutput, exitCode, outputFilePath } = hostMetadata as Record<string, unknown>
  if (
    typeof command !== 'string'
    || typeof fullOutput !== 'string'
    || typeof exitCode !== 'number'
    || typeof outputFilePath !== 'string'
  ) {
    return null
  }
  return { command, fullOutput, exitCode, outputFilePath }
}

/**
 * OSS：`tabtin oss upload` 成功 → 发 oss_file 卡。逻辑与原 shell.ts
 * `maybeEmitOssFileArtifact` 一致（best-effort，发卡失败不影响结果）。
 */
function emitOssFileArtifact(
  emitRich: RichContentEmit,
  meta: TerminalCommandHostMetadata,
): void {
  const block = buildOssFileArtifactBlockFromUpload(meta.command, meta.fullOutput)
  if (!block) return
  try {
    emitRich(block)
  } catch {
    // best-effort：发卡失败不影响 shell 结果回传
  }
}

function emitMediaImageArtifacts(
  emitRich: RichContentEmit,
  meta: TerminalCommandHostMetadata,
  sourceToolUseId: string,
): void {
  for (const block of buildMediaImageArtifactBlocks(meta.command, meta.fullOutput, sourceToolUseId)) {
    try {
      emitRich({
        kind: block.kind,
        summary: block.summary,
        payload: block.payload,
        ...(block.messageId ? { messageId: block.messageId } : {}),
      })
    } catch {
      // best-effort：单张图片发卡失败不影响其它产物与工具结果。
    }
  }
}

/**
 * Table/Doc：`tabtin table|doc create` 解析出 id → 发 platform_resource 卡。
 * 不要求 exitCode===0（207 表已建字段失败仍应入「本轮产物」）。
 */
function emitPlatformResourceArtifact(
  emitRich: RichContentEmit,
  meta: TerminalCommandHostMetadata,
): void {
  const block = buildPlatformResourceArtifactBlockFromCreate(meta.command, meta.fullOutput)
  if (!block) return
  try {
    emitRich(block)
  } catch {
    // best-effort
  }
}

/**
 * 创建 `run_terminal_command` 交付物卡的 host afterToolResult hook。
 * 无 host deps（builder 都是纯函数）——两端宿主直接
 * `composeHooks(..., createTerminalArtifactCardHook())`。
 */
export function createTerminalArtifactCardHook(): EngineHooks {
  return {
    afterToolResult: async (ctx) => {
      // host 侧构造 tabtin_rich_content 块，经 core 的通用 emitDetachedMiniMessage
      // 原语发送（展示词汇不进 core）。块形状字节对齐原 makeRichContentBlockEmitter。
      const emitRich: RichContentEmit = (args) => {
        ctx.emitDetachedMiniMessage({
          role: 'assistant',
          ...(args.messageId ? { messageId: args.messageId } : {}),
          block: {
            type: 'tabtin_rich_content',
            kind: args.kind,
            summary: args.summary,
            ...(args.groupId ? { group_id: args.groupId } : {}),
            ...(args.payload ? { payload: args.payload } : {}),
          },
        })
      }
      for (const item of ctx.results) {
        if (item.toolName !== TERMINAL_TOOL_NAME) continue
        const result = item.result as ToolResult
        const rawResult = item.rawResult as ToolResult | undefined
        const meta = readTerminalHostMetadata(result.hostMetadata)
        if (!meta) continue

        // 顺序：table/doc create 交付 → media/OSS（exit 0）。
        emitPlatformResourceArtifact(emitRich, meta)
        if (meta.exitCode === 0) {
          emitMediaImageArtifacts(emitRich, meta, item.toolUseId)
          emitOssFileArtifact(emitRich, meta)
        }

        // 消费后清空瞬态元数据（execution + raw 两份引用）：hook 在
        // buildToolResultBlockSets / 落库前跑，清掉即杜绝完整 stdout 泄漏。
        result.hostMetadata = undefined
        if (rawResult) rawResult.hostMetadata = undefined
      }
    },
  }
}
