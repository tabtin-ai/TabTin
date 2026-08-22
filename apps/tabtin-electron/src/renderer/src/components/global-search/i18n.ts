/**
 * 统一搜索 UI 文案 i18n helper
 *
 * 集中：
 * - 9 种 `degraded_reason` → 用户可读文案
 * - 6 类 `partial_indices` 元素 → 用户可读类型名
 * - 6 类 result type → 卡片右侧徽章文案
 *
 * 与 react-i18next 配合：实际文案存 `locales/zh-CN/global-search.json`，
 * 这里只做"key 派生"和默认兜底，避免文案散落在组件里。
 */

import type { TFunction } from 'i18next'
import type { FtsDegradedReason, FtsLogicalIndex, FtsResultType } from '@tabtin/app-shell'
import { contextRegistry } from '@components/context-space/registry'

/** 9 种降级原因 → i18n key（与 zh-CN/global-search.json 对齐） */
export const DEGRADED_REASON_KEYS: Record<FtsDegradedReason, { key: string; defaultValue: string }> = {
  engine_disabled: {
    key: 'globalSearch:degraded.engine_disabled',
    defaultValue: '搜索引擎尚未启用，已切换到基础搜索（仅资源 / 备忘录）',
  },
  health_red: {
    key: 'globalSearch:degraded.health_red',
    defaultValue: '搜索服务暂时不可用，已切换到基础搜索',
  },
  circuit_open: {
    key: 'globalSearch:degraded.circuit_open',
    defaultValue: '搜索服务熔断保护中，已切换到基础搜索，请稍后重试',
  },
  error_rate_breach: {
    key: 'globalSearch:degraded.error_rate_breach',
    defaultValue: '搜索服务错误率较高，已切换到基础搜索',
  },
  opensearch_unavailable: {
    key: 'globalSearch:degraded.opensearch_unavailable',
    defaultValue: '搜索服务降级中，仅支持基础搜索（中文分词较粗糙）',
  },
  partial_failure: {
    key: 'globalSearch:degraded.partial_failure',
    defaultValue: '部分类型搜索暂时不可用，已展示其他类型结果',
  },
  rate_limited: {
    key: 'globalSearch:degraded.rate_limited',
    defaultValue: '降级模式下查询过于频繁，请稍候再试',
  },
  auth_missing: {
    key: 'globalSearch:degraded.auth_missing',
    defaultValue: '登录态异常，请重新登录',
  },
  internal_error: {
    key: 'globalSearch:degraded.internal_error',
    defaultValue: '搜索服务内部错误，请稍后重试',
  },
}

/** 6 类逻辑索引 → 用户可读类型名（partial_indices 提示用） */
export const LOGICAL_INDEX_LABEL_KEYS: Record<FtsLogicalIndex, { key: string; defaultValue: string }> = {
  messages: { key: 'globalSearch:logicalIndex.messages', defaultValue: '消息搜索' },
  resources: { key: 'globalSearch:logicalIndex.resources', defaultValue: '资源搜索' },
  agents: { key: 'globalSearch:logicalIndex.agents', defaultValue: 'Agent 搜索' },
  spaces: { key: 'globalSearch:logicalIndex.spaces', defaultValue: '工作空间搜索' },
  memos: { key: 'globalSearch:logicalIndex.memos', defaultValue: '备忘录搜索' },
  im: { key: 'globalSearch:logicalIndex.im', defaultValue: 'IM 搜索' },
}

/** 6 类 result type → 卡片右侧徽章文案 */
export const RESULT_TYPE_LABEL_KEYS: Record<FtsResultType, { key: string; defaultValue: string }> = {
  message: { key: 'globalSearch:resultType.message', defaultValue: '消息' },
  resource: { key: 'globalSearch:resultType.resource', defaultValue: '资源' },
  agent: { key: 'globalSearch:resultType.agent', defaultValue: 'Agent' },
  space: { key: 'globalSearch:resultType.space', defaultValue: 'Space' },
  memo: { key: 'globalSearch:resultType.memo', defaultValue: '备忘录' },
  im: { key: 'globalSearch:resultType.im', defaultValue: 'IM' },
}

/** 6 类 result type → 默认 emoji（卡片左侧图标兜底） */
export const RESULT_TYPE_EMOJI: Record<FtsResultType, string> = {
  message: '💬',
  resource: '📄',
  agent: '🤖',
  space: '📁',
  memo: '📝',
  im: '💬',
}

export function getDegradedMessage(
  t: TFunction,
  reason: FtsDegradedReason | null | undefined,
  partialIndices: FtsLogicalIndex[] | undefined,
): string {
  // partial_failure 优先把"具体失败的索引"显示出来
  if (reason === 'partial_failure' && partialIndices && partialIndices.length > 0) {
    const names = partialIndices
      .map((idx) => {
        const conf = LOGICAL_INDEX_LABEL_KEYS[idx]
        if (!conf) return idx
        return t(conf.key, conf.defaultValue)
      })
      .join('、')
    return t(
      'globalSearch:degraded.partial_failure_with_indices',
      { indices: names, defaultValue: `${names}暂时不可用，已展示其他类型结果` },
    )
  }
  if (reason && DEGRADED_REASON_KEYS[reason]) {
    const conf = DEGRADED_REASON_KEYS[reason]
    return t(conf.key, conf.defaultValue)
  }
  return t('globalSearch:degraded.unknown', '搜索服务部分降级')
}

export function getResultTypeLabel(t: TFunction, type: FtsResultType): string {
  const conf = RESULT_TYPE_LABEL_KEYS[type]
  if (!conf) return type
  return t(conf.key, conf.defaultValue)
}

/** 资源子类型 → 翻译后的应用显示名（权威源：context:appName.*） */
export function getResourceSubtypeLabel(t: TFunction, type: string): string {
  const resolved = contextRegistry.normalizeBackendType(type)
  return t(`context:appName.${resolved}`, {
    defaultValue: contextRegistry.getDisplayLabel(resolved),
  })
}
