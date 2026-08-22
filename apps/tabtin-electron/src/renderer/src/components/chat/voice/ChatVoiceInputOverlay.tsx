/**
 * ChatVoiceInputOverlay — Agent 对话语音输入覆盖层
 *
 * 复刻 iOS ChatVoiceInputOverlay.swift 的完整交互流程：
 * idle → preparing → recording → processing → done
 *
 * 功能：
 * - 麦克风权限检查
 * - ASR 流式识别（通过 WebSocket）
 * - 实时转写文本显示
 * - 音量可视化
 * - 完成后：填入草稿 / 直接发送 / 取消
 */
/* eslint-disable tabtin/no-chat-design-violations -- 录音红是动作色，跟 VoiceRecordingCapsule 同语言 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, Trash2, Square, ArrowUp, TextCursorInput, RotateCcw, Loader2, AlertTriangle,
  ExternalLink,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { cn } from '@utils/cn'
import { getChatClient } from '@/services/chatApi'
import { useVoiceSettingsStore } from '@/stores/useVoiceSettingsStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { ASRStreamClient, buildDialogContext, type ASREmotionTag, emotionToEmoji } from './ASRStreamClient'
import { useAudioCapture } from './useAudioCapture'
import { AudioLevelVisualization } from './AudioLevelVisualization'
import { extractAppHotwords } from './extractAppHotwords'

export type VoiceResult =
  | { type: 'fillDraft'; text: string }
  | { type: 'sendDirectly'; text: string }
  | { type: 'cancelled' }

type RecordingState = 'idle' | 'preparing' | 'recording' | 'processing' | 'done' | 'error'

interface ChatVoiceInputOverlayProps {
  onResult: (result: VoiceResult) => void
  onClose: () => void
  messages?: Array<{ role: string; content: string }>
}

const MAX_DURATION = 120
const AUDIO_LEVELS_COUNT = 30
const ASR_DONE_TIMEOUT_MS = 5000
const SILENCE_THRESHOLD = 0.02
const SILENCE_AUTO_STOP_MS = 5000

export const ChatVoiceInputOverlay: React.FC<ChatVoiceInputOverlayProps> = ({
  onResult,
  onClose,
  messages = [],
}) => {
  const { t } = useTranslation('chat')
  const [state, setState] = useState<RecordingState>('idle')
  const [transcribedText, setTranscribedText] = useState('')
  const [duration, setDuration] = useState(0)
  const [audioLevels, setAudioLevels] = useState<number[]>(() => Array(AUDIO_LEVELS_COUNT).fill(0.05))
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPermissionError, setIsPermissionError] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const [emotion, setEmotion] = useState<ASREmotionTag | null>(null)
  const [visible, setVisible] = useState(false)

  const asrClientRef = useRef<ASRStreamClient | null>(null)
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const asrDoneResolveRef = useRef<(() => void) | null>(null)
  const stopRecordingRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const silenceStartRef = useRef<number | null>(null)
  const hasReceivedTextRef = useRef(false)
  const silenceStopFiredRef = useRef(false)
  const { startCapture, stopCapture } = useAudioCapture()

  const hasText = transcribedText.trim().length > 0

  const formattedDuration = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`
  const isNearLimit = MAX_DURATION - duration <= 15

  const stopRecordingInternal = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
    stopCapture()
    asrClientRef.current?.stop()
  }, [stopCapture])

  const handleStopRecording = useCallback(async () => {
    setState('processing')
    stopRecordingInternal()

    await new Promise<void>(resolve => {
      let resolved = false
      const done = () => { if (!resolved) { resolved = true; resolve() } }

      const timeout = setTimeout(done, ASR_DONE_TIMEOUT_MS)

      asrDoneResolveRef.current = () => {
        clearTimeout(timeout)
        done()
      }

      const client = asrClientRef.current
      if (!client) { clearTimeout(timeout); done(); return }

      const prevOnTranscript = client.onTranscript
      client.onTranscript = (text, isFinal) => {
        prevOnTranscript?.(text, isFinal)
        if (isFinal) {
          asrDoneResolveRef.current?.()
          asrDoneResolveRef.current = null
        }
      }
    })

    asrDoneResolveRef.current = null
    setState('done')
  }, [stopRecordingInternal])

  // ref 保存最新的 handleStopRecording 供 timer 使用
  stopRecordingRef.current = handleStopRecording

  const startRecording = useCallback(async () => {
    setState('preparing')
    setErrorMessage(null)
    setIsPermissionError(false)
    setTranscribedText('')
    setDuration(0)
    setAudioLevels(Array(AUDIO_LEVELS_COUNT).fill(0.05))
    setEmotion(null)

    try {
      const gateway = getChatClient().getGateway()
      const organizationId = useOrganizationStore.getState().getEffectiveOrganizationId() ?? undefined
      const voiceSettings = useVoiceSettingsStore.getState()

      const preconnected = ASRStreamClient.consumePreconnected(organizationId)
      const asrClient = preconnected ?? new ASRStreamClient(gateway, organizationId)
      asrClientRef.current = asrClient

      asrClient.onTranscript = (text, isFinal) => {
        // ：interim 也替换（与 useVoiceRecording 一致）。
        const processed = voiceSettings.applyReplacements(text)
        setTranscribedText(processed)
        if (text.trim()) {
          hasReceivedTextRef.current = true
          silenceStartRef.current = null
        }
        if (isFinal) {
          setState(prev => prev === 'processing' ? 'done' : prev)
        }
      }
      asrClient.onError = (msg) => {
        setErrorMessage(msg)
        setState('error')
      }
      asrClient.onEmotion = (tag) => setEmotion(tag)

      if (!preconnected) {
        const context = voiceSettings.enableDialogContext ? buildDialogContext(messages) : undefined
        const appHotwords = extractAppHotwords()
        const hotwords = voiceSettings.mergedHotwords(appHotwords)
        await asrClient.start({ context, hotwords })
      }

      silenceStartRef.current = null
      hasReceivedTextRef.current = false
      silenceStopFiredRef.current = false

      await startCapture({
        onChunk: (pcmData) => asrClient.sendAudio(pcmData),
        onLevel: (level) => {
          setAudioLevels(prev => {
            const next = [...prev.slice(1), level]
            return next
          })

          if (silenceStopFiredRef.current) return

          if (level < SILENCE_THRESHOLD) {
            if (!silenceStartRef.current) {
              silenceStartRef.current = Date.now()
            } else if (
              hasReceivedTextRef.current &&
              Date.now() - silenceStartRef.current >= SILENCE_AUTO_STOP_MS
            ) {
              silenceStopFiredRef.current = true
              queueMicrotask(() => stopRecordingRef.current?.())
            }
          } else {
            silenceStartRef.current = null
          }
        },
      })

      setState('recording')
      setRetryCount(0)

      durationTimerRef.current = setInterval(() => {
        setDuration(prev => {
          const next = prev + 1
          if (next >= MAX_DURATION) {
            queueMicrotask(() => stopRecordingRef.current?.())
          }
          return next
        })
      }, 1000)
    } catch (err: any) {
      console.error('[VoiceInput] Start failed:', err)
      if (err?.name === 'NotAllowedError' || err?.message?.includes('Permission')) {
        setIsPermissionError(true)
      }
      setErrorMessage(err?.message ?? t('voice.errorGeneric'))
      setState('error')
    }
  }, [messages, startCapture, t])

  const handleCancel = useCallback(() => {
    stopRecordingInternal()
    asrClientRef.current?.cleanup()
    asrClientRef.current = null
    setVisible(false)
    setTimeout(() => {
      onResult({ type: 'cancelled' })
      onClose()
    }, 300)
  }, [stopRecordingInternal, onResult, onClose])

  const handleFillDraft = useCallback(() => {
    const text = transcribedText.trim()
    if (!text) return
    asrClientRef.current?.cleanup()
    asrClientRef.current = null
    setVisible(false)
    setTimeout(() => {
      onResult({ type: 'fillDraft', text })
      onClose()
    }, 300)
  }, [transcribedText, onResult, onClose])

  const handleSendDirectly = useCallback(() => {
    const text = transcribedText.trim()
    if (!text) return
    asrClientRef.current?.cleanup()
    asrClientRef.current = null
    setVisible(false)
    setTimeout(() => {
      onResult({ type: 'sendDirectly', text })
      onClose()
    }, 300)
  }, [transcribedText, onResult, onClose])

  const handleRetry = useCallback(() => {
    setRetryCount(prev => prev + 1)
    asrClientRef.current?.cleanup()
    asrClientRef.current = null
    startRecording()
  }, [startRecording])

  /**
   * 麦克风权限被拒绝时跳转到系统设置 —— 比让用户自己摸去隐私面板友好得多。
   * 走 osPermissions IPC（与「授权」面板共用同一条链路），Electron 之外
   * 的运行环境（如 web 预览）静默 noop。
   */
  const handleOpenMicSettings = useCallback(async () => {
    try {
      const osPermissions = (
        window as unknown as {
          tabtin?: { osPermissions?: { openSettings?: (k: string) => Promise<boolean> } }
        }
      ).tabtin?.osPermissions
      await osPermissions?.openSettings?.('microphone')
    } catch (err) {
      console.warn('[VoiceInput] open mic settings failed:', err)
    }
  }, [])

  // animate in + auto-start
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 16)
    const startTimer = setTimeout(() => startRecording(), 300)
    return () => {
      clearTimeout(timer)
      clearTimeout(startTimer)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current)
      stopCapture()
      asrClientRef.current?.cleanup()
    }
  }, [stopCapture])

  // Escape 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state !== 'processing') {
        handleCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [state, handleCancel])

  const statusText = (() => {
    switch (state) {
      case 'idle':
      case 'preparing': return t('voice.connecting')
      case 'recording': return t('voice.recording')
      case 'processing': return t('voice.processing')
      case 'done': return t('voice.done')
      case 'error': return t('voice.error')
    }
  })()

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('voice.inputTitle')}
    >
      {/* Backdrop */}
      <div
        className={cn(
          'absolute inset-0 overlay-backdrop-blur transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        onClick={state !== 'processing' ? handleCancel : undefined}
      />

      {/* Card */}
      <div
        className={cn(
          'relative w-full max-w-[480px] mx-4 rounded-2xl transition-all duration-300',
          OVERLAY_SURFACE_CLASS,
          visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[60px]'
        )}
      >
        <div className="p-5 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {state === 'recording' && (
                <span className="inline-flex h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              )}
              <span className="text-body font-medium text-muted-foreground">
                {statusText}
              </span>
              {emotion && (state === 'recording' || state === 'processing' || state === 'done') && (
                <span className="text-subtitle animate-in fade-in duration-300">
                  {emotionToEmoji(emotion)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {state === 'recording' && (
                <span className={cn(
                  'text-caption font-mono tabular-nums',
                  isNearLimit ? 'text-destructive' : 'text-muted-foreground/60'
                )}>
                  {formattedDuration}
                </span>
              )}
              <button
                type="button"
                onClick={handleCancel}
                disabled={state === 'processing'}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-muted/30 text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Transcription */}
          <div className="min-h-[60px]">
            {state === 'done' && !hasText ? (
              <div className="flex flex-col items-center gap-2 py-2">
                <TextCursorInput className="h-5 w-5 text-muted-foreground/40" />
                <span className="text-body text-muted-foreground/60">
                  {t('voice.emptyResult')}
                </span>
              </div>
            ) : state === 'done' && hasText ? (
              <div className="max-h-[160px]">
                <textarea
                  value={transcribedText}
                  onChange={(e) => setTranscribedText(e.target.value)}
                  aria-label={t('voice.transcriptEdit')}
                  className="w-full h-full min-h-[60px] max-h-[160px] resize-none bg-muted/15 rounded-lg px-3 py-2 text-body text-foreground leading-relaxed border border-border/20 focus:outline-none focus:ring-1 focus:ring-accent/30 transition-colors"
                  autoFocus
                />
              </div>
            ) : transcribedText ? (
              <div className="max-h-[160px] overflow-y-auto">
                <p className="text-body text-foreground leading-relaxed">
                  {transcribedText}
                </p>
              </div>
            ) : state === 'recording' ? (
              <p className="text-body text-muted-foreground/40">
                {t('voice.listening')}
              </p>
            ) : state === 'preparing' ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />
                <span className="text-body text-muted-foreground/60">
                  {t('voice.connecting')}
                </span>
              </div>
            ) : null}
          </div>

          {/* Audio Visualization */}
          {state === 'recording' && (
            <AudioLevelVisualization levels={audioLevels} />
          )}

          {/* Controls */}
          <div className="flex items-center justify-center gap-6">
            {state === 'recording' && (
              <>
                <VoiceButton
                  icon={<Trash2 className="h-[18px] w-[18px]" />}
                  label={t('voice.cancel')}
                  onClick={handleCancel}
                  variant="secondary"
                />
                <VoiceButton
                  icon={<Square className="h-5 w-5 fill-current" />}
                  label={t('voice.finish')}
                  onClick={handleStopRecording}
                  variant="destructive"
                  large
                />
              </>
            )}

            {state === 'done' && hasText && (
              <>
                <VoiceButton
                  icon={<Trash2 className="h-[18px] w-[18px]" />}
                  label={t('voice.cancel')}
                  onClick={handleCancel}
                  variant="secondary"
                />
                <VoiceButton
                  icon={<TextCursorInput className="h-[18px] w-[18px]" />}
                  label={t('voice.fillDraft')}
                  onClick={handleFillDraft}
                  variant="accent-outline"
                />
                <VoiceButton
                  icon={<ArrowUp className="h-5 w-5" strokeWidth={2.5} />}
                  label={t('voice.sendDirectly')}
                  onClick={handleSendDirectly}
                  variant="accent"
                  large
                />
              </>
            )}

            {state === 'done' && !hasText && (
              <>
                <VoiceButton
                  icon={<X className="h-4 w-4" />}
                  label={t('voice.close')}
                  onClick={handleCancel}
                  variant="secondary"
                />
                <VoiceButton
                  icon={<RotateCcw className="h-5 w-5" />}
                  label={t('voice.retry')}
                  onClick={handleRetry}
                  variant="accent"
                  large
                />
              </>
            )}

            {(state === 'idle' || state === 'preparing') && (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/60" />
              </div>
            )}

            {state === 'processing' && (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/60" />
                <span className="text-caption text-muted-foreground/60">
                  {t('voice.processing')}
                </span>
              </div>
            )}

            {state === 'error' && (
              <div className="flex flex-col items-center gap-4">
                <AlertTriangle className="h-7 w-7 text-warning" />
                {errorMessage && (
                  <p className="text-caption text-muted-foreground text-center max-w-[280px] line-clamp-3">
                    {isPermissionError ? t('voice.micPermission') : errorMessage}
                  </p>
                )}
                <div className="flex items-center gap-5">
                  <VoiceButton
                    icon={<X className="h-4 w-4" />}
                    label={t('voice.close')}
                    onClick={handleCancel}
                    variant="secondary"
                  />
                  {isPermissionError ? (
                    <VoiceButton
                      icon={<ExternalLink className="h-5 w-5" />}
                      label={t('voice.openMicSettings')}
                      onClick={handleOpenMicSettings}
                      variant="accent"
                      large
                    />
                  ) : retryCount < 3 ? (
                    <VoiceButton
                      icon={<RotateCcw className="h-5 w-5" />}
                      label={t('voice.retry')}
                      onClick={handleRetry}
                      variant="accent"
                      large
                    />
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- VoiceButton 内部组件 ---------- */

type VoiceButtonVariant = 'secondary' | 'destructive' | 'accent' | 'accent-outline'

const VoiceButton: React.FC<{
  icon: React.ReactNode
  label: string
  onClick: () => void
  variant: VoiceButtonVariant
  large?: boolean
  disabled?: boolean
}> = ({ icon, label, onClick, variant, large, disabled }) => {
  const size = large ? 'h-14 w-14' : 'h-11 w-11'

  const variantClasses: Record<VoiceButtonVariant, string> = {
    secondary: 'bg-muted/30 text-muted-foreground/60 hover:bg-muted/60',
    destructive: 'bg-red-500 text-white shadow-[0_2px_8px_rgba(239,68,68,0.3)] hover:bg-red-600',
    accent: 'bg-accent text-accent-foreground shadow-[0_2px_8px_hsl(var(--accent)/0.3)] hover:bg-accent/85',
    'accent-outline': 'bg-accent/10 text-accent hover:bg-accent/20',
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center gap-1 disabled:opacity-40"
    >
      <div className={cn(
        'flex items-center justify-center rounded-full transition-colors',
        size,
        variantClasses[variant],
      )}>
        {icon}
      </div>
      <span className="text-caption text-muted-foreground/60">{label}</span>
    </button>
  )
}
