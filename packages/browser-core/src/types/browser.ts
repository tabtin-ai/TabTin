/**
 * 浏览器工具类型定义（Single Source of Truth）
 *
 * action-tools 通过 re-export 引用本文件，请勿在 action-tools 中重复定义。
 */

import type { ToolError } from './errors';
import type { CaptchaInfo } from '../captcha/CaptchaDetector';

export interface BlockSignal {
  blocked: boolean;
  reason?: string;
  error_code?: 'blocked' | 'rate_limited';
}

export type BlockType =
  | 'cloudflare'
  | 'rate_limit'
  | 'ip_ban'
  | 'captcha'
  | 'business_403'
  | 'auth_wall'
  | 'none';

export interface EnhancedBlockSignal extends BlockSignal {
  type?: BlockType;
  /** 0-1，多维度综合置信度 */
  confidence: number;
  httpStatus?: number;
  /** 是否应触发访问策略升级（区分反爬封禁 vs 业务权限不足） */
  shouldUpgrade: boolean;
  /**
   * 登录墙（`type: 'auth_wall'`）标志：页面需要用户先登录才能继续。
   * 与反爬封禁不同——不该自动升级访问策略、不该重试，而应停下来让用户手动登录。
   * 由上层编排确定性地投影成 `login_required`（见 BrowserOrchestrator.projectObservePayload）。
   */
  loginRequired?: boolean;
}

export const ACT_ACTION_TYPES = [
  'click', 'fill', 'scroll', 'wait',
  'drag', 'type', 'keyPress', 'keyDown', 'keyUp',
  'hover', 'dblclick', 'upload', 'select',
] as const;

export type ActActionType = typeof ACT_ACTION_TYPES[number];

const ACT_ACTION_TYPE_BY_LOWER: ReadonlyMap<string, ActActionType> = new Map(
  ACT_ACTION_TYPES.map((type) => [type.toLowerCase(), type]),
);

/**
 * 归一化 act 动作类型：模型常输出小写或异形大小写（如 keypress / KeyPress），
 * 与规范驼峰不一致会导致 CDP 分派漏判、错落到需要 selector 的 DOM 路径。
 * 命中规范类型（忽略大小写）则返回规范写法，否则原样返回交由下游报错。
 */
export function normalizeActActionType(type: string): string {
  return ACT_ACTION_TYPE_BY_LOWER.get(type.toLowerCase()) ?? type;
}

export interface ActAction {
  type: ActActionType;
  selector?: string;
  value?: string;
  /** scroll：方向（up/down/top/bottom）；与 amount 一并在入口归一为 ScrollIntent */
  direction?: string;
  /** scroll：像素距离；与 direction 组合，正下负上由 direction 决定符号 */
  amount?: number;
  index?: number;
  duration?: number;
  key?: string;
  toSelector?: string;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  x?: number;
  y?: number;
  files?: string[];
  steps?: number;
  delay?: number;
}

export interface ExecuteActInput {
  actions: ActAction[];
  stop_on_error?: boolean;
  timeout?: number;
  runId?: string;
  crawlTabId?: string;
  partition?: string;
  proxy?: any;
  userAgent?: string;
}

export interface ExecuteActOutput {
  success: boolean;
  data?: Record<string, any>;
  executed_actions: Array<{
    type: string;
    selector?: string;
    value?: string;
    status: 'success' | 'failed';
    error?: string;
    error_code?: string;
    timestamp?: number;
    actual_value?: string;
    checked?: boolean;
    control_value?: string;
    /** `initial` | `semantic_relocate` — 不改变 success 语义，见 ActionEntry */
    selector_source?: 'initial' | 'semantic_relocate';
    relocated_from?: string;
    /** ref 回解时的语义文本 / role——排障用，见 ActionEntry */
    resolved_text?: string;
    resolved_role?: string;
  }>;
  frontend_execution_time_ms: number;
  page_url: string;
  page_title: string;
  snapshot?: {
    accessibility_tree: string;
    skeleton_html?: string;
    xpath_map: Record<string, string>;
  };
  diff?: {
    hasChanges: boolean;
    addedCount: number;
    removedCount: number;
    changedCount: number;
    addedLines: string[];
    removedLines: string[];
    changedLines?: string[];
    summary: string;
    targetElementDisappeared?: boolean;
    analysis?: {
      newItemsLoaded?: number;
      hasMoreContent?: boolean;
      modalOpened?: boolean;
      navigationOccurred?: boolean;
      contentExpanded?: boolean;
      mainChangeArea?: string;
      affectedSelectors?: string[];
    };
  };
  screenshot_base64?: string;
  loop_warning?: string;
  captcha?: CaptchaInfo;
  block?: BlockSignal;
  error?: ToolError;
}

export interface ExecuteObserveInput {
  selector?: string;
  runId?: string;
  crawlTabId?: string;
  partition?: string;
  proxy?: any;
  userAgent?: string;
  include_som?: boolean;
  limit?: number;
}

export interface ExecuteObserveOutput {
  success: boolean;
  data?: Record<string, any>;
  observed_elements: Array<{
    selector: string;
    tag: string;
    text: string;
    role?: string;
    visible: boolean;
    /**
     * 链接类元素的真实 href（绝对 URL，含站点风控签名参，如小红书 `xsec_token`）。
     * 仅当元素带 href 时才有。Agent 应直接用它 `browser open`，不要自己拼 URL。
     */
    href?: string;
    /** 原生控件语义，供 Agent 判读 textbox / checkbox / radio / combobox / button。 */
    control_type?: string;
    /** 仅 checkbox / radio 的选项值，普通文本框实际值不输出。 */
    option_value?: string;
    /** 仅 checkbox / radio 的选中状态。 */
    checked?: boolean;
    /** 元素外接框，仅 `include_som=true`（视觉定位）时才产出。 */
    bbox?: { x: number; y: number; width: number; height: number };
    /**
     * BR-27：eN 可执行引用（如 `e1`），由编排层 `projectObservePayload` 注入（引擎本身不产）。
     * 与元素在数组中的 1 基序位对齐（第 1 个 ↔ `e1`），喂给 `act --ref eN` 即可回解出 selector。
     */
    ref?: string;
  }>;
  frontend_execution_time_ms: number;
  block?: BlockSignal;
  error?: ToolError;
}

export interface RequestSnapshotInput {
  include_dom?: boolean;
  include_screenshot?: boolean;
  include_accessibility_tree?: boolean;
  include_raw_html?: boolean;
  include_clean_html?: boolean;
  /**
   * 内容类型白名单（browser --include）。仅作用于 HTML 内容输出（raw_html / clean_html /
   * skeleton_html），不碰 a11y 交互树。
   * - `undefined` = 不过滤（内部调用方默认；向后兼容 crawlspace 等链路）。
   * - `[]` = 剥离全部可过滤类型（CLI 不传 --include 时的默认）。
   * - `['links','tables']` = 只保留这些类型。
   */
  include_content_types?: string[];
  include_som?: boolean;
  full_page_screenshot?: boolean;
  screenshot_width?: number;
  selector?: string;
  limit?: number;
  runId?: string;
  crawlTabId?: string;
  partition?: string;
  proxy?: any;
  userAgent?: string;
}

export interface RequestSnapshotOutput {
  success: boolean;
  data?: {
    snapshot: {
      url: string;
      title: string;
      raw_html?: string;
      clean_html?: string;
      skeleton_html?: string;
      accessibility_tree?: string;
      dom_index?: string;
      xpath_map?: Record<string, string>;
      screenshot_base64?: string;
    };
    frontend_execution_time_ms: number;
  };
  captcha?: CaptchaInfo;
  block?: BlockSignal;
  error?: ToolError;
}
