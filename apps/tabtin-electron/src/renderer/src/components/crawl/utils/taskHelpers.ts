/**
 * 任务相关工具函数
 */

import type {
  SimpleTaskConfig,
  FullTaskConfig,
  TaskStage,
  ExtractionSelection,
  ExtractionSelectionType
} from '../types'
import { resolveUserAgent } from '@/components/common/UserAgentSelector'
import i18n from '@/i18n'
// ✅ 引入 crawlspace-core 配置 API
import {
  autocompleteUrl,
  isValidUrl,
  formatDuration,
  formatProgress
} from '@tabtin/crawlspace-core'

// ✅ 重新导出供其他组件使用
export { autocompleteUrl, isValidUrl, formatDuration, formatProgress }

function resolveInstruction(selection: ExtractionSelection | undefined, fallback: string): string {
  if (selection?.instruction && selection.instruction.trim().length > 0) {
    return selection.instruction
  }
  if (selection?.title && selection.title.trim().length > 0) {
    return selection.title
  }
  return fallback
}

/**
 * 将简化配置转换为完整任务配置
 */
export interface PreparedTaskConfig {
  config: FullTaskConfig;
  metadata?: Record<string, any>;
}

export function convertToFullTaskConfig(config: SimpleTaskConfig): PreparedTaskConfig {
  // v3.0: 默认使用 standard-extraction-v3（自动滚动探测 + 翻页策略生成）
  // v2.0 兼容: 如果明确设置 detectPagination = true，保持 direct-execution 行为
  const workflow = config.detectPagination
    ? 'direct-execution'
    : 'standard-extraction-v3'

  const instruction = resolveInstruction(config.selection, config.instruction || '')

  // 🆕 处理 User-Agent 配置
  const resolvedUserAgent = resolveUserAgent(config.userAgent)

  const fullConfig: FullTaskConfig = {
    url: config.url,
    engine: 'webcontents',
    workflow,
    extract: {
      enabled: true,
      instruction,
      detectPagination: config.detectPagination,
      currentUrl: config.url,
      fieldConfigs: config.fieldConfigs,
    },
    crawl: {
      webcontents: {
        waitUntil: 'networkidle2',
        waitForDynamic: true,
        dynamicWaitTime: 2000,
        screenshot: false,
        useEmbeddedTab: true,    // ✅ 使用嵌入式标签
        showTab: true,           // ✅ 显示标签（在工作区内）
        userAgent: resolvedUserAgent  // 🆕 添加 UA 配置
      },
    },
    advanced: {
      priority: 'NORMAL',
      timeout: 60000,
      retry: 3,
    },
  }

  let initialMetadata: Record<string, any> | undefined;

  if (config.selection) {
    const selection = config.selection
    const selectionMetadata = selection.metadata ?? {}
    const selectionContext: any = {
      type: selection.type,
      source: selection.source,
      schema: selection.schema,
      metadata: selection.metadata,
      caseType: selection.caseType,
      blockedReason: selection.blockedReason,
      diagnosisHint: selection.diagnosisHint
    }

    // ⚙️ 将前端推荐生成阶段的上下文传递给 workflow，避免重复生成
    if (selectionMetadata.skeletonHtml) {
      selectionContext.skeletonHtml = selectionMetadata.skeletonHtml
    }
    if (selectionMetadata.cleanedHtml) {
      selectionContext.cleanedHtml = selectionMetadata.cleanedHtml
    }
    if (selectionMetadata.paginationStrategy) {
      selectionContext.paginationStrategy = selectionMetadata.paginationStrategy
    }

    const recommendationMetadata = {
      selectedId: selection.id,
      selectedInstruction: instruction,
      caseType: selection.caseType,
      blockedReason: selection.blockedReason,
      diagnosisHint: selection.diagnosisHint,
      selectionType: selection.type as ExtractionSelectionType,
      selectionSource: selection.source,
      metadata: selection.metadata,
      selectionContext
    }

    // ⚙️ 如果前端已生成推荐结果，写入以跳过 workflow 的二次生成
    if (Array.isArray(selectionMetadata.recommendations)) {
      (recommendationMetadata as any).recommendations = selectionMetadata.recommendations
    }
    if (selectionMetadata.recommendationStats) {
      (recommendationMetadata as any).stats = selectionMetadata.recommendationStats
    }
    if (selectionMetadata.caseType) {
      recommendationMetadata.caseType = selectionMetadata.caseType
    }
    if (selectionMetadata.blockedReason) {
      recommendationMetadata.blockedReason = selectionMetadata.blockedReason
    }
    if (selectionMetadata.diagnosisHint) {
      recommendationMetadata.diagnosisHint = selectionMetadata.diagnosisHint
    }
    if (selectionMetadata.selectionGeneratedAt) {
      (recommendationMetadata as any).generatedAt = selectionMetadata.selectionGeneratedAt
    }

    initialMetadata = {
      ...(initialMetadata ?? {}),
      recommendation: recommendationMetadata
    }
  }

  return {
    config: fullConfig,
    metadata: initialMetadata
  }
}

/**
 * 获取阶段标签
 */
export function getStageLabel(stage: TaskStage): string {
  switch (stage) {
    case 'config':
      return i18n.t('crawl:stages.config')
    case 'executing':
      return i18n.t('crawl:stages.executing')
    case 'mapping':
      return i18n.t('crawl:stages.mapping')
    case 'completed':
      return i18n.t('crawl:stages.completed')
    default:
      return ''
  }
}

/**
 * 获取阶段步骤编号
 */
export function getStageStep(stage: TaskStage): number {
  switch (stage) {
    case 'config':
      return 1
    case 'executing':
      return 2
    case 'mapping':
      return 3
    case 'completed':
      return 4
    default:
      return 1
  }
}

/**
 * 获取最佳面板比例
 */
export function getOptimalRatio(stage: TaskStage): number {
  switch (stage) {
    case 'config':
      return 0.7 // 配置阶段：网页 70%
    case 'executing':
      return 0.2 // 执行阶段：进度为主 80%
    case 'mapping':
      return 0.4 // 映射阶段：三分屏 40%
    default:
      return 0.6
  }
}

// ✅ autocompleteUrl 和 isValidUrl 已迁移到 @tabtin/crawlspace-core

/**
 * 自动生成字段映射
 */
export function autoMapFields(extractedFields: string[]): Array<{ source: string; target: string }> {
  return extractedFields.map((field) => ({
    source: field,
    target: formatFieldName(field),
  }))
}

/**
 * 格式化字段名（驼峰转中文）
 */
function formatFieldName(field: string): string {
  const mapping: Record<string, string> = {
    name: 'crawl:fieldNames.name',
    title: 'crawl:fieldNames.title',
    rating: 'crawl:fieldNames.rating',
    description: 'crawl:fieldNames.description',
    price: 'crawl:fieldNames.price',
    image: 'crawl:fieldNames.image',
    url: 'crawl:fieldNames.url',
    date: 'crawl:fieldNames.date',
    author: 'crawl:fieldNames.author',
    category: 'crawl:fieldNames.category',
  }

  const key = mapping[field]
  return key ? i18n.t(key) : field
}

// ✅ formatProgress 和 formatDuration 已迁移到 @tabtin/crawlspace-core
