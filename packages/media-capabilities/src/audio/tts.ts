import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface SynthesizeSpeechInput {
  text: string;
  speaker?: string;
  language?: string;
  format?: 'wav' | 'mp3' | 'pcm';
  organizationId?: string;
}

export interface SynthesizeSpeechData {
  audioUrl?: string;
  audioPath?: string;
  durationSec: number;
  wordTimestamps?: Array<{
    word: string;
    startMs: number;
    endMs: number;
  }>;
}

/**
 * Text-to-speech synthesis via Django speech.tts API.
 *
 * Django 返回格式：{ success, data: { audioData (base64), duration, sentences, ... } }
 * audioData 是 PCM/WAV 的 base64 编码。本函数解码后写入临时 WAV 文件。
 */
export async function synthesizeSpeech(
  input: SynthesizeSpeechInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<SynthesizeSpeechData>> {
  const startTime = Date.now();

  const response = await ctx.djangoRequest('POST', '/api/services/speech/tts/synthesize/', {
    text: input.text,
    speaker: input.speaker ?? 'zh_female_vv_uranus_bigtts',
    language: input.language,
    format: 'pcm',
    sample_rate: 24000,
    enable_timestamp: true,
    provider: 'bytedance',
    mode: 'http',
    organization_id: input.organizationId ?? '',
  }, { timeout: 60_000 });

  if (response.status >= 400) {
    throw new Error(`TTS synthesis failed: HTTP ${response.status}`);
  }

  const result = (response.data as any)?.data ?? response.data;
  if (!result?.audioData) {
    throw new Error('TTS response missing audioData');
  }

  const pcmBytes = Buffer.from(result.audioData, 'base64');
  const wavPath = join(tmpdir(), `tts-${randomUUID()}.wav`);
  pcmToWav(pcmBytes, wavPath, 24000);

  const durationSec = typeof result.duration === 'number'
    ? result.duration
    : pcmBytes.length / (24000 * 2);

  const wordTimestamps: SynthesizeSpeechData['wordTimestamps'] = [];
  if (result.sentences) {
    for (const sentence of result.sentences) {
      if (sentence.words) {
        for (const w of sentence.words) {
          wordTimestamps.push({
            word: w.text ?? '',
            startMs: Math.round((w.startTime ?? 0) * 1000),
            endMs: Math.round((w.endTime ?? 0) * 1000),
          });
        }
      }
    }
  }

  return {
    localPath: wavPath,
    data: {
      audioPath: wavPath,
      durationSec,
      wordTimestamps: wordTimestamps.length > 0 ? wordTimestamps : undefined,
    },
    mimeType: 'audio/wav',
    provenance: createProvenance('audio.tts', { ...input }, startTime, {
      prompt: input.text,
    }),
    providerMetadata: {
      bytedance: { provider: result.provider, mode: result.mode },
    },
  };
}

function pcmToWav(pcmData: Buffer, outputPath: string, sampleRate: number): void {
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  writeFileSync(outputPath, Buffer.concat([header, pcmData]));
}
