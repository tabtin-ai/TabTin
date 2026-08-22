/**
 * Speech route handler for CLI Server.
 *
 * 使用共享 `createAudioHandler`：TTS 经 `synthesizeSpeech` 能力链（middleware），
 * ASR / providers / voices 仍代理 Django；含白名单、尾斜杠归一化与统一响应包装。
 *
 *   POST /speech/recognize/       → 同步语音识别
 *   POST /speech/submit/          → 异步提交长音频识别
 *   POST /speech/query/           → 查询异步识别任务
 *   GET  /speech/providers/       → ASR 提供商列表
 *   POST /speech/tts/synthesize/  → TTS 语音合成
 *   GET  /speech/tts/providers/   → TTS 提供商列表
 *   GET  /speech/tts/voices/      → TTS 音色列表
 */

import { createAudioHandler } from '@tabtin/media-capabilities/routes'
import { djangoRequest } from './shared/error-handler'

export const handleSpeechRoute = createAudioHandler({
  djangoRequest,
  logTag: '[CLI Speech]',
})
