/**
 * HTTP 客户端封装
 * 提供统一的 HTTP 请求接口
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { ProxyConfig } from '../../types/options.js';
import { CrawlLogger } from '../../logger/CrawlLogger.js';
import { getSystemUserAgent } from '../../utils/system-ua.js';

export interface HTTPClientConfig {
  timeout?: number;
  maxRedirects?: number;
  userAgent?: string;
  proxy?: ProxyConfig;
  headers?: Record<string, string>;
}

export class HTTPClient {
  private client: AxiosInstance;
  private logger: any;

  constructor(config: HTTPClientConfig = {}) {
    this.logger = CrawlLogger.getInstance().namespace('HTTPClient');
    this.client = this.createClient(config);
  }

  private createClient(config: HTTPClientConfig): AxiosInstance {
    const client = axios.create({
      timeout: config.timeout || 30000,
      maxRedirects: config.maxRedirects || 5,
      validateStatus: () => true, // 不要自动抛出错误
      headers: {
        // ✅ 修复：使用系统 UA 而非硬编码 Windows UA
        'User-Agent': config.userAgent || getSystemUserAgent(),
        ...config.headers
      }
    });

    // 设置代理
    if (config.proxy) {
      client.defaults.proxy = {
        host: config.proxy.host,
        port: config.proxy.port,
        auth: config.proxy.username ? {
          username: config.proxy.username,
          password: config.proxy.password || ''
        } : undefined,
        protocol: config.proxy.protocol || 'http'
      };
    }

    return client;
  }

  /**
   * 发送 HTTP 请求
   */
  async request(config: AxiosRequestConfig): Promise<AxiosResponse> {
    try {
      this.logger.debug('发送 HTTP 请求', {
        url: config.url,
        method: config.method?.toUpperCase() || 'GET'
      });

      const response = await this.client.request(config);

      this.logger.debug('HTTP 请求完成', {
        url: config.url,
        status: response.status,
        size: this.getResponseSize(response)
      });

      return response;
    } catch (error) {
      this.logger.error('HTTP 请求失败', {
        url: config.url,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * GET 请求
   */
  async get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.request({ ...config, url, method: 'GET' });
  }

  /**
   * POST 请求
   */
  async post(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.request({ ...config, url, method: 'POST', data });
  }

  /**
   * PUT 请求
   */
  async put(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.request({ ...config, url, method: 'PUT', data });
  }

  /**
   * DELETE 请求
   */
  async delete(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.request({ ...config, url, method: 'DELETE' });
  }

  /**
   * 更新客户端配置
   */
  updateConfig(config: Partial<HTTPClientConfig>): void {
    if (config.timeout) {
      this.client.defaults.timeout = config.timeout;
    }

    if (config.userAgent) {
      this.client.defaults.headers['User-Agent'] = config.userAgent;
    }

    if (config.headers) {
      Object.assign(this.client.defaults.headers, config.headers);
    }

    if (config.proxy) {
      this.client.defaults.proxy = {
        host: config.proxy.host,
        port: config.proxy.port,
        auth: config.proxy.username ? {
          username: config.proxy.username,
          password: config.proxy.password || ''
        } : undefined,
        protocol: config.proxy.protocol || 'http'
      };
    }

    this.logger.debug('HTTP 客户端配置已更新', config);
  }

  /**
   * 获取响应大小
   */
  private getResponseSize(response: AxiosResponse): number {
    const contentLength = response.headers['content-length'];
    if (contentLength) {
      return parseInt(contentLength, 10);
    }

    // 估算响应大小
    if (typeof response.data === 'string') {
      return Buffer.byteLength(response.data, 'utf8');
    } else if (Buffer.isBuffer(response.data)) {
      return response.data.length;
    } else if (response.data && typeof response.data === 'object') {
      return Buffer.byteLength(JSON.stringify(response.data), 'utf8');
    }

    return 0;
  }

  /**
   * 获取客户端实例（用于高级用法）
   */
  getClient(): AxiosInstance {
    return this.client;
  }
}
