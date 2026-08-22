/**
 * Web Audio API 音频采集 Hook
 *
 * 优先使用 AudioWorkletNode，不可用时自动降级到 ScriptProcessorNode。
 * 自动重采样为 PCM 16-bit mono 16kHz，每 ~200ms 输出一个 chunk。
 */

import { useRef, useCallback } from 'react'

const TARGET_SAMPLE_RATE = 16000
const CHUNK_DURATION_S = 0.2

export interface AudioCaptureCallbacks {
  onChunk: (pcmData: ArrayBuffer) => void
  onLevel: (level: number) => void
}

// ---- AudioWorklet processor (inline source) ----

const WORKLET_PROCESSOR_NAME = 'pcm-chunk-processor'

function buildWorkletSource(): string {
  return `
class PcmChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { targetSampleRate, chunkDurationS } = options.processorOptions || {}
    this._targetRate = targetSampleRate || 16000
    this._chunkDuration = chunkDurationS || 0.2
    this._buffer = []
    this._samplesNeeded = Math.round(this._targetRate * this._chunkDuration)
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    const channelData = input[0]
    const nativeSampleRate = sampleRate

    let samples
    if (Math.abs(nativeSampleRate - this._targetRate) < 1) {
      samples = channelData
    } else {
      samples = this._resample(channelData, nativeSampleRate, this._targetRate)
    }

    for (let i = 0; i < samples.length; i++) {
      this._buffer.push(samples[i])
    }

    while (this._buffer.length >= this._samplesNeeded) {
      const chunk = this._buffer.splice(0, this._samplesNeeded)
      const float32 = new Float32Array(chunk)

      let rms = 0
      for (let i = 0; i < float32.length; i++) {
        rms += float32[i] * float32[i]
      }
      rms = Math.sqrt(rms / float32.length)
      const level = Math.min(1, rms * 5)

      const pcm16 = new Int16Array(float32.length)
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]))
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }

      this.port.postMessage({ type: 'chunk', pcm: pcm16.buffer, level }, [pcm16.buffer])
    }

    return true
  }

  _resample(input, fromRate, toRate) {
    const ratio = fromRate / toRate
    const outLength = Math.round(input.length / ratio)
    const out = new Float32Array(outLength)
    for (let i = 0; i < outLength; i++) {
      const srcIdx = i * ratio
      const lo = Math.floor(srcIdx)
      const hi = Math.min(lo + 1, input.length - 1)
      const frac = srcIdx - lo
      out[i] = input[lo] * (1 - frac) + input[hi] * frac
    }
    return out
  }
}

registerProcessor('${WORKLET_PROCESSOR_NAME}', PcmChunkProcessor)
`
}

let workletBlobUrl: string | null = null

function getWorkletBlobUrl(): string {
  if (!workletBlobUrl) {
    const blob = new Blob([buildWorkletSource()], { type: 'application/javascript' })
    workletBlobUrl = URL.createObjectURL(blob)
  }
  return workletBlobUrl
}

// ---- Shared helpers ----

function float32ToPcm16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  return pcm16
}

function nearestPowerOfTwo(n: number): number {
  const powers = [256, 512, 1024, 2048, 4096, 8192, 16384]
  for (const p of powers) {
    if (p >= n) return p
  }
  return 16384
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate
  const outLength = Math.round(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio
    const lo = Math.floor(srcIdx)
    const hi = Math.min(lo + 1, input.length - 1)
    const frac = srcIdx - lo
    out[i] = input[lo] * (1 - frac) + input[hi] * frac
  }
  return out
}

function supportsAudioWorklet(ctx: AudioContext): boolean {
  return typeof ctx.audioWorklet?.addModule === 'function'
}

// ---- Hook ----

export function useAudioCapture() {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

  const startCapture = useCallback(async (callbacks: AudioCaptureCallbacks) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: TARGET_SAMPLE_RATE },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    streamRef.current = stream

    const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    contextRef.current = audioContext

    const source = audioContext.createMediaStreamSource(stream)
    sourceRef.current = source

    if (supportsAudioWorklet(audioContext)) {
      try {
        await startWithWorklet(audioContext, source, callbacks)
      } catch (workletErr) {
        console.warn('[AudioCapture] AudioWorklet failed (likely CSP), falling back to ScriptProcessorNode:', workletErr)
        startWithScriptProcessor(audioContext, source, callbacks)
      }
    } else {
      console.warn('[AudioCapture] AudioWorklet not available, falling back to ScriptProcessorNode')
      startWithScriptProcessor(audioContext, source, callbacks)
    }

    const actualRate = audioContext.sampleRate
    if (Math.abs(actualRate - TARGET_SAMPLE_RATE) > 1) {
      console.info(
        `[AudioCapture] Device sample rate ${actualRate}Hz ≠ target ${TARGET_SAMPLE_RATE}Hz, resampling active`,
      )
    }
  }, [])

  const startWithWorklet = async (
    audioContext: AudioContext,
    source: MediaStreamAudioSourceNode,
    callbacks: AudioCaptureCallbacks,
  ) => {
    await audioContext.audioWorklet.addModule(getWorkletBlobUrl())

    const workletNode = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
      processorOptions: {
        targetSampleRate: TARGET_SAMPLE_RATE,
        chunkDurationS: CHUNK_DURATION_S,
      },
      channelCount: 1,
      numberOfInputs: 1,
      numberOfOutputs: 1,
    })
    workletNodeRef.current = workletNode

    workletNode.port.onmessage = (event) => {
      const { type, pcm, level } = event.data
      if (type === 'chunk') {
        callbacks.onLevel(level)
        callbacks.onChunk(pcm)
      }
    }

    source.connect(workletNode)
    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    workletNode.connect(silentGain)
    silentGain.connect(audioContext.destination)
  }

  const startWithScriptProcessor = (
    audioContext: AudioContext,
    source: MediaStreamAudioSourceNode,
    callbacks: AudioCaptureCallbacks,
  ) => {
    const actualRate = audioContext.sampleRate
    const needsResample = Math.abs(actualRate - TARGET_SAMPLE_RATE) > 1

    const bufferSize = Math.round(actualRate * CHUNK_DURATION_S)
    const roundedBufferSize = nearestPowerOfTwo(bufferSize)
    const processor = audioContext.createScriptProcessor(roundedBufferSize, 1, 1)
    processorRef.current = processor

    let residualBuffer: number[] = []
    const targetChunkSamples = Math.round(TARGET_SAMPLE_RATE * CHUNK_DURATION_S)

    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0)

      let rms = 0
      for (let i = 0; i < inputData.length; i++) {
        rms += inputData[i] * inputData[i]
      }
      rms = Math.sqrt(rms / inputData.length)
      const level = Math.min(1, rms * 5)
      callbacks.onLevel(level)

      let samples: Float32Array
      if (needsResample) {
        samples = resampleLinear(inputData, actualRate, TARGET_SAMPLE_RATE)
      } else {
        samples = inputData
      }

      for (let i = 0; i < samples.length; i++) {
        residualBuffer.push(samples[i])
      }

      while (residualBuffer.length >= targetChunkSamples) {
        const chunk = new Float32Array(residualBuffer.splice(0, targetChunkSamples))
        const pcm16 = float32ToPcm16(chunk)
        const pcmCopy = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
        callbacks.onChunk(pcmCopy.slice().buffer)
      }
    }

    source.connect(processor)
    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    processor.connect(silentGain)
    silentGain.connect(audioContext.destination)
  }

  const stopCapture = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null
      workletNodeRef.current.disconnect()
      workletNodeRef.current = null
    }
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current.onaudioprocess = null
      processorRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (contextRef.current) {
      contextRef.current.close().catch(() => {})
      contextRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
  }, [])

  return { startCapture, stopCapture }
}
