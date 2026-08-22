/**
 * BR-30 媒体下载护栏——纯判定（electron-free）。
 *
 * 背景（BR-30 dogfood Case 9）：下载类 action 的 contract risk 全是 `read`，BR-9 统一安全闸门
 * 因此对它们一律 `allow`、没有任何风险确认——于是 Agent 会对「临时签名 URL（如 GitHub
 * private-user-images 的短期 JWT）/ 跨站媒体 / 大文件」无脑下载，常因签名过期 / 超时失败，
 * 还会违背用户「不要下载大文件 / 只说明下一步」的意图。
 *
 * 本模块只回答一个问题：**这次下载请求是否命中风险信号、是否需要先确认 / 是否建议改异步**，
 * 并给出命中的信号 + 原因。它**不碰 UI、不触发执行、也不阻断**——处置（Electron 弹审批 /
 * Daemon 默认放行 + 记日志）仍由 BR-9 的 host 钩子决定。
 *
 * 与 BR-9 安全闸门的关系：闸门把下载类 action 接到这里做「风险信号 → confirm 升级」；**未命中
 * 信号的普通下载仍按 contract `read` 放行（零行为变更）**——既给高风险下载补上确认护栏，又不把
 * 正常采集流程（同站小文件）退化成每次都要确认。
 *
 * 详见方案文档 `docs/agent/browser-br-30-media-download-guardrail.md`。
 */

/** 媒体下载的风险信号种类。 */
export type MediaDownloadSignal =
  /** 临时签名 URL：带短期过期签名的下载地址（厂商预签名 / GitHub JWT / 通用 签名+过期 组合）。 */
  | 'ephemeral-signed-url'
  /** 跨站资源：下载目标与当前页面不同源（需 pageUrl 才能判定）。 */
  | 'cross-origin'
  /** 大文件：已知字节数超过阈值（默认 50MB）。 */
  | 'large-file'
  /** 需要会话：资源依赖登录态 / 页面上下文（如页面内 MediaSource blob）才能取到。 */
  | 'requires-session'

/** 默认大文件阈值：50MB（与 BR-4 讨论中的 Daemon 直链护栏阈值同口径）。 */
export const DEFAULT_DOWNLOAD_SIZE_THRESHOLD_BYTES = 50 * 1024 * 1024

/** 一次下载请求的可观测信号（字段全可选——各端 / 各 action 能提供的信息不同）。 */
export interface MediaDownloadRequest {
  /** 下载目标 URL（resource download / capture / stream download / import 的 `--url`）。 */
  url?: string
  /** 当前页面 URL，用于判跨站；缺省则跳过 `cross-origin` 判定（纯函数不猜页面上下文）。 */
  pageUrl?: string
  /** 已知字节数（content-length / 资源 size）；缺省或非正数则跳过 `large-file` 判定。 */
  size?: number
  /** 资源是否依赖会话 / 页面上下文（如页面内 blob、需 cookie 的资源）；由调用方显式给。 */
  requiresSession?: boolean
}

/** 护栏判定的可选参数。 */
export interface MediaDownloadGuardrailOptions {
  /** 大文件阈值（字节），默认 {@link DEFAULT_DOWNLOAD_SIZE_THRESHOLD_BYTES}。 */
  sizeThresholdBytes?: number
}

/** 护栏判定结果。 */
export interface MediaDownloadGuardrailResult {
  /** 是否应在下载前要求确认（任一信号命中即 true）。 */
  requiresConfirm: boolean
  /** 是否建议改用异步（`--async` + job 轮询）执行——大文件 / 流媒体场景。 */
  suggestAsync: boolean
  /** 命中的风险信号（去重、稳定顺序）。 */
  signals: MediaDownloadSignal[]
  /** 与信号一一对应的人类可读原因。 */
  reasons: string[]
}

// ── 临时签名 URL 检测 ───────────────────────────────────────────────

/**
 * 厂商「强信号」query 参数：出现任一即判定为临时签名 URL（这些参数本身就唯一对应一种
 * 短期预签名机制，不会出现在普通长期可访问的资源 URL 上）。
 */
const STRONG_SIGNATURE_PARAMS: readonly string[] = [
  'x-amz-signature', // AWS S3 / 兼容 S3 预签名
  'x-amz-security-token',
  'x-goog-signature', // Google Cloud Storage 预签名
  'key-pair-id', // AWS CloudFront 签名 URL
  'x-obs-security-token', // 华为 OBS
]

/** 签名「存在」标志（需配合过期标志才判定为临时签名，避免误伤长期 token）。 */
const SIGNATURE_PARAMS: readonly string[] = [
  ...STRONG_SIGNATURE_PARAMS,
  'sig',
  'signature',
  'hmac',
  'policy',
  'token',
  'jwt',
]

/** 过期 / 有效期标志。 */
const EXPIRY_PARAMS: readonly string[] = [
  'expires',
  'expire',
  'x-amz-expires',
  'x-goog-expires',
  'se', // Azure SAS expiry
  'exp',
  'validto',
]

/**
 * 判断一个 URL 是否为「带短期过期签名」的临时下载地址。
 *
 * 命中任一即判 true：
 *  1) 厂商强信号参数（AWS/GCS/CloudFront/OBS 等预签名专属参数）；
 *  2) GitHub 用户私有资产（`private-user-images.githubusercontent.com`，恒短期 JWT——BR-30 主案例）；
 *  3) query 同时含 `jwt`（GitHub 资产 / 通用 JWT 签名）；
 *  4) 通用：query 同时含「签名标志」与「过期标志」（如 `?token=...&expires=...`）。
 *
 * 设计取向：**宁可漏判边角，也不误伤普通带 query 的 URL**（如 `?id=123`、单独 `?token=`
 * 这类可能长期有效的参数都不命中）——确保未命中的普通下载继续走 read→allow，零行为变更。
 */
export function isEphemeralSignedUrl(url: string | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const host = parsed.hostname.toLowerCase()
  // GitHub 私有用户资产：URL 形如 https://private-user-images.githubusercontent.com/...?jwt=...，
  // jwt 短期过期（BR-30 实见 404）。host 命中即判（即便 jwt 参数缺失也按短期资产处理）。
  if (host === 'private-user-images.githubusercontent.com') return true

  const keys = new Set<string>()
  for (const key of parsed.searchParams.keys()) keys.add(key.toLowerCase())
  if (keys.size === 0) return false

  if (STRONG_SIGNATURE_PARAMS.some((p) => keys.has(p))) return true
  if (keys.has('jwt')) return true

  const hasSignature = SIGNATURE_PARAMS.some((p) => keys.has(p))
  const hasExpiry = EXPIRY_PARAMS.some((p) => keys.has(p))
  return hasSignature && hasExpiry
}

// ── 跨站判定 ────────────────────────────────────────────────────────

/** 两个 URL 是否不同源（protocol + host + port）。任一解析失败 → 返回 false（不误判跨站）。 */
function isCrossOrigin(url: string, pageUrl: string): boolean {
  try {
    return new URL(url).origin !== new URL(pageUrl).origin
  } catch {
    return false
  }
}

// ── 主判定 ─────────────────────────────────────────────────────────

/**
 * 对一次下载请求做风险护栏判定。
 *
 * @returns 命中的信号 + 是否需确认 / 建议异步 + 原因；无信号时 `requiresConfirm=false`、`signals=[]`。
 */
export function evaluateMediaDownloadGuardrail(
  request: MediaDownloadRequest,
  options: MediaDownloadGuardrailOptions = {},
): MediaDownloadGuardrailResult {
  const threshold = options.sizeThresholdBytes ?? DEFAULT_DOWNLOAD_SIZE_THRESHOLD_BYTES
  const signals: MediaDownloadSignal[] = []
  const reasons: string[] = []

  if (isEphemeralSignedUrl(request.url)) {
    signals.push('ephemeral-signed-url')
    reasons.push('目标是临时签名 URL（短期过期，下载易超时 / 失败）')
  }

  if (request.url && request.pageUrl && isCrossOrigin(request.url, request.pageUrl)) {
    signals.push('cross-origin')
    reasons.push('资源与当前页面不同源（跨站下载）')
  }

  if (typeof request.size === 'number' && Number.isFinite(request.size) && request.size > threshold) {
    signals.push('large-file')
    reasons.push(`文件较大（${formatBytes(request.size)} 超过 ${formatBytes(threshold)} 阈值）`)
  }

  if (request.requiresSession === true) {
    signals.push('requires-session')
    reasons.push('资源依赖登录态 / 页面上下文才能下载')
  }

  const suggestAsync = signals.includes('large-file')

  return {
    requiresConfirm: signals.length > 0,
    suggestAsync,
    signals,
    reasons,
  }
}

/** 字节数转人类可读（用于原因文案；纯展示，不参与判定）。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}
