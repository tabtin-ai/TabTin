export type ScrollStrategy = 'lazy-load' | 'infinite-scroll' | 'pagination';

/**
 * 预处理配置接口
 */
export interface PreprocessingConfig {
  /** 移除脚本标签 */
  removeScripts?: boolean;
  /** 移除样式标签 */
  removeStyles?: boolean;
  /** 移除注释 */
  removeComments?: boolean;
  /** 移除隐藏元素 */
  removeHiddenElements?: boolean;
  /** 清理属性 */
  cleanAttributes?: boolean;
  /** 保留 data 属性 */
  preserveDataAttributes?: boolean;
  /** 内容识别配置 */
  contentIdentification?: ContentIdentificationConfig;
  /** 骨架生成配置 */
  skeletonGeneration?: SkeletonGenerationConfig;
  /** 长文本截断阈值 */
  textTruncationThreshold?: number;
  /** 文本截断时保留的前缀长度 */
  textPrefixLength?: number;
  /** 文本截断时保留的后缀长度 */
  textSuffixLength?: number;
  /** 列表采样阈值 */
  listSamplingThreshold?: number;
  /** 列表采样时保留的前 N 个元素 */
  listKeepFirst?: number;
  /** 列表采样时保留的后 N 个元素 */
  listKeepLast?: number;
  /** 是否移除空标签 */
  removeEmptyTags?: boolean;
  /** 保留的 HTML 属性白名单 */
  allowedAttributes?: string[];
}

export interface ContentIdentificationConfig {
  /** 最小文本长度 */
  minTextLength?: number;
  /** 文本密度阈值 */
  textDensityThreshold?: number;
  /** 内容选择器集合 */
  contentSelectors?: string[];
  /** 需要排除的选择器集合 */
  excludeSelectors?: string[];
  /** 权重配置 */
  scoreWeights?: {
    textDensity?: number;
    position?: number;
    tagName?: number;
    className?: number;
  };
}

export interface SkeletonGenerationConfig {
  /** 最大文本长度 */
  maxTextLength?: number;
  /** 列表采样大小 */
  listSampleSize?: number;
  /** 是否保留结构 */
  preserveStructure?: boolean;
  /** 是否移除空元素 */
  removeEmptyElements?: boolean;
  /** 是否压缩空白字符 */
  compressWhitespace?: boolean;
  /** 保留的属性 */
  keepAttributes?: string[];
  /** 截断阈值 */
  truncateThreshold?: number;
}

export interface StaticScrollDetectionResult {
  /** 是否存在滚动或懒加载机制 */
  hasInfiniteScroll: boolean;
  /** 可能的触发元素选择器（如“加载更多”按钮） */
  triggerSelector?: string;
  /** 推测的滚动策略 */
  scrollStrategy?: ScrollStrategy;
  /** 置信度（0-1） */
  confidence: number;
  /** 触发判断的信号列表，便于诊断 */
  signals: string[];
}

export interface ContentAreaSummary {
  selector: string;
  score: number;
  textLength: number;
  textDensity: number;
  isMainContent: boolean;
}

export interface ContentIdentificationStats {
  totalElements: number;
  candidateAreas: number;
  mainContentAreas: number;
  filteredNavAdAreas: number;
  processingTime: number;
}

export interface ContentIdentificationResult {
  mainContentSelector: string | null;
  areas: ContentAreaSummary[];
  stats: ContentIdentificationStats;
}

export interface PreprocessingStats {
  /** 原始 HTML 大小（字符数） */
  originalSize: number;
  /** 清洗后 HTML 大小（字符数） */
  cleanedSize: number;
  /** 骨架 HTML 大小（字符数） */
  skeletonSize: number;
  /** 移除的元素数量 */
  removedElements: number;
  /** 清理的属性数量 */
  cleanedAttributes: number;
  /** 识别到的内容区域数量 */
  contentAreas: number;
  /** 处理耗时（毫秒） */
  processingTime: number;
}
