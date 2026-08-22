import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { PtyHostCommand, PtyHostEvent } from './PtyHostProtocol'

let ptyProcess: IPty | null = null
let outputPaused = false
const bufferedOutput: string[] = []
let bufferedOutputBytes = 0
const bufferedInput: string[] = []
let ptyReadPaused = false
let inputFlushScheduled = false
let exitSent = false

const BUFFER_HIGH_WATERMARK_BYTES = 128 * 1024
const BUFFER_LOW_WATERMARK_BYTES = 32 * 1024
const WRITE_CHUNK_MAX_CHARS = 1024
const WRITE_CHUNK_FLUSH_DELAY_MS = 1

type ParentPortLike = {
  postMessage(message: PtyHostEvent): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

const parentPort = (process as NodeJS.Process & {
  parentPort?: ParentPortLike | null
}).parentPort ?? null

const sendToParent = (event: PtyHostEvent): void => {
  if (parentPort) {
    parentPort.postMessage(event)
    return
  }
  if (typeof process.send === 'function') {
    process.send(event)
  }
}

const takeWriteChunk = (value: string): string => {
  if (value.length <= WRITE_CHUNK_MAX_CHARS) {
    return value
  }

  let end = WRITE_CHUNK_MAX_CHARS
  const lastCharCode = value.charCodeAt(end - 1)
  if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
    end -= 1
  }
  return value.slice(0, Math.max(1, end))
}

const flushBufferedInput = (): void => {
  inputFlushScheduled = false

  if (!ptyProcess || outputPaused || ptyReadPaused) {
    return
  }

  while (bufferedInput.length > 0) {
    if (!ptyProcess || outputPaused || ptyReadPaused) {
      break
    }

    const next = bufferedInput[0]
    const chunk = takeWriteChunk(next)
    ptyProcess.write(chunk)

    if (chunk.length === next.length) {
      bufferedInput.shift()
    } else {
      bufferedInput[0] = next.slice(chunk.length)
    }

    if (bufferedInput.length > 0) {
      scheduleBufferedInputFlush(WRITE_CHUNK_FLUSH_DELAY_MS)
      return
    }
  }
}

const scheduleBufferedInputFlush = (delayMs = 0): void => {
  if (inputFlushScheduled) {
    return
  }

  inputFlushScheduled = true
  if (delayMs > 0) {
    setTimeout(flushBufferedInput, delayMs)
    return
  }
  setImmediate(flushBufferedInput)
}

const syncPtyReadBackpressure = (): void => {
  if (!ptyProcess) {
    return
  }

  if (outputPaused) {
    if (!ptyReadPaused && bufferedOutputBytes >= BUFFER_HIGH_WATERMARK_BYTES) {
      ptyProcess.pause()
      ptyReadPaused = true
    }
    return
  }

  if (ptyReadPaused && bufferedOutputBytes <= BUFFER_LOW_WATERMARK_BYTES) {
    ptyProcess.resume()
    ptyReadPaused = false
    scheduleBufferedInputFlush()
  }
}

const flushBufferedOutput = (): void => {
  if (outputPaused || bufferedOutput.length === 0) {
    return
  }

  for (const chunk of bufferedOutput.splice(0, bufferedOutput.length)) {
    bufferedOutputBytes = Math.max(0, bufferedOutputBytes - Buffer.byteLength(chunk, 'utf8'))
    sendToParent({ kind: 'data', data: chunk })
  }

  syncPtyReadBackpressure()
}

const emitExitOnce = (exitCode: number | null, signal?: number): void => {
  if (exitSent) {
    return
  }
  exitSent = true
  sendToParent({ kind: 'exit', exitCode, signal })
}

const handleCommand = (message: PtyHostCommand): void => {
  switch (message.kind) {
    case 'spawn': {
      if (ptyProcess) {
        sendToParent({ kind: 'error', message: 'PTY host process already spawned a session' })
        return
      }

      try {
        ptyProcess = pty.spawn(message.request.shell, [], {
          name: message.request.termName ?? 'xterm-256color',
          cols: message.request.cols,
          rows: message.request.rows,
          cwd: message.request.cwd,
          env: message.request.env,
        })

        ptyProcess.onData((data: string) => {
          if (outputPaused) {
            bufferedOutput.push(data)
            bufferedOutputBytes += Buffer.byteLength(data, 'utf8')
            syncPtyReadBackpressure()
            return
          }
          sendToParent({ kind: 'data', data })
        })

        ptyProcess.onExit(({ exitCode, signal }) => {
          outputPaused = false
          flushBufferedOutput()
          emitExitOnce(exitCode ?? null, signal)
          process.exitCode = exitCode ?? 0
          setImmediate(() => process.exit(process.exitCode ?? 0))
        })

        sendToParent({ kind: 'spawned', pid: ptyProcess.pid })
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        sendToParent({ kind: 'error', message: `Failed to spawn PTY host session: ${messageText}` })
        emitExitOnce(1)
        process.exit(1)
      }
      return
    }
    case 'write':
      if (!ptyProcess) {
        return
      }
      bufferedInput.push(message.data)
      scheduleBufferedInputFlush()
      return
    case 'resize':
      ptyProcess?.resize(message.cols, message.rows)
      return
    case 'kill':
      ptyProcess?.kill(message.signal)
      return
    case 'pause-output':
      outputPaused = true
      syncPtyReadBackpressure()
      return
    case 'resume-output':
      outputPaused = false
      flushBufferedOutput()
      syncPtyReadBackpressure()
      scheduleBufferedInputFlush()
      return
  }
}

if (parentPort) {
  parentPort.on('message', (event) => {
    handleCommand(event.data as PtyHostCommand)
  })
} else {
  process.on('message', (message: PtyHostCommand) => {
    handleCommand(message)
  })
}

process.on('disconnect', () => {
  if (ptyProcess) {
    try {
      ptyProcess.kill('SIGKILL')
    } catch {
      // ignore disconnect cleanup failures
    }
  }
})

process.on('uncaughtException', (error) => {
  sendToParent({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
  emitExitOnce(1)
  process.exit(1)
})

sendToParent({ kind: 'ready' })
