#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withPageSession } from '../../../scripts/electron/e2e/resolve-electron-cdp.mjs'

const port = Number(process.argv[2])
const output = process.argv[3]
if (!Number.isInteger(port) || !output) {
  throw new Error('usage: cdp-window-video.mjs <cdp-port> <output.mp4>')
}

const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), `tabtin-e2e-video-${port}-`))
let stopping = false
let lastError = ''
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopping = true })
}

let frame = 0
while (!stopping) {
  const startedAt = Date.now()
  try {
    const result = await withPageSession(
      ({ client, sessionId }) => client.send('Page.captureScreenshot', { format: 'png' }, sessionId),
      { port, commandTimeoutMs: 10_000 },
    )
    const data = result.result?.data
    if (data) {
      fs.writeFileSync(
        path.join(framesDir, `${String(frame++).padStart(6, '0')}.png`),
        Buffer.from(data, 'base64'),
      )
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    // Renderer reloads briefly during auth bootstrap; the next frame resumes.
  }
  const remaining = 250 - (Date.now() - startedAt)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}

if (frame < 2) throw new Error(`only captured ${frame} frames from CDP ${port}: ${lastError}`)
fs.mkdirSync(path.dirname(output), { recursive: true })
const ffmpeg = spawnSync(
  '/opt/homebrew/bin/ffmpeg',
  [
    '-y', '-loglevel', 'error', '-framerate', '4',
    '-i', path.join(framesDir, '%06d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  ],
  { encoding: 'utf8' },
)
fs.rmSync(framesDir, { recursive: true, force: true })
if (ffmpeg.status !== 0) throw new Error(ffmpeg.stderr || `ffmpeg exited ${ffmpeg.status}`)
console.log(output)
