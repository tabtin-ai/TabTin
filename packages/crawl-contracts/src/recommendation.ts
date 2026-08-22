import type { ExtractionSchema } from './extraction-schema';

export type RecommendationCaseType =
  | 'direct_extract'
  | 'auth_required'
  | 'captcha'
  | 'action_required'
  | 'empty_content'
  | 'unsupported';

export interface RecommendationPageMeta {
  title?: string;
  httpStatus?: number;
  language?: string;
  isAuthenticated?: boolean;
  hasCookies?: boolean;
}

export interface RecommendationRequest {
  cleanHtml: string;
  url?: string;
  maxRecommendations?: number;
  crawlContextId?: string;
  skeletonHtml?: string;
  pageMeta?: RecommendationPageMeta;
}

export interface SuggestedField {
  name: string;
  label: string;
  tabdata_type: string;
  /** @deprecated Use tabdata_type instead */
  aitable_type?: string;
}

export interface RecommendationItem {
  id: string;
  title: string;
  confidence: number;
  instruction?: string;
  target_region?: {
    container_selector: string;
    item_selector: string;
    description?: string;
    skeleton_path?: string | null;
  };
  suggested_fields?: SuggestedField[];
}

export interface RecommendationPageInfo {
  title?: string;
  url?: string;
  detected_patterns?: string[];
  complexity?: 'low' | 'medium' | 'high';
  element_count?: number;
  text_length?: number;
}

export interface RecommendationResponse {
  recommendations: RecommendationItem[];
  page_info?: RecommendationPageInfo;
  total_count: number;
  case_type: RecommendationCaseType;
  blocked_reason?: string;
  diagnosis_hint?: string;
}

export interface RecommendationStats {
  requestTime: number;
  responseTime: number;
  totalDuration: number;
  fromCache: boolean;
  statusCode: number;
  retryCount?: number;
}

export interface RecommendationGeneratorResult {
  response: RecommendationResponse;
  stats: RecommendationStats;
}

export interface HistoryRecommendationRequest {
  url: string;
  userId?: string;
  limit?: number;
}

export type RecommendationHistorySource =
  | 'user_created'
  | 'ai_recommended'
  | 'similar';
export type RecommendationHistoryVisibility = 'private' | 'public';

export interface RecommendationHistorySchema {
  id: string;
  title?: string;
  description?: string;
  schema?: ExtractionSchema;
  confidence?: number;
  usage_count?: number;
  unique_user_count?: number;
  last_used_at?: string;
  source?: RecommendationHistorySource;
  visibility?: RecommendationHistoryVisibility;
}

export interface HistoryRecommendationResponse {
  user_created_schemas: RecommendationHistorySchema[];
  ai_recommended_schemas: RecommendationHistorySchema[];
  similar_schemas: RecommendationHistorySchema[];
  url_pattern?: string;
  has_history: boolean;
}

export interface RecommendationServiceStatus {
  status: string;
  llm_available: boolean;
  llm_model?: string;
  version: string;
}

/**
 * Schema生成统计信息
 */
export interface SchemaGenerationStats {
  requestTime: number;
  responseTime: number;
  totalDuration: number;
  fromCache: boolean;
  isAsync: boolean;
  retryCount: number;
  statusCode: number;
}

/**
 * Schema生成结果
 */
export interface SchemaGenerationResult {
  schema: ExtractionSchema;
  stats: SchemaGenerationStats;
}

export interface SchemaGeneratorConfig {
  apiBaseUrl: string;
  timeout?: number;
  cache?: {
    enabled?: boolean;
    ttl?: number;
    maxSize?: number;
  };
  retry?: {
    maxRetries?: number;
    delay?: number;
    backoffMultiplier?: number;
    maxDelay?: number;
  };
}
