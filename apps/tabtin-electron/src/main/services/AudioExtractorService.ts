/**
 * 从视频文件中提取音频轨道。
 * ASR 服务只接受纯音频格式，需要在上传前将视频中的音轨分离出来。
 *
 * 设计：提取 → 读取 → 清理 在 main 进程内闭环完成，
 * renderer 只接收最终的 ArrayBuffer，永远不接触临时文件路径。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { findFFmpegSync } from '../utils/ffmpeg'

const execFileAsync = promisify(execFile)

export interface AudioExtractResult {
  buffer: ArrayBuffer
  format: 'mp3'
  sampleRate: number
  channels: number
}

/**
 * 验证 videoPath 的安全性：
 * - 必须是绝对路径
 * - 不允许 URL 协议（防止 ffmpeg 发起网络请求）
 * - 文件必须实际存在
 */
async function validateVideoPath(videoPath: string): Promise<void> {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('videoPath is required')
  }
  if (videoPath.includes('://')) {
    throw new Error('URL protocols are not allowed, only local file paths')
  }
  if (!videoPath.startsWith('/')) {
    throw new Error('Only absolute file paths are allowed')
  }
  const fileStat = await stat(videoPath)
  if (!fileStat.isFile()) {
    throw new Error('videoPath must point to a regular file')
  }
}

/**
 * 从视频文件提取音频并返回 ArrayBuffer。
 * 临时文件的生命周期完全在此函数内闭环，调用方不接触文件路径。
 *
 * 输出格式：16kHz mono MP3 @ 32kbps。
 * 体积对比：WAV ~115MB/h → MP3 64k ~29MB/h → MP3 32k ~14MB/h。
 * 16kHz 单声道语音在 32kbps 下质量足够，ASR 识别无损失。
 */
export async function extractAudioFromVideo(videoPath: string): Promise<AudioExtractResult> {
  await validateVideoPath(videoPath)

  const ffmpeg = findFFmpegSync()
  const outputPath = join(tmpdir(), `tabtin-audio-${randomUUID()}.mp3`)
  const sampleRate = 16000
  const channels = 1

  try {
    await execFileAsync(ffmpeg, [
      '-i', videoPath,
      '-vn',
      '-acodec', 'libmp3lame',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-b:a', '32k',
      '-y',
      outputPath,
    ], { timeout: 5 * 60 * 1000, maxBuffer: 5 * 1024 * 1024 })

    const buf = await readFile(outputPath)
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

    return { buffer: arrayBuffer, format: 'mp3', sampleRate, channels }
  } finally {
    await unlink(outputPath).catch(() => {})
  }
}
