/**
 * 聊天附件音频 → ASR 转写
 *
 * Electron / Daemon AgentHost 在 resolveOneAttachment 里对 audio/* 走此模块，
 * 把转写文本注入 Agent 上下文，替代原先的「[附件: xxx (audio/mpeg)]」占位。
 *
 * 重要：本地开发 OSS 的 access_url 是 `http://127.0.0.1:6060/.../local-object?...`，
 * 字节云端无法拉取 → 必须本机下载后走 flash `audio_data`（base64），不能只传 audio_url。
 */

const FLASH_FORMATS = new Set(['mp3', 'wav', 'ogg'])
/** 聊天发送路径最多等这么久；更长的音频提示用户改用 CLI / TabVideo */
const FLASH_TIMEOUT_MS = 120_000
const STANDARD_POLL_INTERVAL_MS = 2_000
const STANDARD_POLL_MAX_MS = 90_000
/** 超过此大小走标准版异步（flash 上游上限 100MB，留余量） */
const FLASH_MAX_BYTES = 80 * 1024 * 1024
/**
 * Django `/recognize/` 对 audio_data 的上限是 20MB base64；
 * 约合原始 ~14MB。超过则无法走本机下载 + base64。
 */
const BASE64_UPLOAD_MAX_RAW_BYTES = 14 * 1024 * 1024

/** 同 file_id 成功转写短缓存，避免连发重复计费 */
const TRANSCRIPT_CACHE_TTL_MS = 15 * 60 * 1000
const TRANSCRIPT_CACHE_MAX_ENTRIES = 64

function joinApi(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

export type ChatAudioAttachment = {
  url?: string
  filename?: string
  mime_type?: string
  size?: number
  /** 有则参与成功转写短缓存，避免同文件连发重复计费 */
  file_id?: string
}

export type TranscribeChatAudioDeps = {
  apiBaseUrl: string
  organizationId: string
  getAccessToken: () => string | null | Promise<string | null>
  signal?: AbortSignal
  /** 测试可注入 */
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 测试可关掉缓存 */
  disableCache?: boolean
}

export type ChatAudioAsrFailureKind =
  | 'missing_org'
  | 'missing_url'
  | 'cancelled'
  | 'auth'
  | 'not_configured'
  | 'local_unsupported_format'
  | 'local_too_large'
  | 'local_oss'
  | 'timeout'
  | 'upstream'
  | 'generic'

export type TranscribeChatAudioResult =
  | { ok: true; text: string; mode: 'flash' | 'standard'; fromCache?: boolean }
  | { ok: false; userMessage: string; kind: ChatAudioAsrFailureKind }

type CacheEntry = {
  text: string
  mode: 'flash' | 'standard'
  expiresAt: number
}

const transcriptCache = new Map<string, CacheEntry>()

function cacheKey(organizationId: string, fileId: string): string {
  return `${organizationId}::${fileId}`
}

/** 测试 / 运维用：清空短缓存 */
export function clearChatAudioTranscriptCache(): void {
  transcriptCache.clear()
}

function readTranscriptCache(
  organizationId: string,
  fileId: string | undefined,
): CacheEntry | null {
  if (!fileId?.trim()) return null
  const key = cacheKey(organizationId, fileId.trim())
  const hit = transcriptCache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) {
    transcriptCache.delete(key)
    return null
  }
  // LRU：读后挪到末尾
  transcriptCache.delete(key)
  transcriptCache.set(key, hit)
  return hit
}

function writeTranscriptCache(
  organizationId: string,
  fileId: string | undefined,
  text: string,
  mode: 'flash' | 'standard',
): void {
  if (!fileId?.trim()) return
  const key = cacheKey(organizationId, fileId.trim())
  if (transcriptCache.has(key)) transcriptCache.delete(key)
  transcriptCache.set(key, {
    text,
    mode,
    expiresAt: Date.now() + TRANSCRIPT_CACHE_TTL_MS,
  })
  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
    const oldest = transcriptCache.keys().next().value
    if (oldest == null) break
    transcriptCache.delete(oldest)
  }
}

export function isChatAudioAttachment(mime?: string, filename?: string): boolean {
  const m = (mime || '').toLowerCase().trim()
  if (m.startsWith('audio/')) return true
  const name = (filename || '').toLowerCase()
  return /\.(mp3|wav|m4a|aac|ogg|flac|webm|opus|amr)$/i.test(name)
}

export function inferAudioFormat(mime?: string, filename?: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('wav')) return 'wav'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('aac')) return 'aac'
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a'
  if (m.includes('flac')) return 'flac'
  if (m.includes('amr')) return 'amr'
  if (m.includes('webm') || m.includes('opus')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'

  const name = (filename || '').toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  if (ext === 'wav') return 'wav'
  if (ext === 'ogg' || ext === 'opus') return 'ogg'
  if (ext === 'm4a') return 'm4a'
  if (ext === 'aac') return 'aac'
  if (ext === 'flac') return 'flac'
  if (ext === 'amr') return 'amr'
  if (ext === 'webm') return 'ogg'
  return 'mp3'
}

/**
 * 字节云端无法拉取的 URL（本机 OSS / loopback / 内网）。
 * 对这些 URL 传 audio_url 会得到 Invalid audio URI / audio download failed。
 */
export function isCloudUnreachableAudioUrl(url: string): boolean {
  const raw = (url || '').trim()
  if (!raw) return true
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local')
    ) {
      return true
    }
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) {
      return true
    }
    if (u.pathname.includes('/local-object')) {
      return true
    }
    return false
  } catch {
    return true
  }
}

export function isFlashCompatibleAudioFormat(format: string): boolean {
  return FLASH_FORMATS.has(format)
}

function preferFlash(format: string, size?: number): boolean {
  if (size != null && size > FLASH_MAX_BYTES) return false
  return FLASH_FORMATS.has(format)
}

function unwrapData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const rec = raw as Record<string, unknown>
  if (rec.success === false) {
    const code = typeof rec.code === 'string' ? rec.code : ''
    const msg =
      typeof rec.message === 'string'
        ? rec.message
        : code || '语音识别请求失败'
    const err = new Error(code ? `${code}: ${msg}` : msg)
    ;(err as Error & { code?: string }).code = code || undefined
    throw err
  }
  if (rec.success === true && rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>
  }
  return rec
}

function extractText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text.trim()
  }
  const result = payload.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const inner = result as Record<string, unknown>
    if (typeof inner.text === 'string' && inner.text.trim()) {
      return inner.text.trim()
    }
  }
  return ''
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function postSpeech(
  path: string,
  body: Record<string, unknown>,
  deps: TranscribeChatAudioDeps,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const token = await deps.getAccessToken()
  if (!token) {
    throw new Error('未登录，无法进行语音识别')
  }
  const fetchFn = deps.fetchImpl ?? fetch
  const url = joinApi(deps.apiBaseUrl, path)
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = deps.signal
    ? AbortSignal.any([timeout, deps.signal])
    : timeout

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: composed,
  })

  let raw: unknown
  try {
    raw = await resp.json()
  } catch {
    throw new Error(`语音识别服务响应异常（HTTP ${resp.status}）`)
  }

  if (!resp.ok) {
    const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const code = typeof rec.code === 'string' ? rec.code : ''
    const msg =
      typeof rec.message === 'string'
        ? rec.message
        : typeof rec.detail === 'string'
          ? rec.detail
          : `语音识别失败（HTTP ${resp.status}）`
    const err = new Error(code ? `${code}: ${msg}` : msg)
    ;(err as Error & { code?: string }).code = code || undefined
    throw err
  }

  return unwrapData(raw)
}

async function downloadAudioBytes(
  url: string,
  deps: TranscribeChatAudioDeps,
): Promise<Uint8Array> {
  const token = await deps.getAccessToken()
  const fetchFn = deps.fetchImpl ?? fetch
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const timeout = AbortSignal.timeout(60_000)
  const composed = deps.signal
    ? AbortSignal.any([timeout, deps.signal])
    : timeout

  const resp = await fetchFn(url, { headers, signal: composed })
  if (!resp.ok) {
    throw new Error(`本机下载音频失败（HTTP ${resp.status}）`)
  }
  const buf = new Uint8Array(await resp.arrayBuffer())
  if (buf.byteLength === 0) {
    throw new Error('本机下载的音频为空')
  }
  if (buf.byteLength > BASE64_UPLOAD_MAX_RAW_BYTES) {
    const err = new Error(
      `音频过大（${Math.round(buf.byteLength / 1024 / 1024)}MB），超过本地转写上限`,
    )
    ;(err as Error & { kind?: ChatAudioAsrFailureKind }).kind = 'local_too_large'
    throw err
  }
  return buf
}

async function recognizeFlash(
  attachment: ChatAudioAttachment,
  format: string,
  deps: TranscribeChatAudioDeps,
  options: { forceBase64: boolean },
): Promise<string> {
  const url = attachment.url!.trim()
  const body: Record<string, unknown> = {
    language: '',
    provider: 'bytedance',
    mode: 'flash',
    audio_format: format,
    organization_id: deps.organizationId,
  }

  if (options.forceBase64 || isCloudUnreachableAudioUrl(url)) {
    const bytes = await downloadAudioBytes(url, deps)
    body.audio_data = bytesToBase64(bytes)
  } else {
    body.audio_url = url
  }

  const data = await postSpeech('/services/speech/recognize/', body, deps, FLASH_TIMEOUT_MS)
  return extractText(data)
}

async function recognizeStandard(
  attachment: ChatAudioAttachment,
  format: string,
  deps: TranscribeChatAudioDeps,
): Promise<string> {
  const url = attachment.url!.trim()
  if (isCloudUnreachableAudioUrl(url)) {
    const err = new Error('本地 OSS 地址无法走标准版 ASR')
    ;(err as Error & { kind?: ChatAudioAsrFailureKind }).kind = 'local_unsupported_format'
    throw err
  }

  const sleep = deps.sleep ?? defaultSleep
  const submitted = await postSpeech(
    '/services/speech/submit/',
    {
      audio_url: url,
      language: '',
      provider: 'bytedance',
      audio_format: format,
      organization_id: deps.organizationId,
    },
    deps,
    60_000,
  )

  const taskIdRaw = submitted.taskId ?? submitted.task_id
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw : String(taskIdRaw ?? '')
  if (!taskId) {
    throw new Error('语音识别任务提交成功但未返回 task_id')
  }

  const deadline = Date.now() + STANDARD_POLL_MAX_MS
  while (Date.now() < deadline) {
    if (deps.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const queried = await postSpeech(
      '/services/speech/query/',
      {
        task_id: taskId,
        provider: 'bytedance',
        organization_id: deps.organizationId,
      },
      deps,
      30_000,
    )
    const status = typeof queried.status === 'string' ? queried.status : ''
    if (status === 'completed') {
      return extractText(queried)
    }
    if (status === 'failed' || status === 'silent') {
      const err =
        typeof queried.errorMessage === 'string'
          ? queried.errorMessage
          : typeof queried.error_message === 'string'
            ? queried.error_message
            : status === 'silent'
              ? '未检测到有效语音内容'
              : '语音识别任务失败'
      throw new Error(err)
    }
    await sleep(STANDARD_POLL_INTERVAL_MS, deps.signal)
  }
  const timeoutErr = new Error('语音识别超时')
  ;(timeoutErr as Error & { kind?: ChatAudioAsrFailureKind }).kind = 'timeout'
  throw timeoutErr
}

function looksLikeCloudDownloadFailure(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('invalid audio uri') ||
    m.includes('audio download failed') ||
    m.includes('45000006') ||
    m.includes('21701')
  )
}

/**
 * 把上游/本地错误归类，避免 Agent 把「本机 OSS 拉不到」说成「组织没开通 ASR」。
 */
export function classifyChatAudioAsrFailure(
  message: string,
  code?: string,
): ChatAudioAsrFailureKind {
  const m = (message || '').toLowerCase()
  const c = (code || '').toUpperCase()

  if (m.includes('用户已取消') || m.includes('aborted')) return 'cancelled'
  if (m.includes('未登录') || m.includes('缺少组织')) {
    return m.includes('组织') ? 'missing_org' : 'auth'
  }
  if (
    c === 'ASR_NOT_CONFIGURED' ||
    m.includes('asr_not_configured') ||
    m.includes('未在 db 配置') ||
    m.includes('语音识别服务未配置') ||
    m.includes('凭证未配置')
  ) {
    return 'not_configured'
  }
  if (
    m.includes('local_too_large') ||
    m.includes('超过本地转写上限') ||
    m.includes('音频过大')
  ) {
    return 'local_too_large'
  }
  if (
    m.includes('local_unsupported') ||
    m.includes('请先转为较短的 mp3') ||
    m.includes('本地开发存储') && m.includes('mp3')
  ) {
    return 'local_unsupported_format'
  }
  if (
    looksLikeCloudDownloadFailure(m) ||
    m.includes('本地 oss') ||
    m.includes('本机可访问') ||
    m.includes('local-object')
  ) {
    return 'local_oss'
  }
  if (m.includes('超时') || m.includes('timeout') || c.includes('TIMEOUT')) {
    return 'timeout'
  }
  if (
    m.includes('upstream') ||
    m.includes('暂时不可用') ||
    m.includes('asr_recognize_failed') ||
    c === 'ASR_RECOGNIZE_FAILED' ||
    /code=\d{8}/.test(m)
  ) {
    return 'upstream'
  }
  return 'generic'
}

const FAILURE_COPY: Record<
  ChatAudioAsrFailureKind,
  { headline: string; guidance: string }
> = {
  missing_org: {
    headline: '缺少组织信息，无法调用语音识别',
    guidance: '请切换到有效组织后重试；不要假装已经听到了音频内容。',
  },
  missing_url: {
    headline: '音频文件缺少可访问地址',
    guidance: '请重新上传音频后重试；不要假装已经听到了音频内容。',
  },
  cancelled: {
    headline: '语音识别已取消',
    guidance: '用户已停止生成；不要假装已经听到了音频内容。',
  },
  auth: {
    headline: '未登录，无法进行语音识别',
    guidance: '请先登录后重试；不要假装已经听到了音频内容。',
  },
  not_configured: {
    headline: '语音识别服务尚未配置（平台侧）',
    guidance:
      '这不是「组织没开通开关」这么简单——需要管理员在 AdminDash 配好字节 ASR 凭证。' +
      '请告知用户联系管理员；不要假装已经听到了音频内容。',
  },
  local_unsupported_format: {
    headline: '当前是本地开发存储，该音频格式无法自动转写',
    guidance:
      '请先转为较短的 mp3 / wav（约 14MB 以内）再拖入对话，或配置公网可访问的 OSS；' +
      '也可改用麦克风实时输入。不要假装已经听到了音频内容。',
  },
  local_too_large: {
    headline: '音频过大，本地开发存储无法自动转写',
    guidance:
      '请压缩到约 14MB 以内的短 mp3 / wav 后重试，或配置公网 OSS 后使用标准版识别；' +
      '不要假装已经听到了音频内容。',
  },
  local_oss: {
    headline: '音频在本地开发存储，云端无法直接拉取',
    guidance:
      '请重试一次（客户端会本机下载后转写）；若仍失败，改为较短 mp3 / wav，或配置公网 OSS。' +
      '不要把原因说成「组织没开通 ASR」。不要假装已经听到了音频内容。',
  },
  timeout: {
    headline: '语音识别超时',
    guidance: '请改用更短的音频后重试，或稍后再试；不要假装已经听到了音频内容。',
  },
  upstream: {
    headline: '语音识别上游暂时失败',
    guidance:
      '服务端已配置，但是上游识别出错。请稍后重试或改用较短 mp3 / wav / 麦克风；' +
      '不要说成「组织没开通」。不要假装已经听到了音频内容。',
  },
  generic: {
    headline: '语音识别失败',
    guidance: '请重试上传较短 mp3 / wav，或改用麦克风实时输入；不要假装已经听到了音频内容。',
  },
}

/**
 * 将转写结果格式化为注入 Agent 的附件正文（再外包 `<context type="attached">`）。
 */
export function formatChatAudioTranscriptBody(
  filename: string,
  transcript: string,
): string {
  const name = filename || '音频'
  const text = transcript.trim()
  if (!text) {
    return (
      `[音频: ${name}]\n` +
      `（语音识别完成但未检测到有效语音内容。请告知用户可重试上传，或改用麦克风实时输入。）`
    )
  }
  return `[音频转写: ${name}]\n${text}`
}

export function formatChatAudioTranscriptFailure(
  filename: string,
  reason: string,
  kind?: ChatAudioAsrFailureKind,
): string {
  const name = filename || '音频'
  const resolved =
    kind ??
    classifyChatAudioAsrFailure(reason, (reason.match(/^[A-Z0-9_]+/) || [])[0])
  const copy = FAILURE_COPY[resolved]
  // 给排障留一行短原因，但不要把上游 raw code 当主叙事
  const detail = reason.trim()
  const detailLine =
    detail && resolved !== 'cancelled'
      ? `\n（技术细节，勿原样念给用户：${detail.slice(0, 160)}）`
      : ''
  return (
    `[音频: ${name}]\n` +
    `${copy.headline}${detailLine}\n` +
    `请告知用户：${copy.guidance}`
  )
}

function failureResult(
  filename: string,
  reason: string,
  kind?: ChatAudioAsrFailureKind,
): TranscribeChatAudioResult {
  const resolved = kind ?? classifyChatAudioAsrFailure(reason)
  return {
    ok: false,
    kind: resolved,
    userMessage: formatChatAudioTranscriptFailure(filename, reason, resolved),
  }
}

/**
 * 对聊天上传的音频 URL 做 ASR，返回转写文本或面向用户的失败说明。
 */
export async function transcribeChatAudioAttachment(
  attachment: ChatAudioAttachment,
  deps: TranscribeChatAudioDeps,
): Promise<TranscribeChatAudioResult> {
  const filename = attachment.filename || '音频'

  if (!deps.organizationId?.trim()) {
    return failureResult(filename, '缺少组织信息，无法计费调用语音识别', 'missing_org')
  }
  if (!attachment.url?.trim()) {
    return failureResult(filename, '音频文件缺少可访问地址', 'missing_url')
  }

  if (!deps.disableCache) {
    const cached = readTranscriptCache(deps.organizationId, attachment.file_id)
    if (cached) {
      return { ok: true, text: cached.text, mode: cached.mode, fromCache: true }
    }
  }

  const format = inferAudioFormat(attachment.mime_type, attachment.filename)
  const unreachable = isCloudUnreachableAudioUrl(attachment.url)

  // 本地 / 内网 OSS：标准版不可用。非 flash 格式或过大 → 明确失败，绝不硬试。
  if (unreachable) {
    if (!isFlashCompatibleAudioFormat(format)) {
      return failureResult(
        filename,
        `本地开发存储不支持自动转写 .${format}，请先转为较短的 mp3 / wav`,
        'local_unsupported_format',
      )
    }
    if (attachment.size != null && attachment.size > BASE64_UPLOAD_MAX_RAW_BYTES) {
      return failureResult(
        filename,
        `音频过大（约 ${Math.round(attachment.size / 1024 / 1024)}MB），超过本地转写上限`,
        'local_too_large',
      )
    }
  }

  const useFlash = unreachable || preferFlash(format, attachment.size)

  try {
    if (useFlash) {
      const text = await recognizeFlash(attachment, format, deps, {
        forceBase64: unreachable,
      })
      if (!deps.disableCache) {
        writeTranscriptCache(deps.organizationId, attachment.file_id, text, 'flash')
      }
      return { ok: true, text, mode: 'flash' }
    }
    const text = await recognizeStandard(attachment, format, deps)
    if (!deps.disableCache) {
      writeTranscriptCache(deps.organizationId, attachment.file_id, text, 'standard')
    }
    return { ok: true, text, mode: 'standard' }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return failureResult(filename, '用户已取消', 'cancelled')
    }

    const msg = err instanceof Error ? err.message : String(err)
    const taggedKind = (err as Error & { kind?: ChatAudioAsrFailureKind }).kind
    const code = (err as Error & { code?: string }).code

    // 公网 URL 的 flash 若因云端下载失败，再试一次本机下载 + base64
    if (!unreachable && useFlash && looksLikeCloudDownloadFailure(msg)) {
      try {
        const text = await recognizeFlash(attachment, format, deps, { forceBase64: true })
        if (!deps.disableCache) {
          writeTranscriptCache(deps.organizationId, attachment.file_id, text, 'flash')
        }
        return { ok: true, text, mode: 'flash' }
      } catch (err2) {
        if (err2 instanceof DOMException && err2.name === 'AbortError') {
          return failureResult(filename, '用户已取消', 'cancelled')
        }
        const msg2 = err2 instanceof Error ? err2.message : String(err2)
        const kind2 =
          (err2 as Error & { kind?: ChatAudioAsrFailureKind }).kind ??
          classifyChatAudioAsrFailure(msg2, (err2 as Error & { code?: string }).code)
        return failureResult(filename, msg2, kind2)
      }
    }

    // 公网 flash 其它失败：再试 standard（仅公网 + flash 兼容格式）
    if (!unreachable && useFlash && preferFlash(format, attachment.size)) {
      try {
        const text = await recognizeStandard(attachment, format, deps)
        if (!deps.disableCache) {
          writeTranscriptCache(deps.organizationId, attachment.file_id, text, 'standard')
        }
        return { ok: true, text, mode: 'standard' }
      } catch (err2) {
        if (err2 instanceof DOMException && err2.name === 'AbortError') {
          return failureResult(filename, '用户已取消', 'cancelled')
        }
        const msg2 = err2 instanceof Error ? err2.message : String(err2)
        const kind2 =
          (err2 as Error & { kind?: ChatAudioAsrFailureKind }).kind ??
          classifyChatAudioAsrFailure(msg2, (err2 as Error & { code?: string }).code)
        return failureResult(filename, msg2, kind2)
      }
    }

    return failureResult(
      filename,
      msg,
      taggedKind ?? classifyChatAudioAsrFailure(msg, code),
    )
  }
}
