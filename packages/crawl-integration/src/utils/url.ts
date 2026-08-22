/**
 * URL 处理工具
 * 提供 URL 解析、验证、标准化等功能
 */
import net from 'node:net';

// URL 验证结果
export interface URLValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalized?: string;
}

// URL 解析结果
export interface ParsedURL {
  protocol: string;
  hostname: string;
  port?: number;
  pathname: string;
  search: string;
  hash: string;
  origin: string;
  domain: string;
  subdomain?: string;
  tld: string;
}

/**
 * 验证 URL 格式
 */
export function validateURL(url: string): URLValidationResult {
  const result: URLValidationResult = {
    valid: false,
    errors: [],
    warnings: []
  };

  try {
    const parsed = new URL(url);

    // 检查协议
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      result.errors.push(`Unsupported protocol: ${parsed.protocol}`);
    }

    // 检查主机名
    if (!parsed.hostname) {
      result.errors.push('Missing hostname');
    } else if (parsed.hostname.length > 253) {
      result.errors.push('Hostname too long');
    }

    // 检查端口
    if (parsed.port) {
      const portNum = parseInt(parsed.port, 10);
      if (portNum < 1 || portNum > 65535) {
        result.errors.push(`Invalid port: ${parsed.port}`);
      }
    }

    // 检查路径长度
    if (parsed.pathname.length > 2048) {
      result.warnings.push('Very long pathname');
    }

    // 检查查询字符串长度
    if (parsed.search.length > 2048) {
      result.warnings.push('Very long query string');
    }

    result.valid = result.errors.length === 0;
    result.normalized = normalizeURL(url);

  } catch (error) {
    result.errors.push(`Invalid URL format: ${(error as Error).message}`);
  }

  return result;
}

/**
 * 标准化 URL
 */
export function normalizeURL(url: string): string {
  try {
    const parsed = new URL(url);

    // 标准化协议
    parsed.protocol = parsed.protocol.toLowerCase();

    // 标准化主机名
    parsed.hostname = parsed.hostname.toLowerCase();

    // 移除默认端口
    if ((parsed.protocol === 'http:' && parsed.port === '80') ||
        (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }

    // 标准化路径
    if (parsed.pathname === '') {
      parsed.pathname = '/';
    }

    // 移除片段标识符（可选）
    parsed.hash = '';

    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 解析 URL 详细信息
 */
export function parseURL(url: string): ParsedURL | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const parts = hostname.split('.');

    let domain = hostname;
    let subdomain: string | undefined;
    let tld = '';

    if (parts.length >= 2) {
      tld = parts[parts.length - 1];

      if (parts.length === 2) {
        domain = hostname;
      } else {
        domain = parts.slice(-2).join('.');
        subdomain = parts.slice(0, -2).join('.');
      }
    }

    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      origin: parsed.origin,
      domain,
      subdomain,
      tld
    };
  } catch {
    return null;
  }
}

/**
 * 检查是否为相对 URL
 */
export function isRelativeURL(url: string): boolean {
  try {
    new URL(url);
    return false;
  } catch {
    return !url.startsWith('//');
  }
}

/**
 * 检查是否为绝对 URL
 */
export function isAbsoluteURL(url: string): boolean {
  return !isRelativeURL(url);
}

/**
 * 解析相对 URL
 */
export function resolveURL(baseURL: string, relativeURL: string): string {
  try {
    return new URL(relativeURL, baseURL).toString();
  } catch {
    return relativeURL;
  }
}

/**
 * 提取域名
 */
export function extractDomain(url: string): string | null {
  const parsed = parseURL(url);
  return parsed ? parsed.domain : null;
}

/**
 * 提取主机名
 */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * 检查是否为同域 URL
 */
export function isSameDomain(url1: string, url2: string): boolean {
  const domain1 = extractDomain(url1);
  const domain2 = extractDomain(url2);
  return domain1 !== null && domain2 !== null && domain1 === domain2;
}

/**
 * 检查是否为同源 URL
 */
export function isSameOrigin(url1: string, url2: string): boolean {
  try {
    const origin1 = new URL(url1).origin;
    const origin2 = new URL(url2).origin;
    return origin1 === origin2;
  } catch {
    return false;
  }
}

/**
 * 构建查询字符串
 */
export function buildQueryString(params: Record<string, string | number | boolean>): string {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    searchParams.append(key, String(value));
  });

  return searchParams.toString();
}

/**
 * 解析查询字符串
 */
export function parseQueryString(queryString: string): Record<string, string> {
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(queryString);

  searchParams.forEach((value, key) => {
    params[key] = value;
  });

  return params;
}

/**
 * 添加查询参数
 */
export function addQueryParams(url: string, params: Record<string, string | number | boolean>): string {
  try {
    const parsed = new URL(url);

    Object.entries(params).forEach(([key, value]) => {
      parsed.searchParams.set(key, String(value));
    });

    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 移除查询参数
 */
export function removeQueryParams(url: string, paramNames: string[]): string {
  try {
    const parsed = new URL(url);

    paramNames.forEach(name => {
      parsed.searchParams.delete(name);
    });

    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 清理 URL（移除跟踪参数等）
 */
export function cleanURL(url: string, removeParams: string[] = []): string {
  const defaultRemoveParams = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'ref', 'referrer'
  ];

  const paramsToRemove = [...defaultRemoveParams, ...removeParams];
  return removeQueryParams(url, paramsToRemove);
}

/**
 * 检查 URL 是否匹配模式
 */
export function matchesPattern(url: string, pattern: string): boolean {
  // 简单的通配符匹配
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(url);
}

/**
 * 检查 URL 是否匹配多个模式中的任一个
 */
export function matchesAnyPattern(url: string, patterns: string[]): boolean {
  return patterns.some(pattern => matchesPattern(url, pattern));
}

/**
 * 生成 URL 的唯一标识符
 */
export function generateURLId(url: string): string {
  const normalized = normalizeURL(url);
  return Buffer.from(normalized).toString('base64').replace(/[+/=]/g, '');
}

/**
 * URL 安全检查
 */
export interface URLSecurityCheck {
  safe: boolean;
  risks: string[];
  blocked: boolean;
  reason?: string;
}

type HostSecurityResult = {
  blocked: boolean;
  reason?: string;
  risks: string[];
};

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT

  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (normalized === '::1' || normalized === '::') {
    return true;
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true; // fc00::/7
  }

  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true; // fe80::/10
  }

  const mappedMatch = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (mappedMatch && isPrivateIPv4(mappedMatch[1])) {
    return true;
  }

  return false;
}

function checkHostSecurity(hostname: string): HostSecurityResult {
  const risks: string[] = [];
  const normalizedHost = hostname.toLowerCase();

  if (!normalizedHost) {
    return { blocked: true, reason: 'empty hostname', risks: ['Missing hostname'] };
  }

  const localHostnames = new Set([
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
    '0.0.0.0',
    '::1'
  ]);

  if (localHostnames.has(normalizedHost)) {
    return { blocked: true, reason: 'SSRF protection', risks: ['Local host detected'] };
  }

  if (normalizedHost.endsWith('.local') || normalizedHost.endsWith('.localhost')) {
    return { blocked: true, reason: 'SSRF protection', risks: ['Local domain detected'] };
  }

  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion === 4 && isPrivateIPv4(normalizedHost)) {
    return { blocked: true, reason: 'SSRF protection', risks: ['Private IPv4 address detected'] };
  }

  if (ipVersion === 6 && isPrivateIPv6(normalizedHost)) {
    return { blocked: true, reason: 'SSRF protection', risks: ['Private IPv6 address detected'] };
  }

  return { blocked: false, risks };
}

/**
 * 检查 URL 安全性
 */
export function checkURLSecurity(url: string): URLSecurityCheck {
  const result: URLSecurityCheck = {
    safe: true,
    risks: [],
    blocked: false
  };

  try {
    const parsed = new URL(url);

    // 检查协议安全性
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      result.risks.push(`Potentially unsafe protocol: ${parsed.protocol}`);
      result.safe = false;
    }

    const hostSecurity = checkHostSecurity(parsed.hostname);
    if (hostSecurity.risks.length > 0) {
      result.risks.push(...hostSecurity.risks);
    }
    if (hostSecurity.blocked) {
      result.blocked = true;
      result.reason = hostSecurity.reason || 'SSRF protection';
      result.safe = false;
    }

    // 检查可疑的 TLD
    const hostname = parsed.hostname.toLowerCase();
    const suspiciousTlds = ['.tk', '.ml', '.ga', '.cf'];
    const tld = hostname.split('.').pop();
    if (tld && suspiciousTlds.includes(`.${tld}`)) {
      result.risks.push(`Suspicious TLD: .${tld}`);
    }

    // 检查 URL 长度
    if (url.length > 2083) {
      result.risks.push('Extremely long URL');
    }

  } catch (error) {
    result.safe = false;
    result.risks.push(`Invalid URL: ${(error as Error).message}`);
  }

  return result;
}

/**
 * URL 工具类
 */
export class URLUtils {
  /**
   * 批量验证 URL
   */
  static validateMultiple(urls: string[]): Record<string, URLValidationResult> {
    const results: Record<string, URLValidationResult> = {};

    urls.forEach(url => {
      results[url] = validateURL(url);
    });

    return results;
  }

  /**
   * 从文本中提取 URL
   */
  static extractURLs(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    return text.match(urlRegex) || [];
  }

  /**
   * 检查 URL 是否可达（简单检查）
   */
  static async isReachable(url: string, timeout: number = 5000): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 获取 URL 的重定向链
   */
  static async getRedirectChain(url: string, maxRedirects: number = 10): Promise<string[]> {
    const chain: string[] = [url];
    let currentURL = url;

    for (let i = 0; i < maxRedirects; i++) {
      try {
        const response = await fetch(currentURL, {
          method: 'HEAD',
          redirect: 'manual'
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            currentURL = resolveURL(currentURL, location);
            chain.push(currentURL);
          } else {
            break;
          }
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    return chain;
  }
}
