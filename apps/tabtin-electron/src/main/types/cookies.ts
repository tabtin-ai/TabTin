/**
 * Cookie 类型定义
 *
 * 统一 Puppeteer 和 Electron 的 Cookie 类型
 *
 * @author TabTin Team
 * @date 2025-11-21
 */

import type { Cookie as PuppeteerCookie } from 'puppeteer-core';
import type { Cookie as ElectronCookie } from 'electron';

/**
 * 统一的 Cookie 类型（基于 Puppeteer）
 *
 * Puppeteer 的 Cookie 类型更加标准，与 Chrome DevTools Protocol 一致
 */
export type Cookie = PuppeteerCookie;

/**
 * Cookie 过滤条件
 */
export interface CookieFilter {
  /** URL 过滤 */
  url?: string;

  /** 域名过滤 */
  domain?: string;

  /** Cookie 名称过滤 */
  name?: string;

  /** 路径过滤 */
  path?: string;
}

/**
 * Cookie 导出格式
 */
export interface CookieExportFormat {
  /** 格式版本 */
  version: string;

  /** Cookies 数组 */
  cookies: Cookie[];

  /** 导出时间 */
  exportedAt: string;

  /** 来源（puppeteer 或 electron） */
  source: 'puppeteer' | 'electron';

  /** 元数据（可选） */
  metadata?: {
    /** 导出者 */
    exporter?: string;

    /** 描述 */
    description?: string;

    /** 自定义字段 */
    [key: string]: any;
  };
}

/**
 * Cookie 统计信息
 */
export interface CookieStats {
  /** 总数 */
  total: number;

  /** 按域名分组 */
  byDomain: Record<string, number>;

  /** Secure cookies 数量 */
  secureCount: number;

  /** HttpOnly cookies 数量 */
  httpOnlyCount: number;

  /** Session cookies 数量 */
  sessionCount: number;

  /** 持久化 cookies 数量 */
  persistentCount: number;
}

/**
 * Cookie 操作结果
 */
export interface CookieOperationResult {
  /** 是否成功 */
  success: boolean;

  /** 影响的 cookies 数量 */
  affectedCount: number;

  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * Electron Cookie 类型别名
 */
export type { ElectronCookie };
