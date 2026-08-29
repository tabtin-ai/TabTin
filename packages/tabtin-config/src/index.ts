import { t } from './i18n.js';

export type EnvLike = Record<string, string | undefined>;

export interface ApiRuntimeConfig {
  apiBaseUrl: string;
  apiOrigin: string;
  chatApiBaseUrl: string;
  wsBaseUrl: string;
  publicWebBaseUrl?: string;
}

const API_BASE_ENV_KEYS = ['TABTIN_API_BASE_URL', 'VITE_API_BASE_URL'] as const;
const PUBLIC_WEB_BASE_ENV_KEYS = ['TABTIN_PUBLIC_WEB_BASE_URL', 'VITE_PUBLIC_WEB_BASE_URL'] as const;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const TABTIN_INVITE_BRIDGE_PATH = '/invite';
export const TABTIN_DESKTOP_INVITE_SCHEME = 'tabtin://invite';
const TABTIN_PREPROD_DESKTOP_INVITE_SCHEME = 'tabtin-preprod://invite';
const TABTIN_DEV_DESKTOP_INVITE_SCHEME = 'tabtin-dev://invite';
export const TABTIN_DOWNLOAD_URL = 'https://www.example.com/download/';

function readEnv(env: EnvLike | undefined, key: string): string | undefined {
  if (env && key in env) return env[key];
  if (typeof process !== 'undefined' && process.env?.[key]) return process.env[key];

  try {
    // React Native 可能不支持 import.meta，因此包裹在 try/catch 中
    // @ts-ignore
    const metaEnv = (import.meta as any)?.env;
    if (metaEnv && key in metaEnv) return metaEnv[key];
  } catch {
    // 忽略错误
  }

  return undefined;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function isPrivateLanHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isLocalHttpHost(normalized)) return true;

  const ipv4 = normalized.split('.').map((part) => Number(part));
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second] = ipv4;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }

  if (!normalized.includes(':')) return false;
  const firstHextet = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  return (
    Number.isInteger(firstHextet) &&
    ((firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80)
  );
}

function normalizePublicInviteWebBaseUrl(value: string): string {
  const normalized = normalizeUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid public invite web base URL: ${value}`);
  }

  if (parsed.protocol === 'https:') {
    return normalized;
  }
  if (parsed.protocol === 'http:' && isPrivateLanHttpHost(parsed.hostname)) {
    return normalized;
  }
  throw new Error('Public invite links must use HTTPS web URLs outside localhost or a private LAN');
}

export function isSupportedInviteToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && INVITE_TOKEN_PATTERN.test(token);
}

function encodeInviteToken(token: string): string {
  const trimmed = token.trim();
  if (!isSupportedInviteToken(trimmed)) {
    throw new Error('Invalid invitation token');
  }
  return encodeURIComponent(trimmed);
}

function resolveDesktopInviteScheme(publicWebBaseUrl?: string): string {
  if (!publicWebBaseUrl) return TABTIN_DESKTOP_INVITE_SCHEME;

  try {
    const hostname = new URL(publicWebBaseUrl).hostname.toLowerCase();
    if (hostname === 'web-test.example.com') return TABTIN_PREPROD_DESKTOP_INVITE_SCHEME;
    if (isPrivateLanHttpHost(hostname)) return TABTIN_DEV_DESKTOP_INVITE_SCHEME;
  } catch {
    // 调用方仍可使用历史单参数形式；无效环境地址不应破坏邀请 token 生成。
  }

  return TABTIN_DESKTOP_INVITE_SCHEME;
}

export function buildDesktopInviteDeepLink(token: string, publicWebBaseUrl?: string): string {
  return `${resolveDesktopInviteScheme(publicWebBaseUrl)}/${encodeInviteToken(token)}`;
}

export function buildPublicInviteBridgeUrl(publicWebBaseUrl: string | undefined, token: string): string | undefined {
  if (!publicWebBaseUrl) return undefined;
  return `${normalizePublicInviteWebBaseUrl(publicWebBaseUrl)}${TABTIN_INVITE_BRIDGE_PATH}/${encodeInviteToken(token)}`;
}

function ensureValidUrl(value: string, name: string): void {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    throw new Error(t('errors.invalidUrl', { name, value }));
  }
}

function requireApiBaseUrl(env?: EnvLike): string {
  const tabtinBase = readEnv(env, API_BASE_ENV_KEYS[0]);
  const viteBase = readEnv(env, API_BASE_ENV_KEYS[1]);
  const normalizedTabtin = tabtinBase ? normalizeUrl(tabtinBase) : undefined;
  const normalizedVite = viteBase ? normalizeUrl(viteBase) : undefined;

  if (normalizedTabtin && normalizedVite && normalizedTabtin !== normalizedVite) {
    throw new Error(
      t('errors.apiBaseUrlConflict', {
        tabtinKey: API_BASE_ENV_KEYS[0],
        tabtinValue: normalizedTabtin,
        viteKey: API_BASE_ENV_KEYS[1],
        viteValue: normalizedVite,
      })
    );
  }

  const resolved = normalizedTabtin || normalizedVite;
  if (!resolved) {
    throw new Error(t('errors.apiBaseUrlMissing', { keys: API_BASE_ENV_KEYS.join(', ') }));
  }

  ensureValidUrl(resolved, 'API_BASE_URL');
  if (!resolved.endsWith('/api')) {
    throw new Error(t('errors.apiBaseUrlMustEndWithApi', { value: resolved }));
  }

  return resolved;
}

function deriveApiOrigin(apiBaseUrl: string): string {
  const normalized = normalizeUrl(apiBaseUrl);
  if (normalized.endsWith('/api')) {
    const trimmed = normalized.slice(0, -4);
    return trimmed.length > 0 ? trimmed : normalized;
  }
  return normalized;
}

function deriveWsBaseUrl(apiOrigin: string): string {
  if (apiOrigin.startsWith('https://')) return apiOrigin.replace(/^https:/, 'wss:');
  if (apiOrigin.startsWith('http://')) return apiOrigin.replace(/^http:/, 'ws:');
  return apiOrigin;
}

function resolveOptionalUrl(env: EnvLike | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readEnv(env, key);
    if (value) {
      const normalized = normalizeUrl(value);
      ensureValidUrl(normalized, key);
      return normalized;
    }
  }
  return undefined;
}

function resolvePublicWebBaseUrl(env: EnvLike | undefined): string | undefined {
  const resolved = resolveOptionalUrl(env, [...PUBLIC_WEB_BASE_ENV_KEYS]);
  if (!resolved) return undefined;
  try {
    return normalizePublicInviteWebBaseUrl(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tabtin-config] Ignoring invalid public invite web base URL: ${message}`);
    return undefined;
  }
}

export function resolveApiRuntimeConfig(env?: EnvLike): ApiRuntimeConfig {
  const apiBaseUrl = requireApiBaseUrl(env);
  const apiOrigin = deriveApiOrigin(apiBaseUrl);

  const chatApiBaseUrl = resolveOptionalUrl(env, ['TABTIN_CHAT_API_URL', 'VITE_CHAT_API_URL'])
    ?? `${apiBaseUrl}/chat`;
  const wsBaseUrl = resolveOptionalUrl(env, ['TABTIN_WS_BASE_URL', 'VITE_WS_BASE_URL'])
    ?? deriveWsBaseUrl(apiOrigin);
  const publicWebBaseUrl = resolvePublicWebBaseUrl(env);

  return {
    apiBaseUrl,
    apiOrigin,
    chatApiBaseUrl,
    wsBaseUrl,
    publicWebBaseUrl,
  };
}

let runtimeConfig: ApiRuntimeConfig | null = null;
let runtimeEnv: EnvLike | undefined;

export function setApiRuntimeEnv(env: EnvLike): void {
  runtimeEnv = env;
  runtimeConfig = null;
}

export { setTabtinConfigLocale, setTabtinConfigTranslator } from './i18n.js';
export { API_ENDPOINTS } from './endpoints.js';

/**
 * Derives a canonical apiBaseUrl (ending with `/api`) from a raw server URL.
 * Strips trailing slashes and `/ws` suffix, then ensures the URL ends with `/api`.
 * Designed for daemon / headless runtimes that store a raw origin in config.
 */
export function deriveApiBaseUrl(serverUrl: string): string {
  const stripped = serverUrl.replace(/\/+$/, '').replace(/\/ws$/, '');
  return stripped.endsWith('/api') ? stripped : `${stripped}/api`;
}

/** Bearer 凭据只允许发往 HTTPS；本机开发地址可使用 HTTP。 */
export function requireSecureCredentialApiBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) {
    throw new Error('Credential API URL must not contain user info');
  }
  if (
    parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && isLocalHttpHost(parsed.hostname))
  ) {
    throw new Error('Credential API URL must use HTTPS outside localhost');
  }
  return value;
}

/** 长期登录/设备凭据只允许发往 WSS；本机开发地址可使用 WS。 */
export function requireSecureCredentialWsBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) {
    throw new Error('Credential WebSocket URL must not contain user info');
  }
  if (
    parsed.protocol !== 'wss:'
    && !(parsed.protocol === 'ws:' && isLocalHttpHost(parsed.hostname))
  ) {
    throw new Error('Credential WebSocket URL must use WSS outside localhost');
  }
  return value;
}

/**
 * 安全拼接 API 路径：自动去除 path 中多余的 /api 前缀，防止 /api/api 重复。
 * @example joinApiPath('http://localhost:6060/api', '/rag/v2/search')
 *          // => 'http://localhost:6060/api/rag/v2/search'
 * @example joinApiPath('http://localhost:6060/api', '/api/rag/v2/search')
 *          // => 'http://localhost:6060/api/rag/v2/search'  (自动修正)
 */
export function joinApiPath(baseUrl: string, path: string): string {
  const hadApiPrefix = /^\/api(?=\/|$)/.test(path);
  const normalizedPath = hadApiPrefix ? path.replace(/^\/api(?=\/|$)/, '') : path;
  if (hadApiPrefix && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    const stack = new Error().stack?.split('\n').slice(2, 4).join('\n    ') ?? ''
    console.warn(
      `[joinApiPath] path "${path}" 以 /api 开头，已自动修正为 "${normalizedPath}"。` +
      `请直接使用不含 /api 前缀的路径。\n    ${stack}`
    );
  }
  const sep = normalizedPath.startsWith('/') ? '' : (normalizedPath === '' ? '' : '/');
  return `${baseUrl}${sep}${normalizedPath}`;
}

export function getApiRuntimeConfig(env?: EnvLike): ApiRuntimeConfig {
  if (env) {
    runtimeEnv = env;
    runtimeConfig = null;
  }
  if (!runtimeConfig) {
    runtimeConfig = resolveApiRuntimeConfig(runtimeEnv);
  }
  return runtimeConfig;
}
