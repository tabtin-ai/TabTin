/**
 * Schema类型定义文件
 * 定义了AI生成的提取规则Schema的所有类型结构
 */

/**
 * 提取字段类型枚举
 */
export type ExtractionFieldType =
  | 'text'
  | 'attribute'
  | 'html'
  | 'regex'
  | 'xpath'
  | 'computed'
  | 'conditional'
  | 'nested';

/**
 * 数据转换规则接口
 */
export interface TransformSchema {
  trim?: boolean;
  to_number?: boolean;
  to_date?: boolean;
  replace?: {
    pattern: string;
    replacement: string;
  };

  split?: string;
  substring?: [number, number];
  match_all?: string;
  pad_start?: [number, string];
  pad_end?: [number, string];
}

/**
 * 过滤规则接口（v2.1 新增）
 */
export interface FilterSchema {
  type: 'regex_match' | 'not_empty' | 'contains' | 'range';
  pattern?: string;
  text?: string;
  min?: number;
  max?: number;
}

/**
 * 计算规则接口（v2.1 新增）
 */
export interface ComputeSchema {
  expression: string;
  inputs: string[];
}

/**
 * 条件规则接口（v2.1 新增）
 */
export interface ConditionalRule {
  if: {
    selector: string;
    exists?: boolean;
    text_contains?: string;
  };
  then: {
    selector?: string;
    type?: ExtractionFieldType;
    value?: any;
  };
}

/**
 * 数组操作接口（v2.2 新增）
 */
export interface ArrayTransformSchema {
  unique?: boolean;
  sort?: 'asc' | 'desc';
  limit?: number;
  join?: string;
  filter_empty?: boolean;
  slice?: [number, number?];
}

/**
 * 正则捕获组配置（v2.2 新增）
 */
export interface RegexCaptureGroups {
  [fieldName: string]: number;
}

/**
 * 数据验证规则（v2.2 新增）
 */
export interface ValidationSchema {
  required?: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  regex?: string;
  enum?: any[];
  error_message?: string;
}

/**
 * 提取字段定义接口
 */
export interface ExtractionField {
  name: string;
  selector: string | string[];
  type: ExtractionFieldType;
  attribute?: string;
  regex?: string;
  required: boolean;
  description: string;
  transform?: TransformSchema;
  filter?: FilterSchema;
  compute?: ComputeSchema;
  conditions?: ConditionalRule[];
  default?: { value: any };

  tabdata_type?: string;
  /** @deprecated Use tabdata_type instead */
  aitable_type?: string;
  multiple?: boolean;

  array_transform?: ArrayTransformSchema;
  capture_groups?: RegexCaptureGroups;
  validation?: ValidationSchema;
  nested_fields?: ExtractionField[];
  scope?: 'item' | 'document';
}

/**
 * 翻页元素信息接口
 */
export interface PaginationElement {
  type: string;
  method: string;
  selector: string;
  description: string;
  confidence: number;
  attributes?: {
    text?: string;
    href?: string;
    enabled?: boolean;
  };
  ajax_info?: {
    detected: boolean;
    endpoint?: string;
    method?: string;
  };
}

/**
 * 翻页信息接口（旧格式，保留兼容性）
 */
export interface PaginationInfo {
  pagination_elements: PaginationElement[];
  page_numbers?: {
    current: number;
    total?: number;
    has_previous: boolean;
    has_next: boolean;
    url_pattern?: string;
  };
  total_detected: number;
}

/**
 * 翻页策略接口（后端新格式）
 */
export interface SchemaPaginationStrategy {
  enabled: boolean;
  method: 'click' | 'scroll' | 'url_pattern';
  reason: string;
  confidence: number;
  click_selector?: string;
  url_pattern?: string;
  page_info?: {
    current?: number;
    total?: number;
  };
}

/**
 * 提取Schema接口（AI返回的完整规则）
 */
export interface ExtractionSchema {
  list_selector: string;
  /** @deprecated Use list_selector instead. 保留仅为向后兼容旧格式数据。 */
  listSelector?: string;
  fields: ExtractionField[];
  confidence: number;
  reasoning: string;
  sample_data: Record<string, any>[];
  pagination_info?: PaginationInfo;
  pagination_strategy?: SchemaPaginationStrategy;
}
