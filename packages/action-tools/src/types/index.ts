/**
 * Agent 工具类型定义
 */

import type { ToolError } from './errors';

/**
 * 工具执行结果的基础接口
 */
export interface ToolResult<T = any> {
  success: boolean;
  data?: T;
  error?: ToolError;
  metadata?: Record<string, any>;
}

/**
 * 抓取清洗 HTML 的输入参数
 */
export interface CrawlCleanHtmlInput {
  url: string;
  waitForDynamic?: boolean;  // 是否等待动态内容加载
  timeout?: number;           // 超时时间（毫秒）
}

/**
 * 抓取清洗 HTML 的输出结果
 */
export interface CrawlCleanHtmlOutput {
  success: boolean;
  data?: {
    clean_html: string;
    skeleton_html?: string;
    title: string;
    url: string;
    content_length: number;
  };
  clean_html: string;
  /** 骨架 HTML（采样压缩后的 HTML） */
  skeleton_html?: string;
  title: string;
  url: string;
  content_length: number;
  error?: ToolError;
}

/**
 * Agent 工具定义
 */
export interface AgentTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
    /** Wave3：关闭未知键，避免拼写参数静默泄漏。 */
    additionalProperties?: boolean;
  };
  riskLevel?: import('./manifest').ToolRiskLevel;
  /**
   * Per-tool override of `ToolDomainMeta.llmFacing` / `ToolGroup.llmFacing`。
   *
   * 优先级：tool > group > domain > default(true)。详见
   * `packages/action-tools/src/types/manifest.ts` 的 `ToolManifest.llm_facing` JSDoc。
   *
   * 当 tool 显式声明 `false` 时即便所在 group/domain 是 LLM-facing，本 tool 也会
   * 在 manifest.json 中获得 `llm_facing: false` 标记，下游 MCP server / SKILL.md
   * 引导等 LLM-facing 列表会自动过滤。
   *
   * **类型在此显式声明**（不是 `(tool as { llmFacing? })` 强读）是 WP5 R1 技术
   * 优雅度 Reviewer P1-3 的修复 —— 让 typo（`llmfacing` / `LLMFacing`）能被 TS
   * 编译期 catch 住，避免 silent miss 让"LLM 看不见的工具"幻觉成"LLM 看得见"。
   */
  llmFacing?: boolean;
  execute: (input: TInput) => Promise<TOutput>;
}

/**
 * 工具执行器配置
 */
export interface ToolExecutorConfig {
  maxConcurrency?: number;
  defaultTimeout?: number;
  enableLogging?: boolean;
}

/**
 * 前端动作请求数据（来自 Agent SSE 的 frontend_action 事件）
 */
export interface ActionRequiredEventData {
  /** 任务ID */
  task_id: string;
  /** 动作类型（如 capture_webpage） */
  type: string;
  /** 动作参数 */
  params: Record<string, any>;
  /** 动作描述（可选） */
  description?: string;
}

/**
 * 前端动作执行结果（用于 HTTP POST 上报）
 */
export interface ActionResultRequest {
  /** 动作是否执行成功 */
  success: boolean;
  /** 追踪 ID（可选，建议提供） */
  trace_id?: string;
  /** 清洗后的 HTML（成功时必填） */
  clean_html?: string;
  /** 骨架 HTML（采样压缩后的 HTML，推荐使用） */
  skeleton_html?: string;
  /** 页面标题（可选） */
  title?: string;
  /** 实际访问的 URL（可选） */
  url?: string;
  /** 内容长度（可选） */
  content_length?: number;
  /** 执行的动作列表（Browser 任务） */
  executed_actions?: Array<{
    type: string;
    selector?: string;
    timestamp?: number;
    [key: string]: any;
  }>;
  /** 前端执行耗时（毫秒） */
  frontend_execution_time_ms?: number;
  /** 页面 URL */
  page_url?: string;
  /** 页面标题 */
  page_title?: string;
  /** 页面状态快照 */
  snapshot?: Record<string, any>;
  /** 页面变化差异 */
  diff?: Record<string, any>;
  /** 操作后的截图（Base64 编码） */
  screenshot_base64?: string;
  /** 观察到的元素列表（Observe 任务） */
  observed_elements?: Array<Record<string, any>>;
  /** 错误信息（失败时必填） */
  error?: string | null;
  /** 自定义数据（任意 JSON 对象） */
  data?: Record<string, any>;
}

/**
 * 通用的工具输出接口
 */
export type ToolOutput = ActionResultRequest;

/**
 * 工具输入接口
 */
export interface ToolInput {
  url: string;
  timeout?: number;
  waitForDynamic?: boolean;
  [key: string]: any;
}

/**
 * Browser 工具类型（从 tools/browser-types 重新导出）
 */
export type {
  ExecuteActInput,
  ExecuteActOutput,
  ExecuteObserveInput,
  ExecuteObserveOutput,
  RequestSnapshotInput,
  RequestSnapshotOutput,
} from '../tools/browser-types';

/**
 * 前端 Action 工具接口（轻量版，不要求 description/parameters）
 * 用于 FrontendActionBridge 注册的工具。
 */
export interface ActionTool {
  name: string;
  execute: (params: any) => Promise<ActionToolResult>;
}

export interface ActionToolResult {
  success: boolean;
  data?: Record<string, any>;
  error?: string;
}
