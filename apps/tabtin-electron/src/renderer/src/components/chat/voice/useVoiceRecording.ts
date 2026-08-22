/**
 * useVoiceRecording — 语音录制状态管理 Hook
 *
 * 从 ChatVoiceInputOverlay 中抽取的核心录制逻辑：
 * ASR 客户端管理、音频采集、静默检测、超时、preconnect 复用。
 * 不包含任何 UI 元素。
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { getChatClient } from '@/services/chatApi'
import { useVoiceSettingsStore } from '@/stores/useVoiceSettingsStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { ASRStreamClient, buildDialogContext } from './ASRStreamClient'
import { useAudioCapture } from './useAudioCapture'
import { extractAppHotwords } from './extractAppHotwords'
import {
  ensureMicrophonePermission,
  getMicrophonePermissionMessage,
  isMicrophonePermissionError,
  MicrophonePermissionError,
  type VoiceRecordingErrorKind,
} from './voiceMicrophonePermission'

export type VoiceRecordingState = 'idle' | 'preparing' | 'recording' | 'error'
export type { VoiceRecordingErrorKind } from './voiceMicrophonePermission'

export const MAX_DURATION = 120
const AUDIO_LEVELS_COUNT = 12
const ASR_DONE_TIMEOUT_MS = 5000
const SILENCE_THRESHOLD = 0.02
const SILENCE_AUTO_STOP_MS = 5000
const ERROR_RECOVERY_MS = 2000

export interface UseVoiceRecordingOptions {
  messages?: Array<{ role: string; content: string }>
  onTranscript: (text: string, isFinal: boolean) => void
  onRecordingEnd?: () => void
}

export interface UseVoiceRecordingReturn {
  state: VoiceRecordingState
  audioLevels: number[]
  duration: number
  errorMessage: string | null
  errorKind: VoiceRecordingErrorKind | null
  startRecording: () => void
  stopRecording: () => void
  cancelRecording: () => void
}

export function useVoiceRecording({
  messages = [],
  onTranscript,
  onRecordingEnd,
}: UseVoiceRecordingOptions): UseVoiceRecordingReturn {
  const [state, setState] = useState<VoiceRecordingState>('idle')
  const [duration, setDuration] = useState(0)
  const [audioLevels, setAudioLevels] = useState<number[]>(() =>
    Array(AUDIO_LEVELS_COUNT).fill(0.05),
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<VoiceRecordingErrorKind | null>(null)

  const asrClientRef = useRef<ASRStreamClient | null>(null)
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const asrDoneResolveRef = useRef<(() => void) | null>(null)
  const silenceStartRef = useRef<number | null>(null)
  const hasReceivedTextRef = useRef(false)
  const silenceStopFiredRef = useRef(false)
  const onTranscriptRef = useRef(onTranscript)
  const onRecordingEndRef = useRef(onRecordingEnd)
  const sessionRef = useRef(0)
  const busyRef = useRef(false)
  const { startCapture, stopCapture } = useAudioCapture()

  onTranscriptRef.current = onTranscript
  onRecordingEndRef.current = onRecordingEnd

  const teardown = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
    stopCapture()
    asrClientRef.current?.stop()
    asrClientRef.current?.cleanup()
    asrClientRef.current = null
    busyRef.current = false
  }, [stopCapture])

  const startRecording = useCallback(() => {
    if (busyRef.current) return
    busyRef.current = true

    const session = ++sessionRef.current
    setState('preparing')
    setErrorMessage(null)
    setErrorKind(null)
    setDuration(0)
    setAudioLevels(Array(AUDIO_LEVELS_COUNT).fill(0.05))

    void (async () => {
      let capturePhase = false
      try {
        if (!await ensureMicrophonePermission()) {
          ASRStreamClient.cancelPreconnect()
          throw new MicrophonePermissionError()
        }

        const gateway = getChatClient().getGateway()
        const organizationId =
          useOrganizationStore.getState().getEffectiveOrganizationId() ?? undefined
        const voiceSettings = useVoiceSettingsStore.getState()

        const preconnected = ASRStreamClient.consumePreconnected(organizationId)
        const asrClient =
          preconnected ?? new ASRStreamClient(gateway, organizationId)

        if (sessionRef.current !== session) {
          asrClient.cleanup()
          return
        }

        asrClientRef.current = asrClient

        asrClient.onTranscript = (text, isFinal) => {
          if (sessionRef.current !== session) return
          // ：interim 也替换，避免 cancel-on-submit 跳过 done。
          const processed = voiceSettings.applyReplacements(text)
          onTranscriptRef.current(processed, isFinal)
          if (text.trim()) {
            hasReceivedTextRef.current = true
            silenceStartRef.current = null
          }
        }
        asrClient.onError = (msg) => {
          if (sessionRef.current !== session) return
          teardown()
          setErrorMessage(msg)
          setState('error')
        }

        if (!preconnected) {
          const context = voiceSettings.enableDialogContext
            ? buildDialogContext(messages)
            : undefined
          const appHotwords = extractAppHotwords()
          const hotwords = voiceSettings.mergedHotwords(appHotwords)
          await asrClient.start({ context, hotwords })
        }

        if (sessionRef.current !== session) {
          asrClient.stop()
          asrClient.cleanup()
          return
        }

        silenceStartRef.current = null
        hasReceivedTextRef.current = false
        silenceStopFiredRef.current = false

        const stopRef = { current: null as (() => void) | null }

        capturePhase = true
        await startCapture({
          onChunk: (pcmData) => asrClient.sendAudio(pcmData),
          onLevel: (level) => {
            if (sessionRef.current !== session) return

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
                queueMicrotask(() => stopRef.current?.())
              }
            } else {
              silenceStartRef.current = null
            }
          },
        })
        capturePhase = false

        if (sessionRef.current !== session) {
          teardown()
          return
        }

        setState('recording')

        durationTimerRef.current = setInterval(() => {
          setDuration(prev => {
            const next = prev + 1
            if (next >= MAX_DURATION) {
              queueMicrotask(() => stopRef.current?.())
            }
            return next
          })
        }, 1000)

        stopRef.current = () => {
          if (sessionRef.current !== session) return
          stopRecordingForSession(session)
        }
      } catch (err: unknown) {
        if (sessionRef.current !== session) return
        const micPermissionError = err instanceof MicrophonePermissionError ||
          (capturePhase && isMicrophonePermissionError(err))
        const message = micPermissionError
          ? getMicrophonePermissionMessage()
          : err instanceof Error
            ? err.message
            : 'Voice recording failed'
        console.error('[VoiceRecording] Start failed:', err)
        if (micPermissionError) {
          ASRStreamClient.cancelPreconnect()
        }
        teardown()
        setErrorMessage(message)
        setErrorKind(micPermissionError ? 'microphone-permission' : null)
        setState('error')
      }
    })()
  }, [messages, startCapture, teardown])

  const stopRecordingForSession = useCallback((session: number) => {
    if (sessionRef.current !== session) return

    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
    stopCapture()
    asrClientRef.current?.stop()

    const client = asrClientRef.current

    const finish = () => {
      if (sessionRef.current !== session) return
      asrClientRef.current?.cleanup()
      asrClientRef.current = null
      busyRef.current = false
      setState('idle')
      setDuration(0)
      onRecordingEndRef.current?.()
    }

    if (!client) {
      finish()
      return
    }

    let resolved = false
    const done = () => {
      if (!resolved) {
        resolved = true
        finish()
      }
    }

    const timeout = setTimeout(done, ASR_DONE_TIMEOUT_MS)

    asrDoneResolveRef.current = () => {
      clearTimeout(timeout)
      done()
    }

    const prevOnTranscript = client.onTranscript
    client.onTranscript = (text, isFinal) => {
      prevOnTranscript?.(text, isFinal)
      if (isFinal) {
        asrDoneResolveRef.current?.()
        asrDoneResolveRef.current = null
      }
    }
  }, [stopCapture])

  const stopRecording = useCallback(() => {
    stopRecordingForSession(sessionRef.current)
  }, [stopRecordingForSession])

  const cancelRecording = useCallback(() => {
    sessionRef.current++
    asrDoneResolveRef.current?.()
    asrDoneResolveRef.current = null
    teardown()
    setState('idle')
    setDuration(0)
    setErrorMessage(null)
    setErrorKind(null)
    onRecordingEndRef.current?.()
  }, [teardown])

  // error 自动恢复（资源已由 teardown 释放）
  useEffect(() => {
    if (state !== 'error') return
    if (errorKind === 'microphone-permission') return
    const timer = setTimeout(() => {
      setState('idle')
      setErrorMessage(null)
      setErrorKind(null)
      onRecordingEndRef.current?.()
    }, ERROR_RECOVERY_MS)
    return () => clearTimeout(timer)
  }, [state, errorKind])

  // unmount 清理
  useEffect(() => {
    return () => {
      sessionRef.current++
      if (durationTimerRef.current) clearInterval(durationTimerRef.current)
      stopCapture()
      asrClientRef.current?.cleanup()
    }
  }, [stopCapture])

  return useMemo(() => ({
    state,
    audioLevels,
    duration,
    errorMessage,
    errorKind,
    startRecording,
    stopRecording,
    cancelRecording,
  }), [state, audioLevels, duration, errorMessage, errorKind, startRecording, stopRecording, cancelRecording])
}
