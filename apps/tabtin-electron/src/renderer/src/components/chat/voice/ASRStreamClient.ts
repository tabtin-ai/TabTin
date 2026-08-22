/**
 * ASR 流式识别客户端 — 复刻 iOS ASRStreamClient 协议。
 *
 * 协议流程：
 *   1. 发送 `asr.stream.start` → 收到 `asr.stream.started`（含 stream_id）
 *   2. 发送 `asr.stream.audio`（base64 音频块） → 收到 `asr.stream.event`（实时文本）
 *   3. 发送 `asr.stream.stop` → 收到 `asr.stream.done`（最终文本）
 */

import type { WsGateway } from '@tabtin/chat-client'

export type ASREmotionTag = 'angry' | 'happy' | 'neutral' | 'sad' | 'surprise'

const EMOTION_EMOJI: Record<ASREmotionTag, string> = {
  angry: '😠',
  happy: '😊',
  neutral: '😐',
  sad: '😢',
  surprise: '😮',
}

export function emotionToEmoji(tag: ASREmotionTag): string {
  return EMOTION_EMOJI[tag] ?? ''
}

export interface ASRConfig {
  audioFormat?: string
  sampleRate?: number
  provider?: string
  wsEndpoint?: string
  enableNonstream?: boolean
  enableAccelerateText?: boolean
  accelerateScore?: number
  enableEmotionDetection?: boolean
  context?: string
  hotwords?: string[]
  maxDuration?: number
}

const DEFAULT_ASR_CONFIG: Required<Pick<ASRConfig, 'audioFormat' | 'sampleRate' | 'provider' | 'wsEndpoint' | 'enableNonstream' | 'enableAccelerateText' | 'accelerateScore' | 'enableEmotionDetection' | 'maxDuration'>> = {
  audioFormat: 'pcm',
  sampleRate: 16000,
  provider: 'bytedance',
  wsEndpoint: 'bigmodel_async',
  enableNonstream: true,
  enableAccelerateText: true,
  accelerateScore: 10,
  enableEmotionDetection: true,
  maxDuration: 120,
}

export function buildASRPayload(config: ASRConfig = {}): Record<string, any> {
  const c = { ...DEFAULT_ASR_CONFIG, ...config }
  const payload: Record<string, any> = {
    audio_format: c.audioFormat,
    sample_rate: c.sampleRate,
    provider: c.provider,
    ws_endpoint: c.wsEndpoint,
    enable_itn: true,
    enable_punc: true,
    enable_ddc: true,
    show_utterances: true,
  }

  if (c.wsEndpoint === 'bigmodel_async' && c.enableNonstream) {
    payload.enable_nonstream = true
  }
  if (c.enableAccelerateText) {
    payload.enable_accelerate_text = true
    payload.accelerate_score = Math.min(20, Math.max(0, c.accelerateScore))
  }
  if (c.enableEmotionDetection) {
    payload.enable_emotion_detection = true
  }

  const contextDict: Record<string, any> = {}
  if (config.context) {
    try {
      Object.assign(contextDict, JSON.parse(config.context))
    } catch { /* ignore invalid context */ }
  }
  if (config.hotwords?.length) {
    contextDict.hotwords = config.hotwords.map(word => ({ word }))
  }
  if (Object.keys(contextDict).length > 0) {
    payload.context = JSON.stringify(contextDict)
  }

  return payload
}

/**
 * 从对话消息列表构建 context JSON 字符串（与 iOS VoiceConfig.buildDialogContext 一致）。
 */
export function buildDialogContext(
  messages: Array<{ role: string; content: string }>,
  maxRounds = 10,
  maxContentLength = 200
): string | undefined {
  const dialogMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  const recent = dialogMessages.slice(-maxRounds)
  if (recent.length === 0) return undefined

  const contextData = recent.map(msg => {
    const prefix = msg.role === 'user' ? '用户' : '助手'
    const content = msg.content.length > maxContentLength
      ? msg.content.slice(0, maxContentLength) + '...'
      : msg.content
    return { text: `${prefix}: ${content}` }
  })

  return JSON.stringify({ context_type: 'dialog_ctx', context_data: contextData })
}

export interface ASRStreamCallbacks {
  onTranscript?: (text: string, isFinal: boolean) => void
  onEmotion?: (tag: ASREmotionTag) => void
  onError?: (message: string) => void
}

const STALE_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 10_000
const PRECONNECT_TTL_MS = 8_000

export class ASRStreamClient {
  private gateway: WsGateway
  private streamId: string | null = null
  private listenerRef: ((envelope: any) => void) | null = null
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private lastEventTime = 0
  private active = false
  private organizationId: string | undefined

  onTranscript: ASRStreamCallbacks['onTranscript'] = undefined
  onEmotion: ASRStreamCallbacks['onEmotion'] = undefined
  onError: ASRStreamCallbacks['onError'] = undefined

  constructor(gateway: WsGateway, organizationId?: string) {
    this.gateway = gateway
    this.organizationId = organizationId
  }

  private get sendOptions() {
    return this.organizationId ? { organizationId: this.organizationId } : undefined
  }

  async start(config: ASRConfig = {}): Promise<string> {
    if (this.active) throw new Error('ASR stream already active')

    const ready = await this.gateway.connect()
    if (!ready) throw new Error('WebSocket not connected')

    this.registerListener()

    const requestOptions = {
      ...(this.sendOptions ?? {}),
      timeoutMs: START_TIMEOUT_MS,
    }
    const response = await this.gateway.request(
      'asr.stream.start',
      buildASRPayload(config),
      requestOptions,
    )

    if (!response.ok) {
      this.cleanup()
      throw new Error(getASRStartErrorMessage(response.error))
    }

    if (response.type !== 'asr.stream.started') {
      this.cleanup()
      throw new Error(`Unexpected ASR start response: ${response.type}`)
    }

    const sid = response.payload?.stream_id
    if (!sid) {
      this.cleanup()
      throw new Error('ASR start response missing stream_id')
    }

    this.activateStream(sid)
    return sid
  }

  sendAudio(pcmData: ArrayBuffer): void {
    if (!this.streamId || !this.active) return
    const base64 = arrayBufferToBase64(pcmData)
    this.gateway.send('asr.stream.audio', {
      stream_id: this.streamId,
      data: base64,
    }, this.sendOptions)
  }

  stop(): void {
    if (!this.streamId || !this.active) return
    this.gateway.send('asr.stream.stop', {
      stream_id: this.streamId,
    }, this.sendOptions)
  }

  cleanup(): void {
    this.active = false
    this.streamId = null
    if (this.staleTimer) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
    if (this.listenerRef) {
      this.gateway.removeListener(this.listenerRef)
      this.listenerRef = null
    }
    this.onTranscript = undefined
    this.onEmotion = undefined
    this.onError = undefined
  }

  // ---- Preconnect 机制 ----

  private static _preconnected: ASRStreamClient | null = null
  private static _preconnectTimer: ReturnType<typeof setTimeout> | null = null
  private static _preconnectInflight: Promise<void> | null = null
  private static _preconnectedOrganizationId: string | undefined
  private static _preconnectEpoch = 0

  /**
   * 预连接 ASR 通道。在用户 hover / focus 麦克风按钮时调用，
   * 提前建立 ASR stream，消除首次启动延迟。
   *
   * 保证单飞：in-flight 期间重复调用被忽略。
   * 预连接的 session 在 PRECONNECT_TTL_MS 后自动销毁。
   * 使用 epoch 计数防止 cancelPreconnect 与异步完成之间的竞态。
   */
  static async preconnect(gateway: WsGateway, config: ASRConfig = {}, organizationId?: string): Promise<void> {
    if (ASRStreamClient._preconnected || ASRStreamClient._preconnectInflight) return

    const epoch = ++ASRStreamClient._preconnectEpoch

    ASRStreamClient._preconnectInflight = (async () => {
      const client = new ASRStreamClient(gateway, organizationId)
      try {
        await client.start(config)

        if (ASRStreamClient._preconnectEpoch !== epoch) {
          client.stop()
          client.cleanup()
          return
        }

        ASRStreamClient._preconnected = client
        ASRStreamClient._preconnectedOrganizationId = organizationId

        client.onError = () => {
          ASRStreamClient.cancelPreconnect()
        }

        ASRStreamClient._preconnectTimer = setTimeout(() => {
          ASRStreamClient.cancelPreconnect()
        }, PRECONNECT_TTL_MS)
      } catch {
        client.cleanup()
      }
    })()

    try {
      await ASRStreamClient._preconnectInflight
    } finally {
      ASRStreamClient._preconnectInflight = null
    }
  }

  /**
   * 消费预连接的客户端。
   * 校验 organizationId 一致性和 active 状态，不一致则丢弃。
   */
  static consumePreconnected(organizationId?: string): ASRStreamClient | null {
    if (ASRStreamClient._preconnectTimer) {
      clearTimeout(ASRStreamClient._preconnectTimer)
      ASRStreamClient._preconnectTimer = null
    }

    const client = ASRStreamClient._preconnected
    ASRStreamClient._preconnected = null

    if (!client) return null

    if (!client.active || ASRStreamClient._preconnectedOrganizationId !== organizationId) {
      client.stop()
      client.cleanup()
      return null
    }

    ASRStreamClient._preconnectedOrganizationId = undefined
    return client
  }

  static cancelPreconnect(): void {
    ASRStreamClient._preconnectEpoch++
    ASRStreamClient._preconnectInflight = null
    if (ASRStreamClient._preconnectTimer) {
      clearTimeout(ASRStreamClient._preconnectTimer)
      ASRStreamClient._preconnectTimer = null
    }
    if (ASRStreamClient._preconnected) {
      ASRStreamClient._preconnected.stop()
      ASRStreamClient._preconnected.cleanup()
      ASRStreamClient._preconnected = null
    }
    ASRStreamClient._preconnectedOrganizationId = undefined
  }

  // ---- Private ----

  private registerListener(): void {
    this.listenerRef = (envelope: any) => this.handleEnvelope(envelope)
    this.gateway.addListener(this.listenerRef)
  }

  private handleEnvelope(envelope: any): void {
    const type = envelope?.type
    if (!type?.startsWith('asr.stream.')) return

    this.lastEventTime = Date.now()

    switch (type) {
      case 'asr.stream.started': {
        const sid = envelope.payload?.stream_id
        if (sid && !this.streamId) {
          this.activateStream(sid)
        }
        break
      }

      case 'asr.stream.event': {
        const sid = envelope.payload?.stream_id
        if (sid !== this.streamId) return
        const text = envelope.payload?.text ?? ''
        this.onTranscript?.(text, false)
        this.extractEmotion(envelope)
        break
      }

      case 'asr.stream.done': {
        const sid = envelope.payload?.stream_id
        if (sid !== this.streamId) return
        const text = envelope.payload?.text ?? ''
        this.onTranscript?.(text, true)
        this.extractEmotion(envelope)
        this.active = false
        this.stopStaleWatchdog()
        if (this.listenerRef) {
          this.gateway.removeListener(this.listenerRef)
          this.listenerRef = null
        }
        break
      }

      case 'asr.stream.error': {
        const sid = envelope.payload?.stream_id
        if (sid !== this.streamId) return
        const errorMsg = envelope.payload?.error ?? 'ASR stream error'
        this.onError?.(errorMsg)
        this.active = false
        this.stopStaleWatchdog()
        if (this.listenerRef) {
          this.gateway.removeListener(this.listenerRef)
          this.listenerRef = null
        }
        this.evictFromPreconnectSlot()
        break
      }
    }
  }

  private activateStream(streamId: string): void {
    this.streamId = streamId
    this.active = true
    this.lastEventTime = Date.now()
    this.startStaleWatchdog()
  }

  private startStaleWatchdog(): void {
    this.stopStaleWatchdog()
    this.staleTimer = setInterval(() => {
      if (!this.active) {
        this.stopStaleWatchdog()
        return
      }
      const elapsed = Date.now() - this.lastEventTime
      if (elapsed >= STALE_TIMEOUT_MS) {
        this.onError?.('ASR stream stale timeout')
        this.active = false
        this.stopStaleWatchdog()
        if (this.listenerRef) {
          this.gateway.removeListener(this.listenerRef)
          this.listenerRef = null
        }
        this.evictFromPreconnectSlot()
      }
    }, 10_000)
  }

  private stopStaleWatchdog(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
  }

  private evictFromPreconnectSlot(): void {
    if (ASRStreamClient._preconnected === this) {
      ASRStreamClient._preconnected = null
      ASRStreamClient._preconnectedOrganizationId = undefined
      if (ASRStreamClient._preconnectTimer) {
        clearTimeout(ASRStreamClient._preconnectTimer)
        ASRStreamClient._preconnectTimer = null
      }
    }
  }

  private extractEmotion(envelope: any): void {
    const utterances = envelope.payload?.utterances
    if (!Array.isArray(utterances)) return

    let bestEmotion: ASREmotionTag | null = null
    for (const utt of utterances) {
      const emotionStr = utt?.additions?.emotion
      if (!emotionStr || !isASREmotionTag(emotionStr)) continue
      if (utt.definite) {
        this.onEmotion?.(emotionStr)
        return
      }
      bestEmotion = emotionStr
    }
    if (bestEmotion) {
      this.onEmotion?.(bestEmotion)
    }
  }
}

function isASREmotionTag(s: string): s is ASREmotionTag {
  return s === 'angry' || s === 'happy' || s === 'neutral' || s === 'sad' || s === 'surprise'
}

function getASRStartErrorMessage(error?: { code?: string; message?: string }): string {
  if (error?.code === 'WS_REQUEST_TIMEOUT') return 'ASR start timeout'
  return error?.message || 'ASR start failed'
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}
