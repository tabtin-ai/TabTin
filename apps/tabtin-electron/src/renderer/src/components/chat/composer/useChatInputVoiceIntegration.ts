import { useRef, useCallback, useEffect } from 'react'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useVoiceSettingsStore, matchesShortcut } from '@/stores/useVoiceSettingsStore'
import { getChatClient } from '@/services/chatApi'
import { ASRStreamClient, buildDialogContext } from '../voice/ASRStreamClient'
import { extractAppHotwords } from '../voice/extractAppHotwords'
import { useVoiceRecording } from '../voice/useVoiceRecording'
import { useMicrophonePermissionGate } from '../voice/useMicrophonePermissionGate'

interface VoiceIntegrationParams {
  chatMessages: Array<{ role: string; content: string }>
  setInput: (value: string | ((prev: string) => string)) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  input: string
  acceptGlobalInputEvents: boolean
  disabled: boolean
  wsDisconnected: boolean
}

export function useChatInputVoiceIntegration({
  chatMessages,
  setInput,
  textareaRef,
  input,
  acceptGlobalInputEvents,
  disabled,
  wsDisconnected,
}: VoiceIntegrationParams) {
  const voiceDraftStartRef = useRef<number>(-1)

  const handleVoiceTranscript = useCallback((text: string, isFinal: boolean) => {
    const start = voiceDraftStartRef.current
    setInput(prev => {
      if (start < 0) {
        voiceDraftStartRef.current = prev.length
        return prev + text
      }
      return prev.slice(0, start) + text
    })
    if (isFinal) {
      voiceDraftStartRef.current = -1
    }
    queueMicrotask(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 260) + 'px'
      }
    })
  }, [setInput, textareaRef])

  const handleRecordingEnd = useCallback(() => {
    voiceDraftStartRef.current = -1
    queueMicrotask(() => textareaRef.current?.focus())
  }, [textareaRef])

  const voice = useVoiceRecording({
    messages: chatMessages,
    onTranscript: handleVoiceTranscript,
    onRecordingEnd: handleRecordingEnd,
  })

  const { state: voiceState, startRecording: voiceStart, cancelRecording: voiceCancel } = voice
  const isVoiceActive = voiceState !== 'idle'

  const stopVoiceForSubmit = useCallback(() => {
    if (!isVoiceActive) return
    voiceDraftStartRef.current = -1
    voiceCancel()
  }, [isVoiceActive, voiceCancel])

  const handleMicPreconnect = useCallback(() => {
    if (isVoiceActive) return
    const gateway = getChatClient().getGateway()
    const organizationId = useOrganizationStore.getState().getEffectiveOrganizationId() ?? undefined
    const vs = useVoiceSettingsStore.getState()
    const appHotwords = extractAppHotwords()
    const hotwords = vs.mergedHotwords(appHotwords)
    const context = vs.enableDialogContext
      ? buildDialogContext(chatMessages)
      : undefined
    void ASRStreamClient.preconnect(gateway, { hotwords, context }, organizationId)
  }, [isVoiceActive, chatMessages])

  const handleMicClick = useCallback(() => {
    if (isVoiceActive) return
    voiceDraftStartRef.current = input.length
    voiceStart()
  }, [isVoiceActive, input.length, voiceStart])

  const voiceShortcut = useVoiceSettingsStore(s => s.voiceShortcut)
  const voiceEnabled = useVoiceSettingsStore(s => s.enabled)
  const micGate = useMicrophonePermissionGate(voiceEnabled)
  const micBlocked = micGate.isDenied || micGate.isUnsupported

  const inputLengthRef = useRef(input.length)
  inputLengthRef.current = input.length

  useEffect(() => {
    if (!acceptGlobalInputEvents) return
    if (!voiceEnabled) return
    const handleVoiceShortcut = (e: globalThis.KeyboardEvent) => {
      if (matchesShortcut(e, voiceShortcut)) {
        if (!disabled && !wsDisconnected && !isVoiceActive && !micBlocked) {
          e.preventDefault()
          voiceDraftStartRef.current = inputLengthRef.current
          voiceStart()
        }
      }
    }
    window.addEventListener('keydown', handleVoiceShortcut)
    return () => window.removeEventListener('keydown', handleVoiceShortcut)
  }, [acceptGlobalInputEvents, disabled, wsDisconnected, isVoiceActive, voiceShortcut, voiceStart, voiceEnabled, micBlocked])

  return {
    voice,
    voiceState,
    isVoiceActive,
    stopVoiceForSubmit,
    handleMicPreconnect,
    handleMicClick,
    voiceShortcut,
    voiceEnabled,
    micGate,
  }
}
