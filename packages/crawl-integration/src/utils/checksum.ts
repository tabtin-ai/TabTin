/**
 * SHA256 校验和计算工具
 * 用于缓存键生成和数据完整性验证
 */

import { createHash } from 'crypto';
import { t } from '../i18n.js';

/**
 * 计算字符串的 SHA256 校验和
 */
export function calculateStringChecksum(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * 计算 Buffer 的 SHA256 校验和
 */
export function calculateBufferChecksum(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 计算任意数据的 SHA256 校验和
 */
export function calculateChecksum(data: string | Buffer): string {
  if (Buffer.isBuffer(data)) {
    return calculateBufferChecksum(data);
  }
  return calculateStringChecksum(data);
}

/**
 * 计算对象的 SHA256 校验和（通过 JSON 序列化）
 */
export function calculateObjectChecksum(obj: any): string {
  const jsonString = JSON.stringify(obj, Object.keys(obj).sort());
  return calculateStringChecksum(jsonString);
}

/**
 * 计算文件内容的 SHA256 校验和
 */
export async function calculateFileChecksum(filePath: string): Promise<string> {
  const fs = await import('fs/promises');
  const data = await fs.readFile(filePath);
  return calculateBufferChecksum(data);
}

/**
 * 验证数据的校验和
 */
export function verifyChecksum(data: string | Buffer, expectedChecksum: string): boolean {
  const actualChecksum = calculateChecksum(data);
  return actualChecksum === expectedChecksum;
}

/**
 * 生成短校验和（取前8位）
 */
export function generateShortChecksum(data: string | Buffer): string {
  return calculateChecksum(data).substring(0, 8);
}

/**
 * 批量计算校验和
 */
export function calculateMultipleChecksums(items: (string | Buffer)[]): string[] {
  return items.map(item => calculateChecksum(item));
}

/**
 * 增量校验和计算器（用于大文件或流数据）
 */
export class IncrementalChecksum {
  private hash = createHash('sha256');
  private finalized = false;

  /**
   * 添加数据块
   */
  update(data: string | Buffer): this {
    if (this.finalized) {
      throw new Error(t('errors.checksum.finalizedUpdate'));
    }

    if (typeof data === 'string') {
      this.hash.update(data, 'utf8');
    } else {
      this.hash.update(data);
    }

    return this;
  }

  /**
   * 完成计算并获取校验和
   */
  digest(): string {
    if (this.finalized) {
      throw new Error(t('errors.checksum.alreadyFinalized'));
    }

    this.finalized = true;
    return this.hash.digest('hex');
  }

  /**
   * 重置计算器
   */
  reset(): this {
    this.hash = createHash('sha256');
    this.finalized = false;
    return this;
  }
}

/**
 * 校验和工具类
 */
export class ChecksumUtils {
  /**
   * 比较两个校验和是否相等（时间安全比较）
   */
  static safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }

  /**
   * 生成带时间戳的校验和
   */
  static generateTimestampedChecksum(data: string | Buffer): {
    checksum: string;
    timestamp: number;
    combined: string;
  } {
    const timestamp = Date.now();
    const dataChecksum = calculateChecksum(data);
    const combined = calculateStringChecksum(`${dataChecksum}:${timestamp}`);

    return {
      checksum: dataChecksum,
      timestamp,
      combined
    };
  }

  /**
   * 验证带时间戳的校验和
   */
  static verifyTimestampedChecksum(
    data: string | Buffer,
    timestampedChecksum: string
  ): {
    valid: boolean;
    age?: number;
    expired?: boolean;
  } {
    try {
      // 这里简化实现，实际应该解析时间戳
      const dataChecksum = calculateChecksum(data);
      const valid = timestampedChecksum.includes(dataChecksum);

      return { valid };
    } catch {
      return { valid: false };
    }
  }

  /**
   * 生成多重校验和（MD5 + SHA256）
   */
  static generateMultipleHashes(data: string | Buffer): {
    md5: string;
    sha256: string;
    sha1: string;
  } {
    const input = typeof data === 'string' ? data : data;

    return {
      md5: createHash('md5').update(input).digest('hex'),
      sha256: createHash('sha256').update(input).digest('hex'),
      sha1: createHash('sha1').update(input).digest('hex')
    };
  }
}
