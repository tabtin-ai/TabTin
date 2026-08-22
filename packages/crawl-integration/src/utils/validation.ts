/**
 * 简单的验证工具
 * 用于验证 AccessResult 数据结构的一致性
 */

import { AccessResult, PerformanceTiming } from '../types/access-result.js';

/**
 * 验证时序一致性：total === (ttfb + download)
 */
export function validateTimingConsistency(timing: PerformanceTiming, tolerance = 5): boolean {
  const expectedTotal = timing.ttfb + timing.download;
  const actualTotal = timing.total;
  return Math.abs(actualTotal - expectedTotal) <= tolerance;
}

/**
 * 验证传输大小一致性：response.transferSize === network.requests[0].transferSize
 */
export function validateTransferSizeConsistency(result: AccessResult): boolean {
  if (!result.network?.requests.length) {
    return true; // 没有网络请求时认为一致
  }

  const responseTransferSize = result.response.transferSize;
  const networkTransferSize = result.network.requests[0].transferSize;

  // 两者都存在时才比较
  if (responseTransferSize !== undefined && networkTransferSize !== undefined) {
    return responseTransferSize === networkTransferSize;
  }

  return true; // 有一个不存在时认为一致
}

/**
 * 验证 robots.txt 字段自洽性
 */
export function validateRobotsConsistency(result: AccessResult): boolean {
  const robotsDetails = result.security.robotsDetails;
  if (!robotsDetails) {
    return true; // 没有 robotsDetails 时认为一致
  }

  // 如果 source 为 null，rule 应该包含 "no robots.txt"
  if (robotsDetails.source === null) {
    return robotsDetails.rule.includes('no robots.txt');
  }

  // 如果 source 不为 null，rule 不应该说没有 robots.txt
  return !robotsDetails.rule.includes('no robots.txt');
}

/**
 * 验证 payload 结构
 */
export function validatePayloadStructure(result: AccessResult): boolean {
  if (!result.payloads || result.payloads.length === 0) {
    return false; // 必须至少有一个 payload
  }

  // 检查是否有主 payload
  const primaryPayloads = result.payloads.filter(p => p.primary === true);
  if (primaryPayloads.length !== 1) {
    return false; // 必须有且仅有一个主 payload
  }

  // 检查所有 payload 都有必需字段
  return result.payloads.every(payload =>
    payload.type &&
    payload.contentType &&
    payload.data !== undefined &&
    typeof payload.size === 'number' &&
    payload.checksum &&
    typeof payload.truncated === 'boolean'  // 新增：检查 truncated 字段
  );
}

/**
 * 验证头部一致性：response.headers.vary 与 cacheHints.vary 应该一致
 */
export function validateHeaderConsistency(result: AccessResult): boolean {
  const responseVary = result.response.headers.vary;
  const cacheHintsVary = result.response.cacheHints?.vary;

  // 如果两者都存在，应该相等
  if (responseVary && cacheHintsVary) {
    return responseVary === cacheHintsVary;
  }

  // 如果只有一个存在，也认为一致（可能是正常情况）
  return true;
}

/**
 * 验证 TLS 一致性：HTTP 链路不应该有 tls 对象
 */
export function validateTlsConsistency(result: AccessResult): boolean {
  const isHttps = result.security.usesTLS;
  const hasTlsInfo = !!result.request.tls;

  // HTTPS 可以有或没有 TLS 信息，HTTP 不应该有 TLS 信息
  if (!isHttps && hasTlsInfo) {
    return false; // HTTP 链路不应该有 TLS 信息
  }

  return true;
}

/**
 * 综合验证 AccessResult
 */
export function validateAccessResult(result: AccessResult): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 验证时序一致性
  if (result.network?.timing && !validateTimingConsistency(result.network.timing)) {
    errors.push('Timing inconsistency: total !== (ttfb + download)');
  }

  // 验证传输大小一致性
  if (!validateTransferSizeConsistency(result)) {
    errors.push('Transfer size inconsistency between response and network.requests[0]');
  }

  // 验证 robots.txt 一致性
  if (!validateRobotsConsistency(result)) {
    errors.push('Robots.txt field inconsistency between source and rule');
  }

  // 验证 payload 结构
  if (!validatePayloadStructure(result)) {
    errors.push('Invalid payload structure');
  }

  // 验证头部一致性
  if (!validateHeaderConsistency(result)) {
    errors.push('Header inconsistency between response.headers.vary and cacheHints.vary');
  }

  // 验证 TLS 一致性
  if (!validateTlsConsistency(result)) {
    errors.push('TLS inconsistency: HTTP request should not have TLS info');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
