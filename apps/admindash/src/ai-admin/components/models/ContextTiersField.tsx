/**
 * `ContextTiersField` 透传到 v0.1 ai-admin 命名空间。
 *
 * 实现复用 `@/components/llm-admin/ContextTiersField`（已通过旧 llm-admin.tsx
 * 在生产里跑过），不做"创建一个空壳"或"复制粘贴"——这是宪法 07 §7 中明确要求的
 * "ContextTiersField 复用现有"。
 *
 * 不导出 `buildZenMuxLongContextPreset`：
 * - 长上下文档位是 chat / vision domain 的特例
 * - embedding / asr / tts / 媒体生成 domain 不需要档位预设
 * - 留给页面 / Dialog 自己 import 老路径，避免在 ai-admin 命名空间引入
 *   "domain 无关"的预设
 */

export {
  ContextTiersField,
  serializeTiersToConfig,
  parseTiersFromConfig,
  validateTiers,
  type TierFormItem,
  type TierIssue,
  type TierIssueField,
  type TiersValidationResult,
} from '@/components/llm-admin/ContextTiersField'
