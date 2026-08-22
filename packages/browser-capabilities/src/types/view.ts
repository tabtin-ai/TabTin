/**
 * View 相关类型定义
 */

import { WebPreferences, Rectangle } from 'electron';

/**
 * View 状态
 */
export interface ViewState {
  /** 是否已加载过初始 URL */
  loadedInitialURL: boolean;
}

/**
 * 创建 View 的配置
 */
export interface CreateViewConfig {
  /** View ID */
  id: string;
  /** WebPreferences 配置 */
  webPreferences?: Partial<WebPreferences>;
  /** 初始边界 */
  bounds?: Rectangle;
  /** 是否立即加载 URL */
  url?: string;
}

