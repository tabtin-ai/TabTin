/**
 * @tabtin/agent-import — 外部 Agent 工具数据导入核心包。
 *
 * PRD：docs/prd/external-agent-import-onboarding-v1.md（§5.2 本包定位）
 * 调研底稿：docs/prd/external-agent-import-research/（字段级事实以底稿为准）
 *
 * 纯逻辑 + 注入式 IO：宿主（Electron utilityProcess / CLI / 测试）提供
 * ImportIO 实现；本包不做权限边界判定（白名单在宿主 IO 层）。
 */

export * from './types.js'
export { type ImportIO, type SqliteQueryOptions, NodeImportIO } from './io.js'
export {
  resolveSourcePaths,
  resolveVendorAppDataDir,
  isForbiddenPath,
  assertImportSourcePath,
  type SourcePaths,
} from './paths.js'
export { redactText, newRedactStats, type RedactStats } from './redact.js'
export {
  normalizeMessages,
  contentHashId,
  ensureUuid,
  uuidFromString,
  textDedupKey,
  decodeBase64Image,
  interpolateTimestamps,
  SYNTHESIZED_TOOL_RESULT_TEXT,
  type NormalizeOptions,
} from './normalize.js'
export {
  isContentlessSessionRef,
  isHeaderOnlyLayer,
} from './session-filter.js'

import type { ImportIO } from './io.js'
import type { DetectResult, ImportSource, SourceAdapter } from './types.js'
import { claudeCodeAdapter } from './adapters/claude-code.js'
import { codexAdapter } from './adapters/codex.js'
import { cursorAdapter } from './adapters/cursor.js'
import { workbuddyAdapter } from './adapters/workbuddy.js'

export { claudeCodeAdapter, codexAdapter, cursorAdapter, workbuddyAdapter }

const ADAPTERS: Record<ImportSource, SourceAdapter> = {
  claude_code: claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  workbuddy: workbuddyAdapter,
}

export function getAdapter(source: ImportSource): SourceAdapter {
  return ADAPTERS[source]
}

/** detect 全家（banner 场景：亚秒级，只读索引计数不深扫） */
export async function detectAll(io: ImportIO): Promise<DetectResult[]> {
  return Promise.all(Object.values(ADAPTERS).map((a) => a.detect(io)))
}
