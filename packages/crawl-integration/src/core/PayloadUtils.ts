/**
 * Payload 工具类
 * 提供类型安全的 Payload 创建和处理方法
 */

import crypto from 'crypto';
import { Payload, DEFAULT_LIMITS } from '../types/access-result.js';

export type PayloadCreateOptions = {
  primary?: boolean;
  source?: string;
  limit?: number;
};

export class PayloadUtils {
  /**
   * 创建 HTML 载荷（统一接口）
   */
  static createHtmlPayload(html: string, encoding = 'utf-8', options?: PayloadCreateOptions): Payload {
    const maxSize = options?.limit ?? DEFAULT_LIMITS.MAIN_PAYLOAD_MAX;
    const { data, truncated } = this.truncateIfNeeded(html, maxSize);

    return {
      type: 'html',
      contentType: 'text/html',
      encoding,
      data,
      truncated: truncated || false,  // 明确设置 truncated 字段
      size: Buffer.byteLength(data, encoding as BufferEncoding),
      checksum: this.calculateChecksum(data),
      primary: options?.primary,
      source: options?.source
    };
  }

  /**
   * 创建 HTML 载荷（向后兼容）
   */
  static createHtmlMainPayload(html: string, encoding = 'utf-8'): Payload {
    const { data, truncated } = this.truncateIfNeeded(html, DEFAULT_LIMITS.MAIN_PAYLOAD_MAX);

    return {
      type: 'html',
      contentType: 'text/html',
      encoding,
      data,
      truncated,
      size: Buffer.byteLength(data, encoding as BufferEncoding),
      checksum: this.calculateChecksum(data)
    };
  }

  /**
   * 创建 JSON 载荷（统一接口）
   */
  static createJsonPayload(data: unknown, options?: PayloadCreateOptions): Payload {
    const jsonString = JSON.stringify(data);
    const maxSize = options?.limit ?? DEFAULT_LIMITS.MAIN_PAYLOAD_MAX;
    const { data: truncatedData, truncated } = this.truncateJsonIfNeeded(data, maxSize);

    return {
      type: 'json',
      contentType: 'application/json',
      data: truncated ? truncatedData : data,
      size: Buffer.byteLength(jsonString, 'utf-8'),
      checksum: this.calculateChecksum(jsonString),
      truncated: truncated || false,  // 明确设置 truncated 字段
      primary: options?.primary,
      source: options?.source
    };
  }

  /**
   * 创建 JSON 载荷（向后兼容）
   */
  static createJsonMainPayload(data: unknown): Payload {
    const jsonString = JSON.stringify(data);

    return {
      type: 'json',
      contentType: 'application/json',
      data,
      size: Buffer.byteLength(jsonString, 'utf-8'),
      checksum: this.calculateChecksum(jsonString)
    };
  }

  /**
   * 创建文本载荷（统一接口）
   */
  static createTextPayload(text: string, contentType: string, encoding = 'utf-8', options?: PayloadCreateOptions): Payload {
    const maxSize = options?.limit ?? DEFAULT_LIMITS.MAIN_PAYLOAD_MAX;
    const { data, truncated } = this.truncateIfNeeded(text, maxSize);

    return {
      type: 'text',
      contentType,
      encoding,
      data,
      truncated: truncated || false,  // 明确设置 truncated 字段
      size: Buffer.byteLength(data, encoding as BufferEncoding),
      checksum: this.calculateChecksum(data),
      primary: options?.primary,
      source: options?.source
    };
  }

  /**
   * 创建文本载荷（向后兼容）
   */
  static createTextMainPayload(text: string, contentType: string, encoding = 'utf-8'): Payload {
    const { data, truncated } = this.truncateIfNeeded(text, DEFAULT_LIMITS.MAIN_PAYLOAD_MAX);

    return {
      type: 'text',
      contentType,
      encoding,
      data,
      truncated,
      size: Buffer.byteLength(data, encoding as BufferEncoding),
      checksum: this.calculateChecksum(data)
    };
  }

  /**
   * 创建二进制载荷（统一接口）
   */
  static createBinaryPayload(buffer: Buffer, contentType: string, options?: PayloadCreateOptions): Payload {
    // 二进制数据如果超过限制，直接截断
    const maxSize = options?.limit ?? DEFAULT_LIMITS.MAIN_PAYLOAD_MAX;
    const truncated = buffer.length > maxSize;
    const data = truncated ? buffer.subarray(0, maxSize) : buffer;

    return {
      type: 'binary',
      contentType,
      data,
      size: data.length,
      checksum: this.calculateChecksum(data),
      truncated: truncated || false,  // 明确设置 truncated 字段
      primary: options?.primary,
      source: options?.source
    };
  }

  /**
   * 创建二进制载荷（向后兼容）
   */
  static createBinaryMainPayload(buffer: Buffer, contentType: string): Payload {
    // 二进制数据如果超过限制，直接截断
    const truncated = buffer.length > DEFAULT_LIMITS.MAIN_PAYLOAD_MAX;
    const data = truncated ? buffer.subarray(0, DEFAULT_LIMITS.MAIN_PAYLOAD_MAX) : buffer;

    return {
      type: 'binary',
      contentType,
      data,
      size: data.length,
      checksum: this.calculateChecksum(data)
    };
  }

  /**
   * 创建 XHR JSON 样本载荷
   */
  static createXhrJsonSample(source: string, data: unknown, limit?: number): Payload {
    const jsonString = JSON.stringify(data);
    const maxSize = limit ?? DEFAULT_LIMITS.SAMPLE_PAYLOAD_MAX;
    const { data: truncatedData, truncated } = this.truncateJsonIfNeeded(data, maxSize);

    return {
      type: 'xhr_json',
      contentType: 'application/json',
      source,
      data: truncatedData,
      size: Buffer.byteLength(jsonString, 'utf-8'),
      checksum: this.calculateChecksum(jsonString),
      truncated
    };
  }

  /**
   * 创建 CSS 样本载荷
   */
  static createCssSample(source: string, css: string, limit?: number): Payload {
    const maxSize = limit ?? DEFAULT_LIMITS.SAMPLE_PAYLOAD_MAX;
    const { data, truncated } = this.truncateIfNeeded(css, maxSize);

    return {
      type: 'css',
      contentType: 'text/css',
      encoding: 'utf-8',
      source,
      data,
      size: Buffer.byteLength(data, 'utf-8'),
      checksum: this.calculateChecksum(data),
      truncated
    };
  }

  /**
   * 创建 JavaScript 样本载荷
   */
  static createJsSample(source: string, js: string, limit?: number): Payload {
    const maxSize = limit ?? DEFAULT_LIMITS.SAMPLE_PAYLOAD_MAX;
    const { data, truncated } = this.truncateIfNeeded(js, maxSize);

    return {
      type: 'js',
      contentType: 'application/javascript',
      encoding: 'utf-8',
      source,
      data,
      size: Buffer.byteLength(data, 'utf-8'),
      checksum: this.calculateChecksum(data),
      truncated
    };
  }

  /**
   * 创建图片样本载荷
   */
  static createImageSample(source: string, buffer: Buffer): Payload {
    const truncated = buffer.length > DEFAULT_LIMITS.SAMPLE_PAYLOAD_MAX;
    const data = truncated ? buffer.subarray(0, DEFAULT_LIMITS.SAMPLE_PAYLOAD_MAX) : buffer;

    return {
      type: 'image',
      contentType: 'image/unknown',
      source,
      data,
      size: data.length,
      checksum: this.calculateChecksum(data),
      truncated
    };
  }

  /**
   * 类型守卫：检查是否为 HTML 载荷（统一接口）
   */
  static isHtmlPayload(payload: Payload): payload is Extract<Payload, { type: 'html' }> {
    return payload.type === 'html';
  }

  /**
   * 类型守卫：检查是否为 JSON 载荷（统一接口）
   */
  static isJsonPayload(payload: Payload): payload is Extract<Payload, { type: 'json' }> {
    return payload.type === 'json';
  }

  /**
   * 类型守卫：检查是否为文本载荷（统一接口）
   */
  static isTextPayload(payload: Payload): payload is Extract<Payload, { type: 'text' }> {
    return payload.type === 'text';
  }

  /**
   * 类型守卫：检查是否为二进制载荷（统一接口）
   */
  static isBinaryPayload(payload: Payload): payload is Extract<Payload, { type: 'binary' }> {
    return payload.type === 'binary';
  }

  /**
   * 类型守卫：检查是否为 XML 载荷
   */
  static isXmlPayload(payload: Payload): payload is Extract<Payload, { type: 'xml' }> {
    return payload.type === 'xml';
  }

  /**
   * 类型守卫：检查是否为 CSS 载荷
   */
  static isCssPayload(payload: Payload): payload is Extract<Payload, { type: 'css' }> {
    return payload.type === 'css';
  }

  /**
   * 类型守卫：检查是否为 JavaScript 载荷
   */
  static isJsPayload(payload: Payload): payload is Extract<Payload, { type: 'js' }> {
    return payload.type === 'js';
  }

  /**
   * 类型守卫：检查是否为主载荷
   */
  static isPrimaryPayload(payload: Payload): boolean {
    return payload.primary === true;
  }

  /**
   * 从载荷数组中获取主载荷
   */
  static getPrimaryPayload(payloads: Payload[]): Payload | null {
    return payloads.find(p => p.primary === true) || null;
  }

  /**
   * 从载荷数组中获取样本载荷
   */
  static getSamplePayloads(payloads: Payload[]): Payload[] {
    return payloads.filter(p => p.primary !== true);
  }

  /**
   * 类型守卫：检查是否为 XHR JSON 样本
   */
  static isXhrJsonSample(payload: Payload): payload is Extract<Payload, { type: 'xhr_json' }> {
    return payload.type === 'xhr_json';
  }

  /**
   * 类型守卫：检查是否为 CSS 样本
   */
  static isCssSample(payload: Payload): payload is Extract<Payload, { type: 'css' }> {
    return payload.type === 'css';
  }

  /**
   * 类型守卫：检查是否为 JavaScript 样本
   */
  static isJsSample(payload: Payload): payload is Extract<Payload, { type: 'js' }> {
    return payload.type === 'js';
  }

  /**
   * 类型守卫：检查是否为图片样本
   */
  static isImageSample(payload: Payload): payload is Extract<Payload, { type: 'image' }> {
    return payload.type === 'image';
  }

  /**
   * 计算校验和
   */
  static calculateChecksum(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * 安全截断文本，避免破坏 UTF-8 字符
   */
  static truncateIfNeeded(data: string, maxSize: number): { data: string; truncated: boolean } {
    const byteLength = Buffer.byteLength(data, 'utf-8');
    if (byteLength <= maxSize) {
      return { data, truncated: false };
    }

    // 安全截断，避免破坏 UTF-8 字符
    let truncated = data;
    while (Buffer.byteLength(truncated, 'utf-8') > maxSize) {
      truncated = truncated.slice(0, -1);
    }

    return { data: truncated, truncated: true };
  }

  /**
   * 截断 JSON 数据
   */
  static truncateJsonIfNeeded(data: unknown, maxSize: number): { data: unknown; truncated: boolean } {
    const jsonString = JSON.stringify(data);
    const byteLength = Buffer.byteLength(jsonString, 'utf-8');

    if (byteLength <= maxSize) {
      return { data, truncated: false };
    }

    // 对于 JSON，我们尝试截断字符串字段
    if (typeof data === 'object' && data !== null) {
      const truncatedData = this.truncateJsonObject(data, maxSize);
      return { data: truncatedData, truncated: true };
    }

    // 如果是字符串，直接截断
    if (typeof data === 'string') {
      const { data: truncatedString } = this.truncateIfNeeded(data, maxSize);
      return { data: truncatedString, truncated: true };
    }

    // 其他类型，返回简化版本
    return { data: '[TRUNCATED_OBJECT]', truncated: true };
  }

  /**
   * 递归截断 JSON 对象中的字符串字段
   */
  private static truncateJsonObject(obj: any, maxSize: number): any {
    if (typeof obj === 'string') {
      if (Buffer.byteLength(obj, 'utf-8') > 1000) { // 截断长字符串
        return obj.substring(0, 500) + '...[TRUNCATED]';
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      // 限制数组长度
      const maxArrayLength = 100;
      const truncatedArray = obj.slice(0, maxArrayLength).map(item =>
        this.truncateJsonObject(item, maxSize)
      );

      if (obj.length > maxArrayLength) {
        truncatedArray.push(`...[${obj.length - maxArrayLength} more items]`);
      }

      return truncatedArray;
    }

    if (typeof obj === 'object' && obj !== null) {
      const truncatedObj: any = {};
      let processedKeys = 0;
      const maxKeys = 50; // 限制对象键数量

      for (const [key, value] of Object.entries(obj)) {
        if (processedKeys >= maxKeys) {
          truncatedObj['...[MORE_KEYS]'] = `${Object.keys(obj).length - maxKeys} more keys`;
          break;
        }

        truncatedObj[key] = this.truncateJsonObject(value, maxSize);
        processedKeys++;
      }

      return truncatedObj;
    }

    return obj;
  }

  /**
   * 获取载荷的可读大小描述
   */
  static formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  /**
   * 验证载荷完整性
   */
  static validatePayload(payload: Payload): boolean {
    try {
      let dataToCheck: string | Buffer;

      if (payload.type === 'binary') {
        dataToCheck = payload.data;
      } else if (payload.type === 'json') {
        dataToCheck = JSON.stringify(payload.data);
      } else {
        dataToCheck = payload.data as string;
      }

      const calculatedChecksum = this.calculateChecksum(dataToCheck);
      return calculatedChecksum === payload.checksum;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取载荷的 MIME 类型
   */
  static getMimeType(payload: Payload): string {
    return payload.contentType;
  }

  /**
   * 检查载荷是否被截断
   */
  static isTruncated(payload: Payload): boolean {
    return 'truncated' in payload && payload.truncated === true;
  }

  /**
   * 获取载荷的编码（如果适用）
   */
  static getEncoding(payload: Payload): string | null {
    if ('encoding' in payload) {
      return payload.encoding;
    }
    return null;
  }

  /**
   * 将载荷转换为字符串表示（用于调试）
   */
  static toString(payload: Payload): string {
    switch (payload.type) {
      case 'html':
      case 'text':
        return payload.data;
      case 'json':
        return JSON.stringify(payload.data, null, 2);
      case 'binary':
        return `[Binary data: ${this.formatSize(payload.size)}]`;
      default:
        return '[Unknown payload type]';
    }
  }
}
