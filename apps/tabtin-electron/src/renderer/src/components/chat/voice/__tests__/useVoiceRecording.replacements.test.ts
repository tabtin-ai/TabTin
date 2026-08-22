/**
 * ：锁住 useVoiceRecording 接线——interim 也必须走 applyReplacements。
 * 仅测 store 不足以防止门闩被改回。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_SHORTCUT,
  useVoiceSettingsStore,
} from '@/stores/useVoiceSettingsStore'

type TranscriptHandler = (text: string, isFinal: boolean) => void

const mocks = vi.hoisted(() => {
  const asrClient = {
    onTranscript: undefined as TranscriptHandler | undefined,
    onError: undefined as ((msg: string) => void) | undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    cleanup: vi.fn(),
    sendAudio: vi.fn(),
  }
  return {
    asrClient,
    startCapture: vi.fn(async () => undefined),
    stopCapture: vi.fn(),
    ensureMicrophonePermission: vi.fn(async () => true),
  }
})

vi.mock('../ASRStreamClient', () => ({
  ASRStreamClient: Object.assign(
    vi.fn(function ASRStreamClientMock() {
      return mocks.asrClient
    }),
    {
      consumePreconnected: vi.fn(() => null),
      cancelPreconnect: vi.fn(),
    },
  ),
  buildDialogContext: vi.fn(() => undefined),
}))

vi.mock('../useAudioCapture', () => ({
  useAudioCapture: () => ({
    startCapture: mocks.startCapture,
    stopCapture: mocks.stopCapture,
  }),
}))

vi.mock('../voiceMicrophonePermission', () => ({
  ensureMicrophonePermission: mocks.ensureMicrophonePermission,
  getMicrophonePermissionMessage: vi.fn(() => 'mic denied'),
  isMicrophonePermissionError: vi.fn(() => false),
  MicrophonePermissionError: class MicrophonePermissionError extends Error {},
}))

vi.mock('../extractAppHotwords', () => ({
  extractAppHotwords: vi.fn(() => []),
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => ({ addListener: vi.fn(), removeListener: vi.fn() }),
  }),
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      getEffectiveOrganizationId: () => 'org-5794',
    }),
  },
}))

function resetVoiceStore() {
  useVoiceSettingsStore.setState({
    enabled: true,
    enableAppContext: true,
    enableDialogContext: false,
    customHotwords: [],
    replacementRules: [],
    voiceShortcut: DEFAULT_VOICE_SHORTCUT,
  })
}

describe('useVoiceRecording replacement wiring ', () => {
  beforeEach(() => {
    resetVoiceStore()
    mocks.asrClient.onTranscript = undefined
    mocks.asrClient.onError = undefined
    mocks.asrClient.start.mockClear()
    mocks.asrClient.stop.mockClear()
    mocks.asrClient.cleanup.mockClear()
    mocks.asrClient.sendAudio.mockClear()
    mocks.startCapture.mockClear()
    mocks.stopCapture.mockClear()
    mocks.ensureMicrophonePermission.mockClear()
    mocks.ensureMicrophonePermission.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('applies replacement rules on interim and final transcripts', async () => {
    useVoiceSettingsStore.getState().addReplacementRule('嗯', '')
    const onTranscript = vi.fn()
    const { useVoiceRecording } = await import('../useVoiceRecording')
    const { result } = renderHook(() => useVoiceRecording({ onTranscript }))

    await act(async () => {
      result.current.startRecording()
    })

    await waitFor(() => {
      expect(result.current.state).toBe('recording')
      expect(mocks.asrClient.onTranscript).toEqual(expect.any(Function))
    })

    act(() => {
      mocks.asrClient.onTranscript?.('嗯好的', false)
    })
    expect(onTranscript).toHaveBeenCalledWith('好的', false)

    act(() => {
      mocks.asrClient.onTranscript?.('嗯好的呀', true)
    })
    expect(onTranscript).toHaveBeenCalledWith('好的呀', true)
  })

  it('keeps corrected interim after cancel (send-while-recording path)', async () => {
    useVoiceSettingsStore.getState().addReplacementRule('嗯', '')
    const onTranscript = vi.fn()
    const { useVoiceRecording } = await import('../useVoiceRecording')
    const { result } = renderHook(() => useVoiceRecording({ onTranscript }))

    await act(async () => {
      result.current.startRecording()
    })
    await waitFor(() => expect(result.current.state).toBe('recording'))

    act(() => {
      mocks.asrClient.onTranscript?.('嗯好的', false)
    })
    expect(onTranscript).toHaveBeenLastCalledWith('好的', false)

    act(() => {
      result.current.cancelRecording()
    })
    expect(result.current.state).toBe('idle')
    expect(onTranscript).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledWith('好的', false)
  })
})
