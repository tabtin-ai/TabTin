/**
 * WebContents Engine 模块 — 类型定义
 */

export type {
  IWebContentsAdapter,
  WebContentsAdapterResult,
  WebContentsAdapterInitOptions,
  WebContentsViewOptions,
  WebContentsViewHandle,
  WebContentsNavigationOptions,
  WebContentsNavigationResult,
  WebContentsSnapshotOptions,
  WebContentsExecuteOptions,
  WebContentsScreenshotOptions,
  WebContentsResourceAttachment,
  WebContentsAdapterRuntimeInfo
} from './types.js';

// Re-export WebContentsScrapeOptions from options types
export type { WebContentsScrapeOptions } from '../../types/options.js';
