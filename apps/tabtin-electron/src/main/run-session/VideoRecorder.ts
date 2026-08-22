/**
 * VideoRecorder — Frame-capture based video recording for browser sessions.
 *
 * Records frames using webContents.capturePage() at configurable FPS,
 * then assembles them into MP4 using FFmpeg.
 *
 * Usage:
 *   const recorder = new VideoRecorder(webContents)
 *   await recorder.start({ fps: 10, outputDir: '/tmp/recording' })
 *   // ... browser actions ...
 *   const videoPath = await recorder.stop()
 */

import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { findFFmpegAsync } from '../utils/ffmpeg'
import { createLogger } from '../logger'

const log = createLogger('VideoRecorder')

const execFileAsync = promisify(execFile)

type WebContents = any

export interface RecordingOptions {
  fps?: number
  outputDir?: string
  maxDurationMs?: number
  onMaxDurationReached?: (videoPath: string | null) => void
}

export interface RecordingStatus {
  recording: boolean
  frameCount: number
  durationMs: number
  fps: number
  outputDir?: string
}

export class VideoRecorder {
  private webContents: WebContents
  private recording = false
  private frameCount = 0
  private startTime = 0
  private fps = 10
  private outputDir = ''
  private captureInterval: ReturnType<typeof setInterval> | null = null
  private maxDurationMs = 5 * 60 * 1000 // 5 minutes default
  private writingFrame = false
  private onMaxDurationReached: ((videoPath: string | null) => void) | null = null

  constructor(webContents: WebContents) {
    this.webContents = webContents
  }

  async start(options?: RecordingOptions): Promise<void> {
    if (this.recording) {
      throw new Error('Already recording')
    }

    this.fps = options?.fps ?? 10
    this.maxDurationMs = options?.maxDurationMs ?? 5 * 60 * 1000
    this.onMaxDurationReached = options?.onMaxDurationReached ?? null
    this.outputDir = options?.outputDir || join(
      app.getPath('temp'),
      `tabtin-recording-${Date.now()}`
    )

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true })
    }

    this.recording = true
    this.frameCount = 0
    this.startTime = Date.now()

    const intervalMs = Math.round(1000 / this.fps)

    this.captureInterval = setInterval(async () => {
      if (!this.recording) return
      if (this.writingFrame) return

      if (Date.now() - this.startTime > this.maxDurationMs) {
        log.warn('达到最大录制时长，自动停止', { maxDurationMs: this.maxDurationMs, frameCount: this.frameCount })
        const videoPath = await this.stop()
        this.onMaxDurationReached?.(videoPath)
        return
      }

      try {
        if (this.webContents.isDestroyed()) {
          await this.stop()
          return
        }
        this.writingFrame = true
        const image = await this.webContents.capturePage()
        const png = image.toPNG()
        const filename = `frame_${String(this.frameCount).padStart(6, '0')}.png`
        await writeFile(join(this.outputDir, filename), png)
        this.frameCount++
      } catch (err) {
        // 单帧捕获失败可恢复：跳过本帧继续下一帧，用 warn 记而不中断录制
        log.warn('单帧捕获失败（跳过本帧）', { frameCount: this.frameCount }, err)
      } finally {
        this.writingFrame = false
      }
    }, intervalMs)

    log.info('开始录制', { fps: this.fps, outputDir: this.outputDir })
  }

  getStatus(): RecordingStatus {
    return {
      recording: this.recording,
      frameCount: this.frameCount,
      durationMs: this.recording ? Date.now() - this.startTime : 0,
      fps: this.fps,
      outputDir: this.recording ? this.outputDir : undefined,
    }
  }

  /**
   * Stop recording and assemble frames into MP4 video.
   * Returns the path to the output video file, or null if FFmpeg is not available.
   */
  async stop(outputPath?: string): Promise<string | null> {
    if (!this.recording) {
      return null
    }

    this.recording = false
    if (this.captureInterval) {
      clearInterval(this.captureInterval)
      this.captureInterval = null
    }

    const duration = Date.now() - this.startTime
    log.info('停止录制', { frameCount: this.frameCount, durationMs: duration })

    if (this.frameCount === 0) {
      return null
    }

    const videoPath = outputPath || join(
      app.getPath('userData'),
      'recordings',
      `recording-${Date.now()}.mp4`
    )

    const videoDir = join(videoPath, '..')
    if (!existsSync(videoDir)) {
      mkdirSync(videoDir, { recursive: true })
    }

    try {
      const ffmpegPath = await this.findFFmpeg()
      if (!ffmpegPath) {
        log.warn('未找到 FFmpeg，帧已保留但未合成视频', { outputDir: this.outputDir, frameCount: this.frameCount })
        return null
      }

      const framePattern = join(this.outputDir, 'frame_%06d.png')

      await execFileAsync(ffmpegPath, [
        '-y',
        '-framerate', String(this.fps),
        '-i', framePattern,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast',
        '-crf', '23',
        videoPath,
      ])

      log.info('视频已合成', { videoPath, frameCount: this.frameCount, fps: this.fps })

      this.cleanupFrames()

      return videoPath
    } catch (err) {
      log.error('FFmpeg 合成视频失败', { outputDir: this.outputDir, frameCount: this.frameCount }, err)
      this.cleanupTempDir()
      return null
    }
  }

  private cleanupFrames(): void {
    try {
      const files = readdirSync(this.outputDir).filter(f => f.endsWith('.png'))
      for (const file of files) {
        unlinkSync(join(this.outputDir, file))
      }
    } catch {
      // best effort cleanup
    }
  }

  private cleanupTempDir(): void {
    try {
      if (this.outputDir && existsSync(this.outputDir)) {
        rmSync(this.outputDir, { recursive: true, force: true })
        log.debug('已清理临时帧目录', { outputDir: this.outputDir })
      }
    } catch {
      // best effort cleanup
    }
  }

  private async findFFmpeg(): Promise<string | null> {
    return findFFmpegAsync()
  }
}

const recorders = new Map<string, VideoRecorder>()
const MAX_RECORDERS = 50

export function getVideoRecorder(tabId: string, webContents: any): VideoRecorder {
  const existing = recorders.get(tabId)
  if (existing) {
    const status = existing.getStatus()
    if (!status.recording) {
      // Stale idle recorder — recreate with fresh webContents
      recorders.delete(tabId)
    } else {
      return existing
    }
  }

  if (recorders.size >= MAX_RECORDERS) {
    // Evict oldest idle recorder to prevent unbounded growth
    for (const [id, recorder] of recorders) {
      if (!recorder.getStatus().recording) {
        recorders.delete(id)
        break
      }
    }
  }

  const recorder = new VideoRecorder(webContents)
  recorders.set(tabId, recorder)
  return recorder
}

export function getExistingVideoRecorder(tabId: string): VideoRecorder | null {
  return recorders.get(tabId) ?? null
}

export function removeVideoRecorder(tabId: string): void {
  recorders.delete(tabId)
}
