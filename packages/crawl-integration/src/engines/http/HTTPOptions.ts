/**
 * HTTP 引擎专用选项
 */

import { HttpScrapeOptions } from '../../types/options.js';

// HTTP 引擎初始化选项
export interface HTTPEngineOptions {
  maxConcurrency?: number;
  timeout?: number;
  retries?: number;
  userAgent?: string;
  defaultHeaders?: Record<string, string>;

  // 扩展配置
  extended?: import('../../config/extended-options').ExtendedHTTPConfig;
}

// HTTP 请求选项（扩展基础选项）
export interface HTTPRequestOptions extends HttpScrapeOptions {
  // HTTP 特有选项已在 HttpScrapeOptions 中定义
  // 这里可以添加 HTTP 引擎特有的额外选项

  // 连接选项
  keepAlive?: boolean;
  maxSockets?: number;

  // 重试选项
  retryDelay?: number;
  retryCondition?: (error: any) => boolean;

  // 响应处理选项
  responseType?: 'text' | 'json' | 'buffer' | 'stream';
  maxContentLength?: number;

  // 调试选项
  debug?: boolean;
  logRequests?: boolean;

  // 扩展配置
  extended?: import('../../config/extended-options').ExtendedHTTPConfig;
}

// 默认的 HTTP 引擎选项
export const DEFAULT_HTTP_ENGINE_OPTIONS: HTTPEngineOptions = {
  maxConcurrency: 50,
  timeout: 30000,
  retries: 3,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  defaultHeaders: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  }
};

// 默认的 HTTP 请求选项
export const DEFAULT_HTTP_REQUEST_OPTIONS: Partial<HTTPRequestOptions> = {
  method: 'GET',
  timeout: 30000,
  retries: 3,
  keepAlive: true,
  maxSockets: 10,
  retryDelay: 1000,
  responseType: 'text',
  maxContentLength: 10 * 1024 * 1024, // 10MB
  debug: false,
  logRequests: true
};
