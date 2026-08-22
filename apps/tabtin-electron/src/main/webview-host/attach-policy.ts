/**
 * attach-policy — <webview> tag attach 白名单策略（纯函数层，）
 *
 * `will-attach-webview` 是主进程对 renderer 声明的 <webview> 的唯一一次
 * 安全裁决点（探针 9 已实证 preventDefault / 剥离 preload / 强制 webPreferences
 * 均有效）。本模块只做纯判定，不 import electron —— handler 薄层在
 * webview-host.ts，纯函数可单测。
 *
 * 两类合法 guest：
 *   1. **浏览器 guest**（WebviewManager 创建，flag=webview 的 TabWeb 容器）：
 *      - src 只允许 http(s) / about:blank
 *      - partition 必须为空（共享默认 session，对齐 WCV forEmbedded）或符合
 *        SessionConfigFactory 命名纪律（persist: 前缀 + 已知业务前缀集 / temp-）
 *      - 禁止任何 preload / preloadURL（指纹 preload 走 session 级
 *        registerPreloadScript，不经 webview 属性）
 *      - 允许 allowpopups（popup 由主进程 setWindowOpenHandler deny + 转产品 tab）
 *   2. **Tin 沙箱 guest**（TinSandboxView， 前置解锁）：
 *      - partition 固定 `persist:tin-<uuid>`
 *      - src 允许 file://（tin-sandboxes 目录内）或 data:text/html
 *      - preload 必须位于 tin-sandboxes 目录内
 *      - 禁止 allowpopups
 *
 * 任何 guest 一律强制：sandbox=true、contextIsolation=true、nodeIntegration=false、
 * webSecurity=true、nodeIntegrationInSubFrames=false。违反且无法通过覆盖修正的
 * （partition / src / preload 是属性层，改不了）直接 deny。
 */

import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachPolicyConfig {
  /** Tin 沙箱文件根目录（{userData}/tin-sandboxes），preload/src file:// 白名单根 */
  tinSandboxRoot: string
  /**
   * tin 实例存在性校验（防冒用：受控 renderer 伪造 `persist:tin-<uuid>`
   * partition 走 tin 分支加载 data:/file: 内容）。handler 层注入
   * 「tin-sandboxes/<instanceId>/ 目录已由 prepareSandbox 创建」的 fs 检查；
   * 纯函数测试注入 fake。未注入时 fail-closed（一律视为未知实例）。
   */
  isKnownTinInstance?: (instanceId: string) => boolean
  /**
   * ：浏览器 guest 的 `file://` src 受限放行判定（Agent 本地 HTML 产物
   * 内嵌浏览器预览，对标 WCV 的 validateNavigationUrl + localPreviewRoot）。
   *
   * 浏览器 guest 默认只放 http(s)/about:blank；此谓词由 handler 层注入，
   * 背后校验「src 落在某个活跃预览根（announce 时从 view config 恢复的
   * Space 工作目录）之内」，并叠加 realpath 加固（见 crawl-view/utils
   * .isAllowedLocalFileUrl）。**未注入 / 返回 false 时一律拒绝 file://**
   * ——纯函数层保持 fail-closed，不感知具体根集合。
   */
  isAllowedBrowserFileSrc?: (src: string) => boolean
}

/** will-attach-webview 的 params（元素属性快照）里本策略消费的字段 */
export interface AttachParams {
  src?: string
  partition?: string
  allowpopups?: boolean | string
}

export type AttachDecision =
  | {
      action: 'allow'
      guestKind: 'browser' | 'tin'
      /** 需要写回 webPreferences 的强制覆盖（handler 层负责 mutate） */
      enforceWebPreferences: Record<string, unknown>
      /** 需要从 webPreferences 删除的键（preload / preloadURL 等） */
      stripKeys: string[]
    }
  | {
      action: 'deny'
      reason: string
    }

// ---------------------------------------------------------------------------
// Partition 命名纪律
// ---------------------------------------------------------------------------

/**
 * SessionConfigFactory 产出的持久化 partition 业务前缀集（`persist:` 之后）：
 *   - `tabtin:`      browser-env（tabtin:env:* / tabtin:organization:*:browser）
 *   - `task-`        forCrawl 隔离抓取任务
 *   - `account-`     forAccount 独立账号
 *   - `marketplace-` sessionMode=persistent 的 marketplace App
 * 临时（非 persist）只有 `temp-`（forTemporary）。
 */
const PERSIST_BUSINESS_PREFIXES = ['tabtin:', 'task-', 'account-', 'marketplace-'] as const
const TRANSIENT_PREFIXES = ['temp-'] as const
const TIN_PARTITION_PREFIX = 'persist:tin-'
/** tin instanceId 必须是严格 UUID（与 tins/types.ts 的 UUID_RE 同口径） */
const TIN_INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 与 SessionConfigFactory.validateConfig 的格式约束一致 */
const PARTITION_FORMAT_RE = /^(persist:)?[a-zA-Z0-9_:-]+$/

export function isBrowserGuestPartitionAllowed(partition: string): boolean {
  if (partition === '') return true // 共享默认 session（对齐 WCV forEmbedded）
  if (!PARTITION_FORMAT_RE.test(partition)) return false
  if (partition.startsWith('persist:')) {
    const rest = partition.slice('persist:'.length)
    return PERSIST_BUSINESS_PREFIXES.some((prefix) => rest.startsWith(prefix) && rest.length > prefix.length)
  }
  return TRANSIENT_PREFIXES.some((prefix) => partition.startsWith(prefix) && partition.length > prefix.length)
}

/** 提取 tin partition 的 instanceId（非 tin 形态 / 非 UUID 返回 null） */
export function extractTinInstanceId(partition: string): string | null {
  if (!PARTITION_FORMAT_RE.test(partition)) return null
  if (!partition.startsWith(TIN_PARTITION_PREFIX)) return null
  const instanceId = partition.slice(TIN_PARTITION_PREFIX.length)
  return TIN_INSTANCE_ID_RE.test(instanceId) ? instanceId : null
}

export function isTinGuestPartition(partition: string): boolean {
  return extractTinInstanceId(partition) !== null
}

// ---------------------------------------------------------------------------
// 路径 / URL 帮助
// ---------------------------------------------------------------------------

/** preload 可能是绝对路径或 file:// URL；解析成绝对路径（解析失败返回 null） */
export function resolvePreloadPath(preload: string): string | null {
  try {
    if (preload.startsWith('file://')) {
      const url = new URL(preload)
      return path.resolve(decodeURIComponent(url.pathname))
    }
    if (path.isAbsolute(preload)) {
      return path.resolve(preload)
    }
    return null
  } catch {
    return null
  }
}

/** absPath 是否位于 root 目录内（防 `..` 逃逸；解析后前缀比对） */
export function isPathInsideRoot(absPath: string, root: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(absPath)
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  return resolved === resolvedRoot || resolved.startsWith(rootWithSep)
}

function isHttpOrAboutBlank(src: string): boolean {
  if (src === 'about:blank') return true
  try {
    const url = new URL(src)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isFileUrlInsideRoot(src: string, root: string): boolean {
  try {
    const url = new URL(src)
    if (url.protocol !== 'file:') return false
    return isPathInsideRoot(decodeURIComponent(url.pathname), root)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 主判定
// ---------------------------------------------------------------------------

/** 所有 guest 一律强制的 webPreferences（探针 9 验证可在 will-attach 覆盖生效） */
const ENFORCED_WEB_PREFERENCES: Record<string, unknown> = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
})

function truthyAttr(value: boolean | string | undefined): boolean {
  // webview 属性语义：属性存在（含空字符串 / 'true'）即开启
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return value !== 'false'
}

/**
 * 纯判定：给定 will-attach-webview 的 webPreferences + params，输出 allow/deny。
 *
 * handler 层契约：
 *   - deny → event.preventDefault() + log.warn(reason)
 *   - allow → 按 enforceWebPreferences 覆盖 + stripKeys 删除后放行
 */
export function evaluateWillAttachWebview(
  webPreferences: Record<string, unknown>,
  params: AttachParams,
  policy: AttachPolicyConfig,
): AttachDecision {
  const src = typeof params.src === 'string' ? params.src : ''
  const partition = typeof params.partition === 'string' ? params.partition : ''
  const preload =
    typeof webPreferences.preload === 'string'
      ? webPreferences.preload
      : typeof webPreferences.preloadURL === 'string'
        ? webPreferences.preloadURL
        : ''
  const wantsPopups = truthyAttr(params.allowpopups)

  // ── Tin 沙箱 guest ──
  const tinInstanceId = extractTinInstanceId(partition)
  if (tinInstanceId) {
    // 防冒用：partition 前缀匹配不等于合法 tin——实例必须真实存在
    // （prepareSandbox 已落盘）。校验器缺失时 fail-closed。
    if (!policy.isKnownTinInstance || !policy.isKnownTinInstance(tinInstanceId)) {
      return { action: 'deny', reason: `未知 tin 实例（疑似伪造 partition）: ${partition}` }
    }
    if (wantsPopups) {
      return { action: 'deny', reason: `tin guest 不允许 allowpopups (partition=${partition})` }
    }
    // preload / file src 收窄到该实例自己的沙箱子目录，防跨实例读取
    const instanceRoot = path.join(policy.tinSandboxRoot, tinInstanceId)
    if (preload) {
      const resolved = resolvePreloadPath(preload)
      if (!resolved || !isPathInsideRoot(resolved, instanceRoot)) {
        return { action: 'deny', reason: `tin guest preload 不在本实例沙箱目录内: ${preload}` }
      }
    }
    const srcOk =
      src === '' // 允许先 attach 后设 src 的空初值
      || src === 'about:blank'
      || src.startsWith('data:text/html')
      || isFileUrlInsideRoot(src, instanceRoot)
    if (!srcOk) {
      return { action: 'deny', reason: `tin guest src 非法: ${src}` }
    }
    return {
      action: 'allow',
      guestKind: 'tin',
      enforceWebPreferences: { ...ENFORCED_WEB_PREFERENCES },
      stripKeys: [],
    }
  }

  // ── 浏览器 guest ──
  if (!isBrowserGuestPartitionAllowed(partition)) {
    return { action: 'deny', reason: `partition 不符合命名纪律: ${partition || '(empty)'}` }
  }
  if (preload) {
    // 浏览器 guest 一律不允许属性级 preload（指纹 preload 走 session 级注册）。
    // 属性 preload 是 renderer 可控输入，deny 比 strip 更硬——出现即视为异常。
    return { action: 'deny', reason: `browser guest 不允许 preload 属性: ${preload}` }
  }
  if (src !== '' && !isHttpOrAboutBlank(src)) {
    // ：受限放行落在活跃预览根内的本地 HTML 产物 file://（可信预览入口）。
    // 谓词缺省 / 返回 false（含非 file 协议）时一律拒绝——纯函数层 fail-closed。
    if (policy.isAllowedBrowserFileSrc?.(src)) {
      return {
        action: 'allow',
        guestKind: 'browser',
        enforceWebPreferences: { ...ENFORCED_WEB_PREFERENCES },
        stripKeys: ['preload', 'preloadURL'],
      }
    }
    return { action: 'deny', reason: `browser guest src 非法（仅 http(s)/about:blank/受限 file://）: ${src}` }
  }
  return {
    action: 'allow',
    guestKind: 'browser',
    enforceWebPreferences: { ...ENFORCED_WEB_PREFERENCES },
    // preload 为空也统一 strip，防御 falsy-but-present 的注入形态
    stripKeys: ['preload', 'preloadURL'],
  }
}
