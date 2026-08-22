/**
 * 生产 CSP 构造 —— 从构建时环境变量推导 connect-src / frame-src 白名单。
 *
 * 从 electron.vite.config.ts 的 harden-csp 插件里抽出来的纯函数：给定 env 得到
 * CSP 字符串，没有文件 IO / 插件依赖，因此可以被单测直接断言。
 *
 * 抽离动机：htmlBlock 的 HTML artifact 走 iframe 加载，src 落在公共资产域
 * （ASSET_PUBLIC_DOMAIN / ALIYUN_OSS_CDN_DOMAIN）上，但该域此前只被加进 connect-src、
 * 没进 frame-src——dev 一切正常，打包态却被 CSP 拒绝加载，属于只有真机打包才暴露的
 * 缺口。把策略变成可断言的纯函数，这类"两个白名单没对齐"才能在单测层拦住。
 */

/** 生产 CSP 各指令的白名单来源。 */
export interface ProductionCspEnv {
  VITE_API_BASE_URL?: string
  TABTIN_API_BASE_URL?: string
  ASSET_PUBLIC_DOMAIN?: string
  ALIYUN_OSS_CDN_DOMAIN?: string
  VITE_ASSET_PUBLIC_DOMAIN?: string
  CSP_EXTRA_CONNECT_SRC?: string
  CSP_EXTRA_FRAME_SRC?: string
  NODE_ENV?: string
  [key: string]: string | undefined
}

/** 默认公共资产域：与 src/shared/oss-presigned-upload-ipc.ts 的 TRUSTED_ASSET_CDN_HOST 对齐。 */
export const DEFAULT_ASSET_PUBLIC_DOMAIN = 'https://assets.example.com'

/**
 * TabDoc HTML 块（blob/srcdoc iframe）会继承壳 CSP；交互式 HTML 常从这些 CDN 拉
 * floating-ui / lucide / react UMD 等。与 Tin 面板沙箱白名单对齐，避免  私有
 * Blob 渲染后外链 script 被 script-src 静默拦掉。
 *
 * 另须 `'unsafe-inline'`：用户 demo 的 onclick / 内联 `<script>` 同理继承壳
 * CSP；打包 harden 若去掉，会出现「样式正常、按钮无响应」。
 *
 * 主窗口 XSS 若注入 `<script>` / CDN 也能加载——相对已有 sandbox HTML 能力的增量风险；
 * iframe 仍无 allow-same-origin，块内脚本碰不到壳 DOM。
 */
export const HTML_ARTIFACT_CDN_ORIGINS = [
  'https://unpkg.com',
  'https://cdn.jsdelivr.net',
  'https://esm.sh',
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
] as const

const COLLAB_WS_ENV_KEYS = [
  'VITE_COLLAB_WS_BASE', 'VITE_COLLAB_WS_URL',
  'VITE_TABLE_COLLAB_WS_URL', 'VITE_SLIDE_COLLAB_WS_URL',
  'VITE_VIDEO_COLLAB_WS_URL', 'VITE_DESIGN_COLLAB_WS_URL',
  'VITE_CANVAS_COLLAB_WS_URL', 'VITE_CENTRIFUGO_WS_URL',
] as const

/** 归一化资产域为 origin；无法解析时返回空串。 */
export function resolveAssetPublicOrigin(env: ProductionCspEnv): string {
  const domain =
    env.ASSET_PUBLIC_DOMAIN ||
    env.ALIYUN_OSS_CDN_DOMAIN ||
    env.VITE_ASSET_PUBLIC_DOMAIN ||
    DEFAULT_ASSET_PUBLIC_DOMAIN
  try {
    return new URL(domain.includes('://') ? domain : `https://${domain}`).origin
  } catch {
    return ''
  }
}

/**
 * 构造生产 CSP。
 *
 * @throws 生产构建下未配置 API 域名时抛错——宁可断构建，也不发一个 connect-src 放开
 *         `https: wss:` 的包出去。
 */
export function buildProductionCsp(
  env: ProductionCspEnv,
  onWarn: (message: string) => void = () => {},
): string {
  const connectSources = new Set(["'self'", 'blob:', 'tabtin-file:'])
  const frameSources = new Set(["'self'"])
  const imageSources = new Set(["'self'", 'data:', 'blob:', 'https:', 'tabtin-file:'])
  const mediaSources = new Set(["'self'", 'blob:', 'https:', 'tabtin-file:'])

  // --- 从构建时环境变量推导合法 origin ---

  const apiBaseUrl = env.VITE_API_BASE_URL || env.TABTIN_API_BASE_URL || ''
  let resolvedApiOrigin = ''
  if (apiBaseUrl) {
    try {
      const parsedApiUrl = new URL(apiBaseUrl)
      if (!['http:', 'https:'].includes(parsedApiUrl.protocol)) throw new Error('unsupported API protocol')
      const apiOrigin = parsedApiUrl.origin                 // e.g. https://api.example.com
      resolvedApiOrigin = apiOrigin
      connectSources.add(apiOrigin)
      connectSources.add(apiOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:'))
      // local provider 的上传、预览和下载与 API 同源。LAN HTTP 只放行这一条
      // 构建配置里的精确 origin，不放开任意 http: 或私网段。
      imageSources.add(apiOrigin)
      mediaSources.add(apiOrigin)
    } catch { /* 无效 URL，跳过 */ }
  }

  for (const key of COLLAB_WS_ENV_KEYS) {
    const val = env[key]
    if (val) {
      try { connectSources.add(new URL(val).origin) } catch { /* skip */ }
    }
  }

  // OSS 直传（浏览器 XHR PUT 到 presigned URL）
  connectSources.add('https://*.aliyuncs.com')
  imageSources.add('https://*.aliyuncs.com')
  mediaSources.add('https://*.aliyuncs.com')

  // 公共资产 CDN（聊天附件 / 头像等走 assets.example.com，不是 *.aliyuncs.com）
  // 缺了会导致 PdfViewer / getAttachmentBuffer 在打包态 Failed to fetch。
  const assetPublicOrigin = resolveAssetPublicOrigin(env)
  if (assetPublicOrigin) {
    connectSources.add(assetPublicOrigin)
    imageSources.add(assetPublicOrigin)
    mediaSources.add(assetPublicOrigin)
  }

  // 用户扩展
  const extraConnect = env.CSP_EXTRA_CONNECT_SRC || ''
  if (extraConnect) {
    for (const s of extraConnect.split(/\s+/).filter(Boolean)) connectSources.add(s)
  }

  // 如果构建时未设置任何 API 域名，生产构建直接中断；开发模式回退到宽泛策略
  const hasApiOrigin = Boolean(resolvedApiOrigin)
  if (!hasApiOrigin) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        '[harden-csp] VITE_API_BASE_URL / TABTIN_API_BASE_URL 未设置。' +
        '生产构建必须配置 API 域名以生成安全的 CSP。请在 .env.production 中配置。',
      )
    }
    onWarn(
      '[harden-csp] ⚠️  VITE_API_BASE_URL / TABTIN_API_BASE_URL 未设置，' +
      'connect-src 将回退到 https: wss:（宽泛策略）。请在 .env.production 中配置。',
    )
    connectSources.add('https:')
    connectSources.add('wss:')
  }

  // --- frame-src 白名单（场景有限：TabSite iframe + TabDoc htmlBlock artifact） ---
  frameSources.add('https://*.aliyuncs.com')
  // ：私有 HTML 经授权 API 拉成 Blob 后 iframe 用 blob: URL 渲染。
  frameSources.add('blob:')

  // TabDoc htmlBlock历史公开资产仍可能落在公共资产域；#7767 新上传改走 blob:。
  // 该域名已在 connect-src 里被信任，这里不扩大信任面；iframe 自身仍带
  // sandbox="allow-scripts allow-popups"（无 allow-same-origin）。
  if (assetPublicOrigin) frameSources.add(assetPublicOrigin)

  const extraFrame = env.CSP_EXTRA_FRAME_SRC || ''
  if (extraFrame) {
    for (const s of extraFrame.split(/\s+/).filter(Boolean)) frameSources.add(s)
  }

  // HTML 块 blob 继承壳 CSP：放行常用前端 CDN 的静态加载（script / style / font）。
  // 故意不进 connect-src——sourcemap / fetch / XHR 仍走 API·OSS 白名单；
  // 不可信 artifact 的网络出口由服务端响应 CSP（connect-src 'none'）与自包含契约兜底。
  //
  // script-src 必须含 'unsafe-inline'： 后私有 HTML 走 blob: iframe，Chromium
  // 让 blob/srcdoc 继承壳 CSP；用户 demo 常见 onclick / <script> 内联。dev index.html
  // 本就有 unsafe-inline，打包 harden 后去掉会导致「看得见样式但点不动」（飞书
  // MsAWr2I8NetU9tc1oR7cC58KnSd）。Vite 生产壳本身不产出内联脚本；iframe 仍无
  // allow-same-origin，块内脚本碰不到壳 DOM。长期可改自定义协议隔离再收回。
  const htmlCdn = HTML_ARTIFACT_CDN_ORIGINS.join(' ')

  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${htmlCdn}`,
    "worker-src 'self' blob:",
    `style-src 'self' 'unsafe-inline' ${htmlCdn}`,
    `font-src 'self' data: ${htmlCdn}`,
    `img-src ${[...imageSources].join(' ')}`,
    `media-src ${[...mediaSources].join(' ')}`,
    `connect-src ${[...connectSources].join(' ')}`,
    `frame-src ${[...frameSources].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}
