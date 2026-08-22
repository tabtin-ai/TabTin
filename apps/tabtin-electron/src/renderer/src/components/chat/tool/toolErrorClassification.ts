/**
 * toolErrorClassification — 工具错误分类
 *
 * Wave 2h：SOFT_ERROR_CODES 三处重复定义抽到此处。
 * Wave 2（tool-errors）：catalog 默认项由 `@tabtin/tool-errors` 生成；
 * 本文件只保留 UX 特例 override + 查询 helper，保证现有分类值不变。
 *
 * - `soft`：是否走温和化 UX（黄 Clock 代替红 XCircle）——语义是"系统/用户主动
 *   暂停"，不是"工具坏了"。
 * - `translatable`：是否有专门的 i18n 文案覆盖。其它 kind（unknown_tool /
 *   schema_invalid 等）已有详细英文 detail 可用，强行翻译反而丢信息。
 * - `countsAsAnomaly`：CollapsibleStepList 折叠行里"N 个异常"的统计口径。
 *   软跳过和用户主动取消**不算异常**，让真实用户看到的异常数和硬失败对齐。
 */

import {
  TOOL_ERROR_CATALOG_DEFAULTS,
  type ToolErrorCatalogEntry,
} from '@tabtin/tool-errors'

export type ToolErrorEntry = ToolErrorCatalogEntry

/**
 * 手工 UX overrides —— 覆盖生成式默认项中需要产品侧钉死的特例。
 *
 * 当前没有真实 delta。新增 UX 偏离时只改这里，不要手改
 * `_generated/catalog-defaults.generated.ts`；测试要求每项至少改变一个默认字段，
 * 防止全等 override 冻结 YAML 后续调整。
 */
export const TOOL_ERROR_UX_OVERRIDES: Readonly<Record<string, ToolErrorEntry>> = {}

export const TOOL_ERROR_CATALOG: Record<string, ToolErrorEntry> = {
  ...TOOL_ERROR_CATALOG_DEFAULTS,
  ...TOOL_ERROR_UX_OVERRIDES,
}

export function isSoftToolError(code: string | undefined): boolean {
  if (!code) return false
  return TOOL_ERROR_CATALOG[code]?.soft ?? false
}

export function isTranslatableToolError(code: string | undefined): boolean {
  if (!code) return false
  return TOOL_ERROR_CATALOG[code]?.translatable ?? false
}

export function isUserInitiatedToolError(code: string | undefined): boolean {
  if (!code) return false
  return TOOL_ERROR_CATALOG[code]?.userInitiated ?? false
}

/**
 * 折叠统计用：给定 errorCode 是否应该计入"N 个异常"。
 * Wave 2h 真实用户 Review R1：budget_skipped / aborted 是"系统暂停"或"用户
 * 主动停止"，在统计面板上和"run_terminal_command 权限被拒"混算会让用户以为工具坏了一片。
 */
export function countsAsHardAnomaly(code: string | undefined): boolean {
  if (!code) return true // 没有 code 说明是"原始 error"路径（老 runtime），保守视为异常
  return TOOL_ERROR_CATALOG[code]?.countsAsAnomaly ?? true
}

/**
 * i18n key 归一化：`aborted_by_user` 归到 `aborted` 文案池；
 * 其它 code 原样返回。避免 catalog/locale 两处各自写"指向同一文案"的别名。
 */
export function normalizeToolErrorI18nKey(code: string): string {
  if (code === 'aborted_by_user') return 'aborted'
  return code
}

/**
 * mode_restricted 子键映射 —— D6 双通道。
 *
 * runtime 拒绝 mode-restricted 工具时 ToolResult 内 JSON 携带 `error_kind:
 * 'mode_restricted'` + `deny_code: ModeDenyCode`。前端按 `deny_code` 推导更具体的
 * i18n 子键（chat.toolError.mode_restricted_{deny_code}），让用户卡片说人话。
 *
 * 缺 deny_code 时回退到通用 `mode_restricted` 文案（保留兜底，不破坏现有 UI）。
 */
const MODE_RESTRICTED_SUB_KEYS = new Set([
  'mode_disallowed_tool',
  'mode_tool_only_in_plan',
  'no_active_plan',
  'wrong_target_document',
  'invalid_document_id_type',
  'mode_disallowed_path',
])

export function resolveModeRestrictedI18nKey(denyCode: string | undefined): string {
  if (!denyCode || !MODE_RESTRICTED_SUB_KEYS.has(denyCode)) {
    return 'mode_restricted'
  }
  return `mode_restricted_${denyCode}`
}
