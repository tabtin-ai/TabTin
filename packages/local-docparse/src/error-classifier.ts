/**
 * error-classifier — 把 worker / 下载抛出的原生异常映射到业务错误类型。
 *
 * 与 `parseLocalAttachment.ts` 解耦的好处：
 *   1. 单测无需 stub worker，纯函数易覆盖
 *   2. 宿主侧（如 retry-tool 错误归因）可直接复用
 *
 * **W1（2026-05-13）**：返回值改为 `FilePipelineErrorCode` 全局 enum 字面值
 * （与 `@tabtin/file-pipeline-errors` SSoT 对齐）。
 */

import { FilePipelineErrorCode, type LocalDocParseErrorClass } from './types.js'

/**
 * URL 下载时 HTTP 非 2xx 响应的专用 Error 子类。
 * `classifyWorkerError` 根据 `status` 把 404/403/410 归到 `not_found`（附件确实
 * 不存在或权限被撤销；云端也救不回来，但语义上比 `unknown` 更准，埋点更细）。
 * 其他 4xx/5xx 回落 `unknown` 由上层切云端兜底。
 */
export class DownloadHttpError extends Error {
  public readonly status: number
  constructor(status: number, statusText: string) {
    super(`Download failed: HTTP ${status} ${statusText}`)
    this.name = 'DownloadHttpError'
    this.status = status
  }
}

/**
 * 下载体积超过本地解析硬上限的专用 Error 子类。
 *
 * **W1.2（2026-05-13 第二轮 Review M2 反馈）**：旧实现用 `throw new Error('oversize: ...')`
 * 字符串协议（`msg.startsWith('oversize')` 识别），有两个问题：
 *   1. `'oversize'` 字面值已被 W1 errorClass union 整体退役为 `'file_too_large'`，
 *      内部字符串协议 vs 公开字面值同形，读代码人困惑哪个该改哪个不该改
 *   2. 字符串协议依赖 message 措辞稳定，i18n 化或重构时 catch 段易漏命中
 *
 * 改为专用 Error 子类——与 `DownloadHttpError` 同款约定，调用方用 `err instanceof
 * OversizeDownloadError` 类型识别（不依赖 message 措辞）。
 */
export class OversizeDownloadError extends Error {
  public readonly receivedBytes: number
  public readonly maxBytes: number
  constructor(receivedBytes: number, maxBytes: number) {
    super(
      `File too large: received ${receivedBytes} bytes exceeds limit ${maxBytes} bytes`,
    )
    this.name = 'OversizeDownloadError'
    this.receivedBytes = receivedBytes
    this.maxBytes = maxBytes
  }
}

/**
 * 把 worker 抛出的原始 Error 映射到业务错误类型。
 *
 * pdfjs 5.x 的常见 exception：
 *   - PasswordException（name='PasswordException'，或 message 含 'password'）
 *   - InvalidPDFException（name='InvalidPDFException'，或 message 含 'Invalid PDF'）
 *   - MissingPDFException（file 读不到；Node 端通常是 fs ENOENT）
 *   - UnexpectedResponseException（网络错误，本地不会出）
 *
 * mammoth：结构错乱 → 泛 Error（含 'not a valid zip'）
 * xlsx：`Corrupt workbook / sheet`、`Unsupported file`、`Unsupported ZIP`
 *
 * HTTP 下载错误（Verifier-B 必修 3）：
 *   - `DownloadHttpError`（404/403/410）→ `FILE_NOT_FOUND`（资源不存在 / 权限撤销）
 *   - `DownloadHttpError`（其他 4xx/5xx）→ `UNKNOWN_ERROR`（让上层切云端兜底）
 *
 * 匹配策略（技术 Review P0-2）：
 *   1. **优先 name 白名单**（最稳）：DownloadHttpError / PasswordException / InvalidPDFException
 *   2. **message 用特异词组**（不要裸词 'corrupt'）：避免把 "fetch corrupt stream" 等网络/流错误
 *      误判为 CORRUPTED（不切云端）
 *   3. pdfjs 升级时若更换类名，先 name 不匹配 → 走 message 兜底；若 message 也变则回落
 *      UNKNOWN_ERROR（fallbackToCloud: true），比硬编码误匹配更安全
 *
 * **W1**：返回值字面值已与 `@tabtin/file-pipeline-errors` SSoT 对齐——下游
 * `tabcode-adapter` 不再需要 lossy 压扁映射（旧 adapter 层那个把 6 类压成
 * `UNSUPPORTED_OPERATION=4` 的函数已删除，envelope 通过 `formatFilePipelineError`
 * 派发）。
 */
export function classifyWorkerError(err: unknown): LocalDocParseErrorClass {
  const name = (err instanceof Error ? err.name : '') ?? ''
  const message = (err instanceof Error ? err.message : String(err)) ?? ''

  const nameL = name.toLowerCase()
  const msgL = message.toLowerCase()

  // 用户主动取消（WorkerTaskRunner.abortTask 抛出的 WorkerTaskAbortedError 或
  // fetch 抛的 AbortError）→ USER_ABORTED，不切云端。
  // Verifier-B Review 必修项：手机端用户点"停止"后不应继续打云端 DocParse。
  if (nameL === 'workertaskabortederror' || nameL === 'aborterror') {
    return FilePipelineErrorCode.USER_ABORTED
  }

  // HTTP 404/403/410 → FILE_NOT_FOUND（资源确实不在了或无权限）
  if (err instanceof DownloadHttpError) {
    if (err.status === 404 || err.status === 403 || err.status === 410) {
      return FilePipelineErrorCode.FILE_NOT_FOUND
    }
    // 其他 HTTP 错误（5xx / 429 / 401 等）→ NETWORK_ERROR（区别于 UNKNOWN，能让
    // LLM / UI 给出"检查网络后重试"的精确 hint）
    return FilePipelineErrorCode.NETWORK_ERROR
  }

  if (nameL.includes('password') || msgL.includes('password')) {
    return FilePipelineErrorCode.ENCRYPTED
  }

  // name 白名单：pdfjs 私有异常类名
  if (nameL.includes('invalidpdf') || nameL.includes('invalidrange')) {
    return FilePipelineErrorCode.CORRUPTED
  }

  // message 用特异词组，避免 'corrupt' 裸匹配
  // **W1.1 (2026-05-13 Review 反馈)**：'unsupported file' / 'unsupported zip'
  // 从 CORRUPTED 挪到 UNSUPPORTED_FORMAT —— SheetJS 读 .xls 老格式抛
  // "Unsupported file: foo.xls"，**不是文件损坏**而是格式不支持；旧版本归到
  // CORRUPTED 让用户被引导"重新导出"，但用户的 .xls 文件本身正常。
  if (
    msgL.includes('invalid pdf')
    || msgL.includes('pdf header')
    || msgL.includes('not a valid zip')
    || /corrupt (workbook|sheet|pdf|file|zip|document)/i.test(message)
  ) return FilePipelineErrorCode.CORRUPTED

  if (msgL.includes('unsupported file') || msgL.includes('unsupported zip')) {
    return FilePipelineErrorCode.UNSUPPORTED_FORMAT
  }

  if (nameL.includes('missingpdf') || msgL.includes('enoent')) {
    return FilePipelineErrorCode.FILE_NOT_FOUND
  }

  // **W1.1 (2026-05-13 Review 反馈)**：网络层 errno / 裸 fetch TypeError 归到
  // NETWORK_ERROR（与 DownloadHttpError 5xx 同款分支），让 LLM 拿到"检查网络
  // 后重试"的精确 hint。**优先级在 'timeout' phrase 之前**——`'ETIMEDOUT'`
  // 含子串 `'timeout'`，如果先匹 PARSE_TIMEOUT 会让网络层超时被误归类。
  if (
    nameL === 'typeerror' && (msgL.includes('fetch') || msgL.includes('network'))
    || msgL.includes('econnrefused')
    || msgL.includes('econnreset')
    || msgL.includes('enotfound')
    || msgL.includes('etimedout')
  ) {
    return FilePipelineErrorCode.NETWORK_ERROR
  }

  if (msgL.includes('timed out') || msgL.includes('timeout')) {
    return FilePipelineErrorCode.PARSE_TIMEOUT
  }

  return FilePipelineErrorCode.UNKNOWN_ERROR
}

/**
 * "本地不行，云端也不行"的四类（ENCRYPTED / CORRUPTED / FILE_TOO_LARGE / USER_ABORTED）→
 * 不切云端，直接给用户明确提示；其余错误（SCANNED_PDF / GARBLED_TEXT_LAYER /
 * PARSE_TIMEOUT / UNSUPPORTED_FORMAT / FILE_NOT_FOUND / NETWORK_ERROR / UNKNOWN_ERROR）
 * 建议切云端兜底。
 *
 * USER_ABORTED 不切云端的理由：用户主动点"停止生成"时，整个对话流应立刻停顿，
 * 后台不应继续打云端 DocParse（手机端流量敏感 + 用户预期立刻生效）。
 */
export function errorClassToFallback(cls: LocalDocParseErrorClass): boolean {
  return (
    cls !== FilePipelineErrorCode.ENCRYPTED
    && cls !== FilePipelineErrorCode.CORRUPTED
    && cls !== FilePipelineErrorCode.FILE_TOO_LARGE
    && cls !== FilePipelineErrorCode.USER_ABORTED
  )
}
