/**
 * 环境变量配置
 *
 * 优先级: 环境变量 > 硬编码默认值。
 * 标准本地开发使用 Django 6060 / Collab Live 4100。
 */

const djangoPort = process.env.DJANGO_BIND_PORT || "6060";
const defaultDjangoUrl = `http://127.0.0.1:${djangoPort}`;
const defaultLivePort = process.env.COLLAB_LIVE_PORT || "4100";
const defaultDebounce = parseInt(process.env.HOCUSPOCUS_DEBOUNCE || "10000", 10);

export const env = {
  PORT: parseInt(process.env.PORT || defaultLivePort, 10),
  /**
   * 监听网卡地址。默认 `0.0.0.0` 与历史行为兼容（dev 局域网设备可访问）；
   * 单机部署 + 反向代理（生产 / preprod）应设为 `127.0.0.1` 限定本机访问，
   * 避免依赖网络层兜底（防火墙 / 安全组）做唯一的访问控制。
   */
  HOST: process.env.HOST || "0.0.0.0",
  DJANGO_API_URL: process.env.DJANGO_API_URL || defaultDjangoUrl,
  LIVE_SECRET: (() => {
    const DEFAULT_DEV_SECRET = "collab-live-dev-secret";
    const MIN_SECRET_LENGTH = 16;
    // Compose/Django share one canonical variable. LIVE_SECRET remains accepted
    // for backwards compatibility with existing standalone Collab deployments.
    const secret = process.env.LIVE_SECRET || process.env.COLLAB_LIVE_SECRET;
    const nodeEnv = process.env.NODE_ENV;
    const isDev = nodeEnv === "development" || nodeEnv === "test";
    const requireSecret = process.env.COLLAB_LIVE_REQUIRE_SECRET === "true";
    const mustHaveRealSecret = !isDev || requireSecret;

    if (secret) {
      if (secret === DEFAULT_DEV_SECRET && mustHaveRealSecret) {
        console.error(
          `[collab-live] FATAL: LIVE_SECRET is set to the default dev secret in NODE_ENV=${nodeEnv}. ` +
          "Set a secure random value for COLLAB_LIVE_SECRET (or legacy LIVE_SECRET) in production/staging."
        );
        process.exit(1);
      }
      if (secret.length < MIN_SECRET_LENGTH && mustHaveRealSecret) {
        console.error(
          `[collab-live] FATAL: LIVE_SECRET must be at least ${MIN_SECRET_LENGTH} characters ` +
          `(current: ${secret.length}, NODE_ENV=${nodeEnv}).`
        );
        process.exit(1);
      }
      return secret;
    }
    if (mustHaveRealSecret) {
      console.error(
        `[collab-live] FATAL: COLLAB_LIVE_SECRET (or legacy LIVE_SECRET) must be explicitly set when NODE_ENV=${nodeEnv ?? "(unset)"}. ` +
        "Only NODE_ENV=development|test may omit it." +
        (requireSecret ? " (COLLAB_LIVE_REQUIRE_SECRET=true)" : "")
      );
      process.exit(1);
    }
    console.warn(
      `[collab-live] ⚠️  LIVE_SECRET not set — using INSECURE dev default (NODE_ENV=${nodeEnv}). ` +
        "NEVER deploy this to any shared/staging/production environment. " +
        "Set COLLAB_LIVE_REQUIRE_SECRET=true on staging to enforce."
    );
    return DEFAULT_DEV_SECRET;
  })(),
  HOCUSPOCUS_DEBOUNCE: defaultDebounce,
  HOCUSPOCUS_DEBOUNCE_DOCS: parseInt(process.env.HOCUSPOCUS_DEBOUNCE_DOCS || String(defaultDebounce), 10),
  HOCUSPOCUS_DEBOUNCE_TABLE: parseInt(process.env.HOCUSPOCUS_DEBOUNCE_TABLE || "3000", 10),
  HOCUSPOCUS_DEBOUNCE_SLIDE: parseInt(process.env.HOCUSPOCUS_DEBOUNCE_SLIDE || "5000", 10),
  HOCUSPOCUS_DEBOUNCE_VIDEO: parseInt(process.env.HOCUSPOCUS_DEBOUNCE_VIDEO || "5000", 10),
  HOCUSPOCUS_DEBOUNCE_CANVAS: parseInt(process.env.HOCUSPOCUS_DEBOUNCE_CANVAS || "5000", 10),
  /** 单文档最大 WS 连接数（防止 Awareness O(n²) 广播风暴） */
  MAX_CONNECTIONS_PER_DOCUMENT: parseInt(process.env.MAX_CONNECTIONS_PER_DOCUMENT || "50", 10),
  /**
   * CORS 允许的 origin 列表（逗号分隔）。
   * 空时 HTTP 跨域请求会被浏览器拒绝（无 CORS 响应头）。
   * WebSocket 端点不受此配置保护，安全由各模块 onAuthenticate JWT 认证保证。
   */
  CORS_ALLOWED_ORIGINS: (() => {
    const origins = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").filter(Boolean);
    const nodeEnv = process.env.NODE_ENV;
    if (origins.length === 0 && nodeEnv && nodeEnv !== "development" && nodeEnv !== "test") {
      console.warn(
        "[collab-live] CORS_ALLOWED_ORIGINS not set — HTTP CORS will deny all cross-origin " +
        "requests. WebSocket endpoints are protected by onAuthenticate JWT (not CORS). " +
        "Set CORS_ALLOWED_ORIGINS if browser clients need to call HTTP REST endpoints."
      );
    }
    return origins;
  })(),
  /** Redis URL（可选，启用后支持多实例协作同步） */
  REDIS_URL: process.env.REDIS_URL || "",
  /** WebSocket 单条消息最大字节数（防止超大消息导致 OOM），默认 5MB */
  WS_MAX_PAYLOAD: parseInt(process.env.WS_MAX_PAYLOAD || String(5 * 1024 * 1024), 10),
  /** 服务器实例名（多实例部署时用于区分来源） */
  SERVER_NAME: process.env.SERVER_NAME || `collab-live-${process.pid}`,
};
