/**
 * URL 安全校验 — SSRF 防护 + 导航安全策略
 *
 * 合并 Electron / Daemon 两端最严格的实现，作为跨端 SSOT。
 * 覆盖：私有 IP（含替代编码绕过）、云 metadata 域名、
 * IPv6 私有段、URL userinfo 绕过、scheme 白名单。
 *
 * 禁止在任何端（Electron / Daemon / CLI）本地重复实现这些功能。
 */

// ── Private IPv4 Detection ──────────────────────────────────────

/**
 * 标准 IPv4 私有/保留地址段：
 * - 0.0.0.0/8        (current network)
 * - 127.0.0.0/8      (loopback)
 * - 10.0.0.0/8       (private, class A)
 * - 172.16.0.0/12    (private, class B)
 * - 192.168.0.0/16   (private, class C)
 * - 169.254.0.0/16   (link-local)
 * - 100.64.0.0/10    (CGNAT / shared address)
 * - 198.18.0.0/15    (benchmarking)
 */
export function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  return (
    o1 === 0 ||
    o1 === 127 ||
    o1 === 10 ||
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 168) ||
    (o1 === 169 && o2 === 254) ||
    (o1 === 100 && o2 >= 64 && o2 <= 127) ||
    (o1 === 198 && (o2 === 18 || o2 === 19))
  );
}

/**
 * 解析浏览器接受但 Node URL 不规范化的替代 IPv4 表示：
 * - 十六进制整数：0x7f000001
 * - 十进制长整数：2130706433
 * - 八进制分段：0177.0.0.1
 * - 混合分段：0x7f.0.0.1
 *
 * 返回标准点分十进制，无法识别时返回 null。
 */
export function parseAlternativeIPv4(h: string): string | null {
  if (/^0x[0-9a-f]{1,8}$/i.test(h)) {
    const n = parseInt(h, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }
  if (/^\d{1,10}$/.test(h)) {
    const n = Number(h);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }
  const parts = h.split('.');
  if (parts.length === 4) {
    const octets = parts.map((p) => {
      if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
      if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
      return parseInt(p, 10);
    });
    if (octets.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
      return octets.join('.');
    }
  }
  return null;
}

// ── Private Host Detection ──────────────────────────────────────

/**
 * 检测 hostname 是否为私有/保留地址。覆盖：
 * - localhost 系列
 * - Cloud metadata 域名（GCP / 通用）
 * - 标准 + 替代表示法 IPv4
 * - IPv6 环回、未指定、ULA、Link-local
 * - IPv4-mapped IPv6（点分 + 十六进制两种形式）
 */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.replace(/%.*$/, '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (h === 'metadata.google.internal' || h === 'metadata.internal') return true;

  if (isPrivateIPv4(h)) return true;

  const altIp = parseAlternativeIPv4(h);
  if (altIp !== null && isPrivateIPv4(altIp)) return true;

  // IPv6 loopback
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv6 unspecified
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return true;
  // ULA fc00::/7
  if (/^f[cd][0-9a-f]*:/i.test(h)) return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]*:/i.test(h)) return true;

  // IPv4-mapped IPv6 — dotted (::ffff:127.0.0.1)
  const v4Dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Dotted) return isPrivateIPv4(v4Dotted[1]);

  // IPv4-mapped IPv6 — hex (::ffff:7f00:1)
  const v4Hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4Hex) {
    const hi = parseInt(v4Hex[1], 16);
    const lo = parseInt(v4Hex[2], 16);
    return isPrivateIPv4(
      `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`,
    );
  }

  return false;
}

// ── URL Validation ──────────────────────────────────────────────

const DEFAULT_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Electron 风格校验：返回 {ok, error}。
 * allowedProtocols 可扩展（如 Electron 需额外放行 about:）。
 */
export function validateNavigationUrl(
  url: string,
  options?: { allowedProtocols?: Set<string> },
): ValidationResult {
  if (!url || url === 'about:blank') return { ok: true };

  const allowed = options?.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }

  if (!allowed.has(parsed.protocol)) {
    return { ok: false, error: `Blocked scheme: ${parsed.protocol}` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: `Blocked URL with userinfo: ${parsed.hostname}` };
  }

  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, error: `Blocked private host: ${parsed.hostname}` };
  }

  return { ok: true };
}

/**
 * Daemon 风格校验：不合法时 throw Error。
 */
export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 URL: ${url}`);
  }

  if (!DEFAULT_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `不允许的 URL 协议 "${parsed.protocol}" — 仅允许 http: 和 https:`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(`不允许带有用户信息的 URL: ${parsed.hostname}`);
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`不允许访问内网地址 "${parsed.hostname}" — 禁止 SSRF`);
  }
}

/**
 * 简单 scheme 白名单检查（不含 SSRF 检测）。
 * Electron 在 isAllowedUrl 中额外放行 about: 协议。
 */
export function isAllowedScheme(
  url: string,
  extraProtocols?: string[],
): boolean {
  if (!url || url === 'about:blank') return true;
  try {
    const parsed = new URL(url);
    if (DEFAULT_ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;
    return extraProtocols?.includes(parsed.protocol) ?? false;
  } catch {
    return false;
  }
}
